const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const fs = require("fs");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { Storage } = require("@google-cloud/storage");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const { OpenAI } = require("openai");
const twilio = require("twilio");

const app = express();
const server = http.createServer(app);

// Firebase初期化
let db, bucket, ttsClient, openai;

function getOpenAIApiKey() {
  // Cloud Run Secret/環境変数に末尾改行が混入することがあり、
  // Node.js の http(s) ヘッダにそのまま入れると
  // "Invalid character in header content [\"Authorization\"]" で落ちる。
  // 念のため、前後だけでなく「キー中の改行/空白」も除去してヘッダに載せられる形にする。
  return (process.env.OPENAI_API_KEY || "").replace(/\s+/g, "");
}

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (Object.keys(serviceAccount).length > 0) {
    initializeApp({
      credential: cert(serviceAccount),
    });
    console.log("Firebase initialized with service account");
  } else {
    initializeApp();
    console.log("Firebase initialized with default credentials");
  }
  
  db = getFirestore();
  const storage = new Storage();
  bucket = storage.bucket(process.env.AUDIO_BUCKET || "owldial-tts");
  ttsClient = new TextToSpeechClient();
  openai = new OpenAI({ apiKey: getOpenAIApiKey() });
  
  console.log("Firebase services initialized successfully");
  console.log(`Bucket name: ${process.env.AUDIO_BUCKET || "owldial-tts"}`);
  console.log(`Bucket object: ${bucket ? 'initialized' : 'not initialized'}`);
  console.log(`TTS client: ${ttsClient ? 'initialized' : 'not initialized'}`);
} catch (error) {
  console.error("Firebase initialization error:", error);
  // エラーが発生しても続行（Cloud Runではデフォルト認証情報が使用される）
  try {
    initializeApp();
    db = getFirestore();
    const storage = new Storage();
    bucket = storage.bucket(process.env.AUDIO_BUCKET || "owldial-tts");
    ttsClient = new TextToSpeechClient();
    openai = new OpenAI({ apiKey: getOpenAIApiKey() });
    console.log("Firebase initialized with fallback");
  } catch (fallbackError) {
    console.error("Firebase fallback initialization error:", fallbackError);
    // エラーが発生しても続行（後でエラーハンドリングで対処）
    // 最低限の初期化を試みる
    try {
      if (!ttsClient) {
        ttsClient = new TextToSpeechClient();
        console.log("TTS client initialized in fallback");
      }
    } catch (ttsError) {
      console.error("TTS client initialization error:", ttsError);
    }
  }
}

const activeSessions = new Map();

// 初期挨拶音声のメモリキャッシュ（Cloud Runインスタンス内）
// key: `${ttsEngine}:${ttsVoice}:${speed}`
const preGeneratedAudioCache = new Map();

// 相槌音声のメモリキャッシュ（Cloud Runインスタンス内）
// key: `${ttsEngine}:${ttsVoice}:${speed}`
const fillerAudioCache = new Map();
const FILLER_VERSION = process.env.FILLER_VERSION || "v3";

// 相槌（待ち）固定テキスト
const FILLER_TEXT_THINKING = "はい、ありがとうございます。AIが思考中ですので少々お待ちください";

// 目的（伝言など）を引き出せたら、この定型文でクロージングに誘導
const CLOSING_TEXT = "他にご用件はありますか？特になければ、このままお電話をお切りください。";

function detectNoMoreRequests(text) {
  const t = (text || "").trim();
  if (!t) return false;
  const noPhrases = ["特にない", "特にありません", "ないです", "ありません", "大丈夫", "結構です", "以上です", "それだけ", "ないですね"];
  return noPhrases.some(p => t.includes(p));
}

async function classifyUserTurnWithAI(session, userMessage) {
  // 目的: 単語ベースでなく「AIが対応可能か？」で分岐する
  // - connect/transfer 等は不可 → 伝言を促す
  // - 伝言/折返し先など目的情報が取れた → クロージングへ
  // - クロージング後に「特にない」 → 終話
  const payload = {
    closingAsked: Boolean(session?._closingAsked),
    userMessage: (userMessage || "").trim(),
  };
  try {
    const resp = await openai.chat.completions.create({
      model: process.env.CLASSIFIER_MODEL || "gpt-4o-mini",
      temperature: 0,
      max_tokens: 140,
      messages: [
        {
          role: "system",
          content:
            "あなたは電話応対AIの『意図分類器』です。必ずJSONのみを返してください。文章は一切書かないでください。" +
            "次のactionから1つだけ選びます: " +
            "\"normal\" | \"take_message\" | \"closing\" | \"farewell\". " +
            "判断基準: " +
            "1) 人に繋ぐ/取り次ぎ/担当者に代わる/転送 等はAIは対応不可なので action=take_message。 " +
            "2) 伝言内容や折返し先(電話番号/メール)など必要情報が十分に取れたら action=closing。 " +
            "3) closingAsked=true の後に『特にない/以上』等なら action=farewell。 " +
            "それ以外は action=normal。 " +
            "返却JSON形式: {\"action\":\"...\",\"reason\":\"...\"}",
        },
        { role: "user", content: JSON.stringify(payload) },
      ],
    });
    const txt = (resp.choices?.[0]?.message?.content || "").trim();
    const obj = JSON.parse(txt);
    const action = obj?.action;
    if (action === "normal" || action === "take_message" || action === "closing" || action === "farewell") {
      return { action, reason: String(obj?.reason || "") };
    }
    return { action: "normal", reason: "invalid_action" };
  } catch (e) {
    console.warn(`[FLOW] classifier_failed call=${session?.callSid || "unknown"} err=${e.message}`);
    return { action: "normal", reason: "classifier_error" };
  }
}

function getMergeWindowMs(session) {
  // 相槌中に話し出した場合など、直前発話の“続き”として音声を結合するための猶予
  // 短すぎると連結されず、長すぎると応答が遅くなるので環境変数で調整可能にする
  const base = Number(process.env.MERGE_WINDOW_MS || "1200");
  // 相槌/AI音声再生中は、少し長めにして“割り込み”を拾いやすくする
  if (session && session.isSendingAudio) {
    return Number(process.env.MERGE_WINDOW_MS_WHILE_PLAYING || String(base));
  }
  return base;
}

function queueOrMergeIncomingSegment(session, combinedAudio) {
  if (!session) return;
  if (!combinedAudio || !combinedAudio.length) return;

  session._pendingUserSegments = session._pendingUserSegments || [];
  session._pendingUserSegments.push(combinedAudio);
  session._pendingLastSegmentAt = Date.now();

  // 既存のタイマーがあれば延長（＝連結）
  if (session._pendingProcessTimer) {
    clearTimeout(session._pendingProcessTimer);
    session._pendingProcessTimer = null;
  }

  const waitMs = getMergeWindowMs(session);
  session._pendingProcessTimer = setTimeout(async () => {
    const segs = session._pendingUserSegments || [];
    session._pendingUserSegments = [];
    session._pendingProcessTimer = null;

    const merged = (segs.length === 1) ? segs[0] : Buffer.concat(segs);
    console.log(`[MERGE] processing merged segment call=${session.callSid || "unknown"} parts=${segs.length} bytes=${merged.length} waitMs=${waitMs}`);
    await processIncomingAudio(session, merged);
  }, waitMs);
}

async function generateFillerMulawBuffer(callSid, ttsEngine, ttsVoice, speed) {
  // 返答生成と独立して、相槌用の短文をTTS→mu-lawに変換する
  const text = FILLER_TEXT_THINKING;
  const t0 = Date.now();

  let mp3Buffer;
  if (ttsEngine === "openai") {
    const validOpenAIVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
    const finalVoice = validOpenAIVoices.includes(ttsVoice) ? ttsVoice : "echo";
    console.log(`[FILLER] Generating OpenAI TTS filler call=${callSid} voice=${finalVoice} speed=${speed}`);
    const resp = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts-2025-12-15",
      voice: finalVoice,
      input: text,
      speed: speed,
    });
    const arrayBuffer = await resp.arrayBuffer();
    mp3Buffer = Buffer.from(arrayBuffer);
  } else {
    const validVoices = [
      "ja-JP-Wavenet-A", "ja-JP-Wavenet-B", "ja-JP-Wavenet-C", "ja-JP-Wavenet-D",
      "ja-JP-Standard-A", "ja-JP-Standard-B", "ja-JP-Standard-C", "ja-JP-Standard-D"
    ];
    const finalVoice = validVoices.includes(ttsVoice) ? ttsVoice : "ja-JP-Wavenet-A";
    console.log(`[FILLER] Generating Google TTS filler call=${callSid} voice=${finalVoice} speed=${speed}`);
    const [resp] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: "ja-JP", name: finalVoice },
      audioConfig: { audioEncoding: "MP3", speakingRate: speed, pitch: 0.0 },
    });
    mp3Buffer = Buffer.from(resp.audioContent || "");
  }

  const mulaw = await convertMp3ToMulaw(mp3Buffer);
  console.log(`[FILLER] filler ulaw generated call=${callSid} bytes=${mulaw.length} total=${Date.now() - t0}ms`);
  return mulaw;
}

async function savePreGeneratedFillerAudio(audioBuffer, ttsEngine, ttsVoice, speed) {
  try {
    const fileName = `filler-aizuchi-${FILLER_VERSION}-${ttsEngine}-${ttsVoice}-${speed}.ulaw`;
    const file = bucket.file(fileName);
    await file.save(audioBuffer, {
      contentType: "audio/basic",
      metadata: { cacheControl: "public, max-age=31536000" },
    });
    fillerAudioCache.set(getFillerCacheKey(ttsEngine, ttsVoice, speed), { buffer: audioBuffer, loadedAt: Date.now(), fileName });
    console.log(`[FILLER] Saved pre-generated filler audio: ${fileName}`);
  } catch (e) {
    console.error(`[FILLER] Error saving pre-generated filler audio: ${e.message}`);
  }
}

function getGreetingCacheKey(ttsEngine, ttsVoice, speed) {
  return `${ttsEngine}:${ttsVoice}:${speed}`;
}

async function primePreGeneratedInitialAudioCache(ttsEngine, ttsVoice, speed) {
  const key = getGreetingCacheKey(ttsEngine, ttsVoice, speed);
  if (preGeneratedAudioCache.has(key)) return;

  try {
    const fileName = `initial-greeting-${ttsEngine}-${ttsVoice}-${speed}.ulaw`;
    const file = bucket.file(fileName);
    const [exists] = await file.exists();
    if (!exists) {
      console.log(`[PRE-AUDIO] Prime skipped (not found): ${fileName}`);
      return;
    }
    const [buffer] = await file.download();
    preGeneratedAudioCache.set(key, { buffer, loadedAt: Date.now(), fileName });
    console.log(`[PRE-AUDIO] Primed cache: ${fileName}, bytes=${buffer.length}`);
  } catch (error) {
    console.error(`[PRE-AUDIO] Prime failed: ${error.message}`);
  }
}

function getCachedPreGeneratedInitialAudio(ttsEngine, ttsVoice, speed) {
  const key = getGreetingCacheKey(ttsEngine, ttsVoice, speed);
  const cached = preGeneratedAudioCache.get(key);
  if (cached && cached.buffer && cached.buffer.length > 0) {
    console.log(`[PRE-AUDIO] Cache hit: ${cached.fileName}, bytes=${cached.buffer.length}`);
    return cached.buffer;
  }
  console.log(`[PRE-AUDIO] Cache miss: initial-greeting-${ttsEngine}-${ttsVoice}-${speed}.ulaw`);
  return null;
}

function getFillerCacheKey(ttsEngine, ttsVoice, speed) {
  return `${FILLER_VERSION}:${ttsEngine}:${ttsVoice}:${speed}`;
}

async function primePreGeneratedFillerAudioCache(ttsEngine, ttsVoice, speed) {
  const key = getFillerCacheKey(ttsEngine, ttsVoice, speed);
  if (fillerAudioCache.has(key)) return;

  try {
    const fileName = `filler-aizuchi-${FILLER_VERSION}-${ttsEngine}-${ttsVoice}-${speed}.ulaw`;
    const file = bucket.file(fileName);
    const [exists] = await file.exists();
    if (!exists) {
      console.log(`[FILLER] Prime skipped (not found): ${fileName}`);
      return;
    }
    const [buffer] = await file.download();
    fillerAudioCache.set(key, { buffer, loadedAt: Date.now(), fileName });
    console.log(`[FILLER] Primed cache: ${fileName}, bytes=${buffer.length}`);
  } catch (error) {
    console.error(`[FILLER] Prime failed: ${error.message}`);
  }
}

async function loadPreGeneratedFillerAudio(ttsEngine, ttsVoice, speed) {
  try {
    const fileName = `filler-aizuchi-${FILLER_VERSION}-${ttsEngine}-${ttsVoice}-${speed}.ulaw`;
    const file = bucket.file(fileName);
    const [exists] = await file.exists();
    if (!exists) {
      console.log(`[FILLER] Pre-generated filler not found: ${fileName}`);
      return null;
    }
    console.log(`[FILLER] Loading pre-generated filler audio: ${fileName}`);
    const [buffer] = await file.download();
    fillerAudioCache.set(getFillerCacheKey(ttsEngine, ttsVoice, speed), { buffer, loadedAt: Date.now(), fileName });
    return buffer;
  } catch (error) {
    console.error(`[FILLER] Error loading filler audio: ${error.message}`);
    return null;
  }
}

function getCachedPreGeneratedFillerAudio(ttsEngine, ttsVoice, speed) {
  const key = getFillerCacheKey(ttsEngine, ttsVoice, speed);
  const cached = fillerAudioCache.get(key);
  if (cached && cached.buffer && cached.buffer.length > 0) {
    console.log(`[FILLER] Cache hit: ${cached.fileName}, bytes=${cached.buffer.length}`);
    return cached.buffer;
  }
  console.log(`[FILLER] Cache miss: filler-aizuchi-${FILLER_VERSION}-${ttsEngine}-${ttsVoice}-${speed}.ulaw`);
  return null;
}

function requestStopAudio(session, reason) {
  if (!session || !session.isSendingAudio) return;
  if (session._uninterruptibleAudioGen && session._uninterruptibleAudioGen === session._activeAudioGen) {
    console.log(`[WS-AUDIO] Stop ignored (uninterruptible) call=${session.callSid || "unknown"} gen=${session._activeAudioGen} reason=${reason}`);
    return;
  }
  // 現在送信中の世代を停止要求
  session._stopAudioGen = session._activeAudioGen;
  console.log(`[WS-AUDIO] Stop requested (${reason}) call=${session.callSid || "unknown"} gen=${session._activeAudioGen}`);
}

async function stopOngoingAudio(session, reason) {
  if (!session || !session.isSendingAudio) return;
  requestStopAudio(session, reason);
  // 送信ループが止まるのを待つ（20ms刻みなので基本すぐ止まる）
  if (session._audioSendPromise) {
    try { await session._audioSendPromise; } catch (_) {}
  }
}

async function maybePlayFillerAizuchi(session) {
  try {
    if (!session || !session.callSid) return;
    // どのような会話でも、毎ターン必ず相槌から始める（ユーザー要望）
    // ただし、送信中の音声がある場合は先に停止して切り替える
    if (session.isSendingAudio) {
      await stopOngoingAudio(session, "before_filler");
    }

    const ttsEngine = session._ttsEngineForCall || "openai";
    const ttsVoice = session._ttsVoiceForCall || "echo";
    const speed = session._speedForCall || 1.3;

    // 1) キャッシュ 2) GCS
    let buf = getCachedPreGeneratedFillerAudio(ttsEngine, ttsVoice, speed);
    if (!buf) buf = await loadPreGeneratedFillerAudio(ttsEngine, ttsVoice, speed);
    if (!buf) {
      // 3) その場で生成（次回以降の高速化のため、保存は非同期）
      buf = await generateFillerMulawBuffer(session.callSid, ttsEngine, ttsVoice, speed);
      // メモリキャッシュ（即時）
      fillerAudioCache.set(getFillerCacheKey(ttsEngine, ttsVoice, speed), {
        buffer: buf,
        loadedAt: Date.now(),
        fileName: `filler-aizuchi-${FILLER_VERSION}-${ttsEngine}-${ttsVoice}-${speed}.ulaw`,
      });
      // GCS保存（遅延を避けるためawaitしない）
      savePreGeneratedFillerAudio(buf, ttsEngine, ttsVoice, speed).catch(() => {});
    }
    if (!buf) return;

    console.log(`[FILLER] Playing aizuchi call=${session.callSid} bytes=${buf.length}`);
    session._fillerActive = true;
    // 非同期で送信（返答生成と並列化）
    const p = sendAudioViaWebSocket(session, buf, { label: "filler" });
    session._audioSendPromise = p;
    p.finally(() => {
      session._fillerActive = false;
    });
  } catch (e) {
    console.error(`[FILLER] Error: ${e.message}`);
  }
}

// WebSocketサーバー
const wss = new WebSocket.Server({ noServer: true });

async function handleInboundMediaMessage(session, message) {
  // 音声データを受信（相手の音声）
  const payload = message.media?.payload;
  const track = message.media?.track;

  // 念のため：inbound以外（outbound/both等）は転写・VAD対象から除外
  if (track && track !== "inbound") return;

  // 初期挨拶の再生中は、誤検知（挨拶の回り込み等）を避けるためVAD/転写を一旦無視する
  // 要件: 初期挨拶は相手が話し始めても中止せず最後まで再生する
  if (session._greetingInProgress) {
    return;
  }

  // mediaイベントが受信された時点で、startイベントがまだ受信されていない場合、
  // streamSidをmediaイベントから取得して初期メッセージを送信する
  if (!session.startReceived && message.streamSid) {
    console.log(`[WS] Media event received before start event, extracting streamSid from media event: ${message.streamSid}`);
    session.streamSid = message.streamSid;
    session.startReceived = true;

    // callSidがまだ設定されていない場合、Firestoreから最新の通話を検索
    if (!session.callSid) {
      console.log(`[WS] callSid not set, searching Firestore for recent call`);
      try {
        const recentCalls = await db.collection("calls")
          .where("status", "==", "ringing")
          .orderBy("startTime", "desc")
          .limit(1)
          .get();

        if (!recentCalls.empty) {
          const recentCall = recentCalls.docs[0];
          const foundCallSid = recentCall.id;
          console.log(`[WS] Found recent call in Firestore: ${foundCallSid}`);
          session.callSid = foundCallSid;
          activeSessions.set(foundCallSid, session);
        } else {
          console.error(`[WS] No recent call found in Firestore`);
        }
      } catch (error) {
        console.error(`[WS] Error searching Firestore for callSid: ${error.message}`);
      }
    }

    // onStreamSidReadyコールバックが設定されていない場合、設定する
    if (!session.onStreamSidReady && session.callSid) {
      console.log(`[WS] Setting onStreamSidReady callback for call ${session.callSid}`);
      session.onStreamSidReady = () => onStreamSidReady(session);
    }

    // connectedフラグが設定されていない場合、設定する（mediaイベントが受信されているので接続済み）
    if (!session.connected) {
      console.log(`[WS] Setting connected flag based on media event reception`);
      session.connected = true;
    }

    // 初期メッセージがまだ送信されていない場合、送信する
    if (!session.initialMessageSent && session.callSid && session.streamSid && session.startReceived && session.onStreamSidReady) {
      console.log(`[WS] Triggering onStreamSidReady from media event handler for call ${session.callSid}`);
      session.onStreamSidReady();
    }
  }

  if (!payload) return;

  const callSid = session.callSid || "unknown";
  const now = Date.now();

  // base64デコードしてmu-lawデータを取得
  const audioData = Buffer.from(payload, "base64");

  // 音声レベルを計算（0..100）
  const audioLevel = calculateAudioLevel(audioData);
  // 小声/モゴモゴでも拾えるよう、デフォルトは少し低めにする（必要なら環境変数で上書き）
  const baseThreshold = Number(process.env.VAD_THRESHOLD || "2");
  const playingThreshold = Number(process.env.VAD_THRESHOLD_WHILE_PLAYING || "6");
  const threshold = session.isSendingAudio ? playingThreshold : baseThreshold;

  // VADは「開始/終了の判定」のみに使い、発話中はレベルに関係なく連続でバッファリングする
  session._speechActive = session._speechActive || false;
  session._segmentBuffers = session._segmentBuffers || [];
  session._segmentLastNonSilentIndex = (typeof session._segmentLastNonSilentIndex === "number") ? session._segmentLastNonSilentIndex : -1;

  const isSpeechFrame = audioLevel > threshold;
  // 発話開始の誤検知を抑えるため、連続フレームで判定する
  session._speechWarmup = session._speechWarmup || 0;
  if (isSpeechFrame) session._speechWarmup += 1;
  else session._speechWarmup = 0;
  const warmupNeeded = session.isSendingAudio ? Number(process.env.SPEECH_WARMUP_FRAMES_WHILE_PLAYING || "4")
                                             : Number(process.env.SPEECH_WARMUP_FRAMES || "2");
  const isSpeechStartConfirmed = session._speechWarmup >= warmupNeeded;

  if (!session._speechActive) {
    if (!isSpeechStartConfirmed) return;
    session._speechActive = true;
    session._segmentStartMs = now;
    session._speechStartMs = now;
    session._segmentBuffers = [];
    session._segmentLastNonSilentIndex = -1;
    console.log(`[LAT] speech_start call=${callSid} t=${now} level=${audioLevel.toFixed(2)}`);

    // 発話開始で、AI音声送信中なら即中断（ただし初期挨拶は中断不可）
    if (session.isSendingAudio) {
      console.log(`[WS] Caller speech detected while audio playing call=${callSid}`);
      requestStopAudio(session, "caller_speech");
    }

    // 直前のeos確定後に“処理待ち”がある場合はキャンセルして、次のeosまで結合する
    if (session._pendingProcessTimer) {
      clearTimeout(session._pendingProcessTimer);
      session._pendingProcessTimer = null;
      console.log(`[MERGE] pending processing cancelled due to new speech call=${callSid} pendingParts=${(session._pendingUserSegments || []).length}`);
    }
  }

  // 発話中：レベルに関係なくフレームを連続で追加
  session._segmentBuffers.push(audioData);
  if (isSpeechFrame) {
    session.lastIncomingAudioTime = now;
    session._segmentLastNonSilentIndex = session._segmentBuffers.length - 1;
    session._lastSpeechMs = now;
  }

  // 無音が続いたら区切る（体感遅延に直結するので短めに）
  const silenceThresholdMs = Number(process.env.SILENCE_MS || "300");
  const lastSpeechAt = session.lastIncomingAudioTime || session._speechStartMs || now;
  const silenceMs = now - lastSpeechAt;
  if (session._speechActive && silenceMs > silenceThresholdMs && !isSpeechFrame) {
    const endAt = now;
    const keepCount = Math.max(0, session._segmentLastNonSilentIndex + 1);
    const kept = session._segmentBuffers.slice(0, keepCount);
    const combined = kept.length ? Buffer.concat(kept) : Buffer.alloc(0);

    const speechMs = session._speechStartMs ? (endAt - session._speechStartMs) : 0;
    console.log(`[LAT] eos_confirmed call=${callSid} speechDurationMs=${speechMs} bytes=${combined.length} frames=${kept.length} silenceMs=${silenceMs} silenceThresholdMs=${silenceThresholdMs}`);

    // 誤検知対策：極小の区間は発話として扱わない（相槌が勝手に鳴るのを防ぐ）
    const minFrames = Number(process.env.MIN_SPEECH_FRAMES || "10");
    const minBytes = Number(process.env.MIN_SPEECH_BYTES || "1600"); // 0.2s相当
    const minMs = Number(process.env.MIN_SPEECH_MS || "400");

    session._speechActive = false;
    session._segmentBuffers = [];
    session._segmentLastNonSilentIndex = -1;
    session._speechWarmup = 0;

    if (combined.length > 0) {
      if (kept.length < minFrames || combined.length < minBytes || speechMs < minMs) {
        console.log(`[LAT] segment_drop call=${callSid} reason=too_small frames=${kept.length}/${minFrames} bytes=${combined.length}/${minBytes} ms=${speechMs}/${minMs}`);
        return;
      }
      await maybePlayFillerAizuchi(session);
      // 相槌中の“割り込み”を拾って前後を結合できるよう、少し待ってから処理する
      queueOrMergeIncomingSegment(session, combined);
    }
  }
}

// 事前生成された初期音声をCloud Storageから読み込む
async function loadPreGeneratedInitialAudio(ttsEngine, ttsVoice, speed) {
  try {
    const fileName = `initial-greeting-${ttsEngine}-${ttsVoice}-${speed}.ulaw`;
    const file = bucket.file(fileName);
    
    // ファイルが存在するか確認
    const [exists] = await file.exists();
    if (exists) {
      console.log(`[PRE-AUDIO] Loading pre-generated initial audio: ${fileName}`);
      const [buffer] = await file.download();
      // キャッシュへ格納（次回以降の即時送信用）
      preGeneratedAudioCache.set(getGreetingCacheKey(ttsEngine, ttsVoice, speed), { buffer, loadedAt: Date.now(), fileName });
      return buffer;
    } else {
      console.log(`[PRE-AUDIO] Pre-generated audio not found: ${fileName}, will generate on demand`);
      return null;
    }
  } catch (error) {
    console.error(`[PRE-AUDIO] Error loading pre-generated audio: ${error.message}`);
    return null;
  }
}

// 事前生成された初期音声をCloud Storageに保存する
async function savePreGeneratedInitialAudio(audioBuffer, ttsEngine, ttsVoice, speed) {
  try {
    const fileName = `initial-greeting-${ttsEngine}-${ttsVoice}-${speed}.ulaw`;
    const file = bucket.file(fileName);
    
    await file.save(audioBuffer, {
      contentType: 'audio/basic',
      metadata: {
        cacheControl: 'public, max-age=31536000', // 1年間キャッシュ
      },
    });
    
    console.log(`[PRE-AUDIO] Saved pre-generated initial audio: ${fileName}`);
    // 保存成功したらキャッシュも更新
    preGeneratedAudioCache.set(getGreetingCacheKey(ttsEngine, ttsVoice, speed), { buffer: audioBuffer, loadedAt: Date.now(), fileName });
  } catch (error) {
    console.error(`[PRE-AUDIO] Error saving pre-generated audio: ${error.message}`);
  }
}

// mu-law音声データから音声レベルを計算（VAD用）
// - Twilio Media Streamsのmu-law無音は0xFFがほぼ連続する
// - 以前の abs(byte-128) は 0xFF を最大音量扱いしてしまい、無音でも「発話あり」と誤判定して初期音声を即中断していた
function calculateAudioLevel(mulawBuffer) {
  if (!mulawBuffer || mulawBuffer.length === 0) return 0;

  const sampleSize = Math.min(160, mulawBuffer.length); // 約20ms

  // 無音(0xFF)比率が高ければ即0扱い（高速パス）
  let silentCount = 0;
  for (let i = 0; i < sampleSize; i++) {
    if (mulawBuffer[i] === 0xff) silentCount++;
  }
  if (silentCount / sampleSize > 0.95) return 0;

  // mu-law -> linear PCM(16bit) デコードしてRMSを計算
  let sumSq = 0;
  for (let i = 0; i < sampleSize; i++) {
    const pcm = muLawToLinearSample(mulawBuffer[i]);
    sumSq += pcm * pcm;
  }
  const rms = Math.sqrt(sumSq / sampleSize);

  // 0..100程度に正規化（しきい値はこのスケールで設定）
  return (rms / 32768) * 100;
}

function muLawToLinearSample(muLawByte) {
  // ITU-T G.711 μ-law decode (8-bit) -> 16-bit linear PCM
  // 参考実装と同等の定番アルゴリズム
  let u = (~muLawByte) & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;

  // bias: 33 (0x21) << 2 = 132 (0x84) を用いる形式
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  return sign * (magnitude - 0x84);
}

// MP3音声をmu-law形式（8000Hz、モノラル）に変換
async function convertMp3ToMulaw(mp3Buffer) {
  const timestamp = Date.now();
  const inputFile = `/tmp/audio_${timestamp}.mp3`;
  const outputFile = `/tmp/audio_${timestamp}.ulaw`;

  try {
    console.log(`[AUDIO] Starting MP3 to mu-law conversion, input size: ${mp3Buffer.length} bytes`);
    
    // MP3音声を一時ファイルに保存
    fs.writeFileSync(inputFile, mp3Buffer);
    const inputStats = fs.statSync(inputFile);
    console.log(`[AUDIO] Input file written: ${inputFile}, size: ${inputStats.size} bytes`);

    // FFmpegを使用してMP3をmu-law形式に変換
    const ffmpegCommand = `ffmpeg -i ${inputFile} -ar 8000 -ac 1 -f mulaw ${outputFile} -y`;
    console.log(`[AUDIO] Running FFmpeg command: ${ffmpegCommand}`);
    
    const { stdout, stderr } = await execAsync(ffmpegCommand);
    console.log(`[AUDIO] FFmpeg conversion completed, stdout: ${stdout.substring(0, 200)}, stderr: ${stderr.substring(0, 200)}`);

    // mu-law形式の音声を読み込み
    const mulawBuffer = fs.readFileSync(outputFile);
    const outputStats = fs.statSync(outputFile);
    
    console.log(`[AUDIO] Mu-law file read: ${outputFile}, size: ${outputStats.size} bytes`);

    // 計算: 8000Hz、モノラル、mu-law（1バイト/サンプル）なので、1秒 = 8000バイト
    const estimatedDuration = mulawBuffer.length / 8000;
    console.log(`[AUDIO] Estimated audio duration: ${estimatedDuration.toFixed(2)} seconds`);

    // 一時ファイルを削除
    if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

    return mulawBuffer;
  } catch (error) {
    console.error(`[AUDIO] Error converting MP3 to mu-law: ${error.message}`);
    // 一時ファイルをクリーンアップ
    try {
      if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    } catch (cleanupError) {
      // クリーンアップエラーは無視
    }
    throw error;
  }
}

// WebSocket経由で音声を送信（中断可能）
async function sendAudioViaWebSocket(session, mulawBuffer) {
  // sendAudioViaWebSocket 自体のPromiseを session に保持し、stopOngoingAudio() で待てるようにする
  const opts = arguments.length >= 3 ? arguments[2] : undefined; // (session, buf, {label, uninterruptible})
  const sendPromise = (async () => {
    console.log(`[WS-AUDIO] Starting audio send via WebSocket for call ${session.callSid}`);
    
    // WebSocket接続状態の検証
    if (!session || !session.ws) {
      console.error(`[WS-AUDIO] WebSocket session not found for call ${session?.callSid}`);
      throw new Error("WebSocket session not found");
    }
    
    if (session.ws.readyState !== WebSocket.OPEN) {
      console.error(`[WS-AUDIO] WebSocket connection is not open for call ${session.callSid}, readyState: ${session.ws.readyState}`);
      throw new Error(`WebSocket connection is not open, readyState: ${session.ws.readyState}`);
    }
    
    console.log(`[WS-AUDIO] WebSocket connection verified for call ${session.callSid}, readyState: ${session.ws.readyState}`);
  
    // streamSidを取得（startイベントから取得したもの）
    const streamSid = session.streamSid;
    if (!streamSid) {
      console.error(`[WS-AUDIO] Stream SID not found in session for call ${session.callSid}`);
      throw new Error("Stream SID not found in session");
    }
    
    console.log(`[WS-AUDIO] Using streamSid: ${streamSid} for call ${session.callSid}`);
  
    // 音声送信開始フラグ/世代を設定（並列送信や中断の競合を避ける）
    session._audioGenCounter = (session._audioGenCounter || 0) + 1;
    const gen = session._audioGenCounter;
    session._activeAudioGen = gen;
    session._stopAudioGen = null;
    session.isSendingAudio = true;
    if (opts && opts.uninterruptible) {
      session._uninterruptibleAudioGen = gen;
      console.log(`[WS-AUDIO] Marked uninterruptible call=${session.callSid} gen=${gen} label=${opts.label || "n/a"}`);
    }
    if (opts && opts.label === "greeting") {
      session._greetingInProgress = true;
    }
  
    // チャンクサイズ（Twilioの推奨: 約160バイト = 20ms分の音声）
    // mu-law形式は8000Hzなので、160バイト = 20ms
    const chunkSize = 160;
    const totalChunks = Math.ceil(mulawBuffer.length / chunkSize);
  
    console.log(`[WS-AUDIO] Sending audio via WebSocket: ${totalChunks} chunks, total size: ${mulawBuffer.length} bytes`);
    const label = (opts && opts.label) ? opts.label : "audio";
    const tStartSend = Date.now();
  
    let sentChunks = 0;
    let wasInterrupted = false;
  
    // 音声データをバイナリチャンクに分割して送信
    for (let i = 0; i < totalChunks; i++) {
      // 中断フラグをチェック（この送信世代に対する停止要求のみ）
      if (session._stopAudioGen === gen) {
        console.log(`[WS-AUDIO] Audio sending interrupted for call ${session.callSid} at chunk ${i}/${totalChunks}`);
        wasInterrupted = true;
        break;
      }
  
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, mulawBuffer.length);
      const chunk = mulawBuffer.slice(start, end);
      
      // 各チャンクをbase64エンコード
      const base64Payload = chunk.toString("base64");
  
      const mediaMessage = {
        event: "media",
        streamSid: streamSid,
        media: {
          payload: base64Payload,
        },
      };
  
      session.ws.send(JSON.stringify(mediaMessage));
      sentChunks++;
      if (i === 0) {
        const now = Date.now();
        const sinceStartEvt = session._startEventMs ? (now - session._startEventMs) : null;
        const sinceEos = session._lastEosConfirmedMs ? (now - session._lastEosConfirmedMs) : null;
        console.log(`[LAT] ws_first_chunk call=${session.callSid} label=${label} sinceStartEventMs=${sinceStartEvt} sinceEosMs=${sinceEos} t=${now}`);
      }
      
      // 送信レートを制御（20msごとに送信）
      if (i < totalChunks - 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  
    // 音声送信完了フラグをリセット（この送信世代のみ）
    if (session._activeAudioGen === gen) {
      session.isSendingAudio = false;
      if (session._stopAudioGen === gen) session._stopAudioGen = null;
      if (session._uninterruptibleAudioGen === gen) session._uninterruptibleAudioGen = null;
    }
    if (opts && opts.label === "greeting") {
      session._greetingInProgress = false;
    }
  
    if (!wasInterrupted) {
      // 音声送信完了後、markメッセージを送信して再生完了を追跡
      const markName = `audio_${Date.now()}`;
      const markMessage = {
        event: "mark",
        streamSid: streamSid,
        mark: {
          name: markName,
        },
      };
  
      session.ws.send(JSON.stringify(markMessage));
      console.log(`[WS-AUDIO] Mark message sent: ${markName} for call ${session.callSid}`);
    } else {
      console.log(`[WS-AUDIO] Audio sending stopped early (${sentChunks}/${totalChunks} chunks sent) for call ${session.callSid}`);
    }
  
    console.log(`[LAT] ws_send_complete call=${session.callSid} label=${label} sentChunks=${sentChunks}/${totalChunks} dt=${Date.now() - tStartSend}ms`);
    return !wasInterrupted;
  })();

  session._audioSendPromise = sendPromise;
  return await sendPromise;
}

// 受信した音声を処理（Whisperで転写して返答を生成）
async function processIncomingAudio(session, combinedAudioOverride) {
  const callSid = session.callSid;

  // 発話区間処理はキュー化して直列実行（2回目以降が落ちないように）
  if (!session._segmentQueue) session._segmentQueue = [];
  if (combinedAudioOverride && combinedAudioOverride.length) {
    session._segmentQueue.push(combinedAudioOverride);
  }
  if (session._segmentRunning) {
    console.log(`[LAT] segment_queued call=${callSid} qlen=${session._segmentQueue.length}`);
    return;
  }
  session._segmentRunning = true;
  session.processingIncomingAudio = true;
  const t0 = Date.now();
  const bufferedChunks = combinedAudioOverride ? 0 : (session.incomingAudioBuffer ? session.incomingAudioBuffer.length : 0);
  console.log(`[LAT] process_start call=${callSid} t=${t0} bufferedChunks=${bufferedChunks}`);
  
  try {
    while (session._segmentQueue.length) {
      const combinedAudio = session._segmentQueue.shift();
      console.log(`[LAT] buffer_concat call=${callSid} bytes=${combinedAudio.length} dt=${Date.now() - t0}ms qleft=${session._segmentQueue.length}`);

      if (!combinedAudio || combinedAudio.length === 0) {
        console.warn(`[AUDIO-IN] Empty combined audio for call ${callSid}`);
        continue;
      }
    
    // mu-law形式の音声をWAV形式に変換（Whisper用）
    const timestamp = Date.now();
    const inputFile = `/tmp/incoming_${timestamp}.ulaw`;
    const outputFile = `/tmp/incoming_${timestamp}.wav`;
    
    fs.writeFileSync(inputFile, combinedAudio);
    
    // FFmpegでmu-lawをWAVに変換
    // 小声/こもり声をWhisperが拾いやすいよう、簡易の帯域フィルタ＋ゲインを適用してWAVへ
    // （過剰な正規化は遅延増につながるため、軽量なフィルタに留める）
    const whisperGainDb = Number(process.env.WHISPER_GAIN_DB || "6"); // dB
    const whisperFilters = process.env.WHISPER_AUDIO_FILTERS
      || `highpass=f=120,lowpass=f=3800,volume=${whisperGainDb}dB`;
    const ffmpegCommand = `ffmpeg -f mulaw -ar 8000 -ac 1 -i ${inputFile} -af '${whisperFilters}' -ar 16000 -ac 1 -f wav ${outputFile} -y`;
    const tFfmpeg1 = Date.now();
    await execAsync(ffmpegCommand);
    console.log(`[LAT] ffmpeg_ulaw_to_wav call=${callSid} dt=${Date.now() - tFfmpeg1}ms total=${Date.now() - t0}ms`);
    
    const wavBuffer = fs.readFileSync(outputFile);
    console.log(`[LAT] wav_read call=${callSid} bytes=${wavBuffer.length} total=${Date.now() - t0}ms`);
    
    // 一時ファイルを削除
    if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    
    // Whisperで転写（OpenAI SDKを使用）
    const FormData = require("form-data");
    const formData = new FormData();
    formData.append("file", wavBuffer, {
      filename: "audio.wav",
      contentType: "audio/wav",
    });
    formData.append("model", "whisper-1");
    formData.append("language", "ja");
    // 返却フォーマット（デバッグしやすいようverbose）
    formData.append("response_format", "verbose_json");
    // 低めの温度で安定化
    formData.append("temperature", "0");
    
    // OpenAI APIに直接リクエストを送信
    const https = require("https");
    const transcriptionPromise = new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.openai.com",
        path: "/v1/audio/transcriptions",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${getOpenAIApiKey()}`,
          ...formData.getHeaders(),
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            resolve({
              statusCode: res.statusCode,
              text: result.text || "",
              language: result.language,
              error: result.error,
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      
      req.on("error", reject);
      formData.pipe(req);
    });
    
    const tWhisper = Date.now();
    const whisperResult = await transcriptionPromise;
    const userMessage = (whisperResult.text || "").trim();
    console.log(`[LAT] whisper_done call=${callSid} dt=${Date.now() - tWhisper}ms total=${Date.now() - t0}ms chars=${userMessage.length}`);
    console.log(`[AUDIO-IN] Whisper meta call=${callSid}: status=${whisperResult.statusCode} lang=${whisperResult.language || "n/a"} hasError=${whisperResult.error ? "yes" : "no"}`);
    console.log(`[AUDIO-IN] Transcription for call ${callSid}: ${userMessage}`);

    // 空転写/エラーは会話履歴に入れず、再度話してもらう
    if (!userMessage) {
      console.warn(`[AUDIO-IN] Empty transcription (status=${whisperResult.statusCode}) for call ${callSid}`);
      await sendAudioResponseViaMediaStream(session, "すみません、少し聞き取れませんでした。もう一度お願いできますか？");
      continue;
    }
    
    // Firestoreに会話を保存
    const callRef = db.collection("calls").doc(callSid);
    const tFs1 = Date.now();
    // 疑似電話（SIM_CALL_*）など、calls/{callSid} が無いケースでも落ちないように set(merge) を使う
    await callRef.set(
      {
        callSid,
        status: "active",
        updatedAt: Timestamp.now(),
        conversations: require("firebase-admin/firestore").FieldValue.arrayUnion({
          role: "user",
          content: userMessage,
          timestamp: Timestamp.now(),
        }),
      },
      { merge: true }
    );
    console.log(`[LAT] firestore_user_update call=${callSid} dt=${Date.now() - tFs1}ms total=${Date.now() - t0}ms`);

    // AIによる意図分類で、対応不能な要望は伝言へ誘導する
    const cls = await classifyUserTurnWithAI(session, userMessage);
    console.log(`[FLOW] intent call=${callSid} action=${cls.action} reason=${cls.reason}`);

    if (cls.action === "farewell") {
      const farewell = "承知しました。失礼いたします。";
      console.log(`[FLOW] farewell call=${callSid}`);
      const tFs2 = Date.now();
      await callRef.set(
        {
          updatedAt: Timestamp.now(),
          conversations: require("firebase-admin/firestore").FieldValue.arrayUnion({
            role: "assistant",
            content: farewell,
            timestamp: Timestamp.now(),
          }),
        },
        { merge: true }
      );
      console.log(`[LAT] firestore_assistant_update call=${callSid} dt=${Date.now() - tFs2}ms total=${Date.now() - t0}ms`);
      const tSend = Date.now();
      await sendAudioResponseViaMediaStream(session, farewell);
      console.log(`[LAT] send_audio_done call=${callSid} dt=${Date.now() - tSend}ms total=${Date.now() - t0}ms`);
      continue;
    }

    if (cls.action === "take_message") {
      const prompt = "恐れ入りますが担当者へお繋ぎできません。伝言として承りますので、ご用件と、お名前・折り返し先（電話番号）をお話しください。";
      console.log(`[FLOW] take_message call=${callSid}`);
      const tFs2 = Date.now();
      await callRef.set(
        {
          updatedAt: Timestamp.now(),
          conversations: require("firebase-admin/firestore").FieldValue.arrayUnion({
            role: "assistant",
            content: prompt,
            timestamp: Timestamp.now(),
          }),
        },
        { merge: true }
      );
      console.log(`[LAT] firestore_assistant_update call=${callSid} dt=${Date.now() - tFs2}ms total=${Date.now() - t0}ms`);
      const tSend = Date.now();
      await sendAudioResponseViaMediaStream(session, prompt);
      console.log(`[LAT] send_audio_done call=${callSid} dt=${Date.now() - tSend}ms total=${Date.now() - t0}ms`);
      continue;
    }

    if (cls.action === "closing") {
      session._purposeCaptured = true;
      session._closingAsked = true;
      console.log(`[FLOW] closing call=${callSid}`);

      // Firestoreにもフラグを残す（UI側で一覧/検索に使える）
      try {
        await callRef.set({
          purposeCaptured: true,
          purposeMessage: userMessage,
          purposeCapturedAt: Timestamp.now(),
        }, { merge: true });
      } catch (_) {}

      const closing = `承知しました。${CLOSING_TEXT}`;
      const tFs2 = Date.now();
      await callRef.set(
        {
          updatedAt: Timestamp.now(),
          conversations: require("firebase-admin/firestore").FieldValue.arrayUnion({
            role: "assistant",
            content: closing,
            timestamp: Timestamp.now(),
          }),
        },
        { merge: true }
      );
      console.log(`[LAT] firestore_assistant_update call=${callSid} dt=${Date.now() - tFs2}ms total=${Date.now() - t0}ms`);
      const tSend = Date.now();
      await sendAudioResponseViaMediaStream(session, closing);
      console.log(`[LAT] send_audio_done call=${callSid} dt=${Date.now() - tSend}ms total=${Date.now() - t0}ms`);
      continue;
    }

    // フォールバック（分類失敗時）: 既存の簡易判定
    if (session._closingAsked && detectNoMoreRequests(userMessage)) {
      const farewell = "承知しました。失礼いたします。";
      console.log(`[FLOW] no_more_requests_fallback call=${callSid}`);
      const tFs2 = Date.now();
      await callRef.set(
        {
          updatedAt: Timestamp.now(),
          conversations: require("firebase-admin/firestore").FieldValue.arrayUnion({
            role: "assistant",
            content: farewell,
            timestamp: Timestamp.now(),
          }),
        },
        { merge: true }
      );
      console.log(`[LAT] firestore_assistant_update call=${callSid} dt=${Date.now() - tFs2}ms total=${Date.now() - t0}ms`);
      const tSend = Date.now();
      await sendAudioResponseViaMediaStream(session, farewell);
      console.log(`[LAT] send_audio_done call=${callSid} dt=${Date.now() - tSend}ms total=${Date.now() - t0}ms`);
      continue;
    }
    
    // ChatGPTで返答を生成
    const tFsGet = Date.now();
    const callDoc = await callRef.get();
    console.log(`[LAT] firestore_get call=${callSid} dt=${Date.now() - tFsGet}ms total=${Date.now() - t0}ms`);
    const callData = callDoc.data();
    const conversations = callData?.conversations || [];
    
    const tChat = Date.now();
    const chatResponse = await openai.chat.completions.create({
      model: process.env.CHAT_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "あなたはテックファンドの電話応対AIです。丁寧で親切な対応を心がけてください。返答はできるだけ短く、1〜2文で要点のみ述べてください。相手に確認が必要なら短い質問を1つだけしてください。",
        },
        ...conversations.slice(-10).map((c) => ({
          role: c.role === "user" ? "user" : "assistant",
          content: c.content,
        })),
      ],
      temperature: 0.3,
      max_tokens: 80,
    });
    console.log(`[LAT] chat_done call=${callSid} dt=${Date.now() - tChat}ms total=${Date.now() - t0}ms`);
    
    let aiResponse = (chatResponse.choices[0]?.message?.content || "").trim();
    // 念のため過度に長い返答は切り詰める（会話履歴/音声も短くする）
    const maxChars = Number(process.env.MAX_RESPONSE_CHARS || "140");
    if (aiResponse.length > maxChars) {
      aiResponse = aiResponse.slice(0, maxChars).trimEnd() + "…";
    }
    console.log(`[AUDIO-IN] AI response for call ${callSid}: ${aiResponse}`);
    
    // FirestoreにAI返答を保存
    const tFs2 = Date.now();
    await callRef.set(
      {
        updatedAt: Timestamp.now(),
        conversations: require("firebase-admin/firestore").FieldValue.arrayUnion({
          role: "assistant",
          content: aiResponse,
          timestamp: Timestamp.now(),
        }),
      },
      { merge: true }
    );
    console.log(`[LAT] firestore_assistant_update call=${callSid} dt=${Date.now() - tFs2}ms total=${Date.now() - t0}ms`);
    
    // AI返答を音声で送信
    const tSend = Date.now();
    await sendAudioResponseViaMediaStream(session, aiResponse);
    console.log(`[LAT] send_audio_done call=${callSid} dt=${Date.now() - tSend}ms total=${Date.now() - t0}ms`);
    }
  } catch (error) {
    console.error(`[AUDIO-IN] Error processing incoming audio for call ${callSid}: ${error.message}`);
    console.error(`[AUDIO-IN] Error stack: ${error.stack}`);
  } finally {
    session.processingIncomingAudio = false;
    session._segmentRunning = false;
    session._speechStartMs = null;
    session._lastSpeechMs = null;
  }
}

// 初期メッセージを送信（事前生成された音声を使用）
async function sendInitialMessage(session) {
  const callSid = session.callSid;
  console.log(`[INIT] Attempting to send initial message for call ${callSid}`);
  console.log(`[INIT-DEBUG] Session state: streamSid=${session.streamSid}, startReceived=${session.startReceived}, connected=${session.connected}, ws.readyState=${session.ws?.readyState}`);
  
  // 重複送信を防ぐ
  if (session.initialMessageSent) {
    console.log(`[INIT] Initial message already sent, skipping for call ${callSid}`);
    return;
  }

  try {
    // streamSidとstartイベントの受信を待つ（最大2秒に戻す）
    const maxAttempts = 20; // 2秒待機
    let attempts = 0;
    while ((!session.streamSid || !session.startReceived) && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
      if (attempts % 5 === 0) {
        console.log(`[INIT-DEBUG] Waiting for streamSid/startReceived: attempt ${attempts}/${maxAttempts}, streamSid=${session.streamSid}, startReceived=${session.startReceived}`);
      }
    }

    if (!session.streamSid) {
      console.error(`[INIT] ERROR: Stream SID not found after waiting for call ${callSid}`);
      return;
    }

    if (!session.startReceived) {
      console.error(`[INIT] ERROR: Start event not received for call ${callSid}`);
      return;
    }

    // WebSocket接続状態を確認（待機時間を2秒に戻す）
    if (!session.ws) {
      console.error(`[INIT] ERROR: WebSocket session not found for call ${callSid}`);
      return;
    }
    
    if (session.ws.readyState !== WebSocket.OPEN) {
      console.log(`[INIT] WebSocket not open yet for call ${callSid}, readyState: ${session.ws.readyState}, waiting...`);
      // WebSocketがOPENになるまで最大2秒待つ
      let waitAttempts = 0;
      while (session.ws.readyState !== WebSocket.OPEN && waitAttempts < 20) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitAttempts++;
        if (waitAttempts % 5 === 0) {
          console.log(`[INIT-DEBUG] Waiting for WebSocket OPEN: attempt ${waitAttempts}/20, readyState=${session.ws.readyState}`);
        }
      }
      
      if (session.ws.readyState !== WebSocket.OPEN) {
        console.error(`[INIT] ERROR: WebSocket not open after waiting for call ${callSid}, readyState: ${session.ws.readyState}`);
        return;
      }
    }
    
    console.log(`[INIT-DEBUG] WebSocket is OPEN, proceeding with audio loading for call ${callSid}`);

    // Firestoreから音声設定を取得（並列処理で開始）
    // ※ 初期挨拶は“とにかく早く鳴らす”ため、デフォルトの生成済み音声があるならFirestore待ちをしない
    const defaultTtsEngine = "openai";
    const defaultTtsVoice = "echo";
    const defaultSpeed = 1.3;
    
    console.log(`[INIT-DEBUG] Loading pre-generated audio with default settings: engine=${defaultTtsEngine}, voice=${defaultTtsVoice}, speed=${defaultSpeed}`);
    
    // Firestoreから音声設定を取得（並列処理で開始）
    const callDocPromise = db.collection("calls").doc(callSid).get();
    
    // 事前生成された音声を先に読み込む（デフォルト設定）
    // 1) メモリキャッシュ 2) GCS
    let mulawBuffer = getCachedPreGeneratedInitialAudio(defaultTtsEngine, defaultTtsVoice, defaultSpeed);
    if (!mulawBuffer) {
      mulawBuffer = await loadPreGeneratedInitialAudio(defaultTtsEngine, defaultTtsVoice, defaultSpeed);
    }
    console.log(`[INIT-DEBUG] Pre-generated audio loaded (default): ${mulawBuffer ? `found, size=${mulawBuffer.length}` : 'not found'}`);

    // デフォルト音声が見つかった場合は、Firestore待ちせずに即送信
    if (mulawBuffer) {
      console.log(`[INIT] Using pre-generated audio (default fast-path) for call ${callSid}, size: ${mulawBuffer.length} bytes`);
      session.initialMessageSent = true;
      await sendAudioViaWebSocket(session, mulawBuffer, { label: "greeting", uninterruptible: true });
      console.log(`[INIT] Pre-generated initial audio sent successfully for call ${callSid}`);

      // Firestore設定は後で反映（相槌/返答用）。送信をブロックしない。
      callDocPromise.then((doc) => {
        const callData = doc.data() || {};
        session._ttsEngineForCall = callData.ttsEngine || defaultTtsEngine;
        session._ttsVoiceForCall = callData.ttsVoice || callData.voice || defaultTtsVoice;
        session._speedForCall = callData.speed || defaultSpeed;
        console.log(`[INIT-DEBUG] Firestore settings (post-send): engine=${session._ttsEngineForCall}, voice=${session._ttsVoiceForCall}, speed=${session._speedForCall}`);
      }).catch((e) => console.error(`[INIT-DEBUG] Firestore settings fetch failed: ${e.message}`));
      return;
    }

    // デフォルト音声が無い場合のみFirestoreを待って設定に基づき探す/生成する
    const callDoc = await callDocPromise;
    const callData = callDoc.data();
    const ttsEngine = callData?.ttsEngine || defaultTtsEngine;
    const ttsVoice = callData?.ttsVoice || callData?.voice || defaultTtsVoice;
    const speed = callData?.speed || defaultSpeed;
    session._ttsEngineForCall = ttsEngine;
    session._ttsVoiceForCall = ttsVoice;
    session._speedForCall = speed;

    console.log(`[INIT-DEBUG] Firestore settings: engine=${ttsEngine}, voice=${ttsVoice}, speed=${speed}`);

    // 設定に基づいて事前生成された音声を読み込む（キャッシュ→GCS）
    mulawBuffer = getCachedPreGeneratedInitialAudio(ttsEngine, ttsVoice, speed);
    if (!mulawBuffer) {
      mulawBuffer = await loadPreGeneratedInitialAudio(ttsEngine, ttsVoice, speed);
    }
    console.log(`[INIT-DEBUG] Pre-generated audio loaded (Firestore): ${mulawBuffer ? `found, size=${mulawBuffer.length}` : 'not found'}`);

    if (!mulawBuffer) {
      // 事前生成された音声がない場合、リアルタイムで生成
      console.log(`[INIT] Pre-generated audio not found, generating on demand for call ${callSid}`);
      const initialMessage = "お電話ありがとうございます。テックファンドです。";
      session.initialMessageSent = true;
      await sendAudioResponseViaMediaStream(session, initialMessage);
    } else {
      // 事前生成された音声を送信（設定に基づく）
      console.log(`[INIT] Using pre-generated audio (Firestore) for call ${callSid}, size: ${mulawBuffer.length} bytes`);
      session.initialMessageSent = true;
      // 初期挨拶は中断しない（ユーザー要望）
      await sendAudioViaWebSocket(session, mulawBuffer, { label: "greeting", uninterruptible: true });
      console.log(`[INIT] Pre-generated initial audio sent successfully for call ${callSid}`);
    }
    
  } catch (error) {
    console.error(`[INIT] Error sending initial audio for call ${callSid}: ${error.message}`);
    console.error(`[INIT] Error stack: ${error.stack}`);
  }
}

// streamSidが準備できたときのコールバック
function onStreamSidReady(session) {
  const callSid = session.callSid;
  console.log(`[STREAM] onStreamSidReady callback triggered for call ${callSid}`);
  console.log(`[STREAM-DEBUG] Session state: streamSid=${session.streamSid}, startReceived=${session.startReceived}, connected=${session.connected}, ws.readyState=${session.ws?.readyState}`);
  
  // WebSocket接続がOPENになるまで待つ（最大2秒に戻す）
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
    console.log(`[STREAM] onStreamSidReady: WebSocket not open, waiting for call ${callSid}, readyState: ${session.ws?.readyState}`);
    
    const maxWaitAttempts = 20; // 2秒待機
    let waitAttempts = 0;
    
    const waitForOpen = setInterval(() => {
      waitAttempts++;
      
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        clearInterval(waitForOpen);
        console.log(`[STREAM] WebSocket connection established, sending initial message for call ${callSid} after ${waitAttempts} attempts`);
        // 即座に初期メッセージを送信
        sendInitialMessage(session);
      } else if (waitAttempts >= maxWaitAttempts) {
        clearInterval(waitForOpen);
        console.error(`[STREAM] WebSocket connection timeout in onStreamSidReady for call ${callSid} after ${waitAttempts} attempts, readyState: ${session.ws?.readyState}`);
        // タイムアウトしても初期メッセージを送信を試みる
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          sendInitialMessage(session);
        } else {
          console.error(`[STREAM] Cannot send initial message: WebSocket is not OPEN, readyState: ${session.ws?.readyState}`);
        }
      } else if (waitAttempts % 5 === 0) {
        console.log(`[STREAM-DEBUG] Waiting for WebSocket OPEN: attempt ${waitAttempts}/${maxWaitAttempts}, readyState: ${session.ws?.readyState}`);
      }
    }, 100);
  } else {
    console.log(`[STREAM] WebSocket is OPEN, calling sendInitialMessage immediately for call ${callSid}`);
    // 即座に初期メッセージを送信
    sendInitialMessage(session);
  }
}

// セッション初期化
function initializeSession(callSid, ws) {
  const session = {
    callSid,
    ws,
    connected: false,
    startReceived: false,
    streamSid: null,
    initialMessageSent: false,
    onStreamSidReady: null,
    isSendingAudio: false,
    shouldStopAudio: false,
    incomingAudioBuffer: [], // 受信した音声データをバッファリング
    lastIncomingAudioTime: null,
    processingIncomingAudio: false,
    _mediaChain: Promise.resolve(),
    _segmentQueue: [],
    _segmentRunning: false,
  };

  // streamSidが準備できたときのコールバックを設定
  session.onStreamSidReady = () => onStreamSidReady(session);

  activeSessions.set(callSid, session);
  console.log(`[SESSION] Session initialized for call ${callSid}`);
  return session;
}

// WebSocket接続処理
wss.on("connection", async (ws, req) => {
  // デバッグ: リクエスト情報をログ出力
  console.log(`[WS-DEBUG] WebSocket connection established`);
  console.log(`[WS-DEBUG] Request URL: ${req.url}`);
  console.log(`[WS-DEBUG] Request headers: ${JSON.stringify(req.headers)}`);
  
  // URLを構築（クエリパラメータを含む）
  // req.urlが相対パスの場合、完全なURLを構築する
  let fullUrl = req.url || "/";
  if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
    const host = req.headers.host || "localhost";
    const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    fullUrl = `${protocol}://${host}${fullUrl}`;
  }
  
  const url = new URL(fullUrl);
  let callSid = url.searchParams.get("callSid");
  
  // callSidが取得できない場合、req.urlから直接抽出を試みる
  if (!callSid && req.url) {
    const match = req.url.match(/[?&]callSid=([^&]+)/);
    if (match) {
      callSid = decodeURIComponent(match[1]);
    }
  }
  
  console.log(`[WS-DEBUG] Parsed URL: ${url.toString()}`);
  console.log(`[WS-DEBUG] URL pathname: ${url.pathname}`);
  console.log(`[WS-DEBUG] URL search: ${url.search}`);
  console.log(`[WS-DEBUG] Extracted callSid: ${callSid}`);

  // callSidが取得できない場合でも接続を許可し、startイベントから取得を試みる
  let session = null;
  let pendingCallSid = callSid;
  
  if (!callSid) {
    console.log(`[WS] WebSocket connection accepted without callSid, will extract from start event`);
    // 一時的なセッションを作成（callSidは後で設定）
    session = {
      callSid: null,
      ws,
      connected: false,
      startReceived: false,
      streamSid: null,
      initialMessageSent: false,
      onStreamSidReady: null,
      isSendingAudio: false,
      shouldStopAudio: false,
      incomingAudioBuffer: [],
      lastIncomingAudioTime: null,
      processingIncomingAudio: false,
      _mediaChain: Promise.resolve(),
      _segmentQueue: [],
      _segmentRunning: false,
    };
  } else {
    console.log(`[WS] WebSocket connection established for call ${callSid}`);
    session = initializeSession(callSid, ws);
  }

  // connectedイベントの処理
  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // mediaフレームは頻度が高く、ログ大量出力が遅延要因になり得るためサマリ出力にする
      if (message.event === "media") {
        session._mediaCount = (session._mediaCount || 0) + 1;
        const every = Number(process.env.LOG_MEDIA_EVERY || "200");
        if (every > 0 && session._mediaCount % every === 0) {
          console.log(`[WS-DEBUG] media frames=${session._mediaCount} call=${session.callSid || "unknown"} streamSid=${session.streamSid || "unknown"}`);
        }
      } else if (message.event === "start" || message.event === "connected" || message.event === "stop") {
        console.log(`[WS-DEBUG] Received ${message.event} event: ${JSON.stringify(message)}`);
      } else {
        console.log(`[WS-DEBUG] Received event: ${message.event}`);
      }
      
      if (message.event === "media") {
        // mediaは高頻度＆状態管理があるため、セッション単位で直列化して競合を防ぐ
        session._mediaChain = (session._mediaChain || Promise.resolve())
          .then(() => handleInboundMediaMessage(session, message))
          .catch((e) => console.error(`[WS] media chain error call=${session.callSid || "unknown"}: ${e.message}`));
        return;
      }

      if (message.event === "connected") {
        // connectedイベントのメッセージ全体をログ出力
        console.log(`[WS-DEBUG] Connected event message: ${JSON.stringify(message)}`);
        
        // callSidがまだ設定されていない場合、connectedイベントから取得を試みる
        if (!session.callSid) {
          console.log(`[WS] Connected event received but callSid not set yet`);
          // connectedイベントにはcallSidが含まれていない可能性が高いが、connectedフラグは設定する
          session.connected = true;
          // startイベントを待つ
        } else {
          const callSid = session.callSid;
          console.log(`[WS] Connected event received for call ${callSid}`);
          session.connected = true;
        
          // startイベントが既に受信済みの場合は、onStreamSidReadyを呼び出す
          if (session.startReceived && session.streamSid) {
            console.log(`[WS] Both connected and start events received for call ${callSid}`);
            if (session.onStreamSidReady) {
              console.log(`[WS] Calling onStreamSidReady from connected event handler for call ${callSid}`);
              session.onStreamSidReady();
            }
          }
        }
      } else if (message.event === "start") {
        // startイベントのメッセージ全体をログ出力
        console.log(`[WS-DEBUG] Start event message: ${JSON.stringify(message)}`);
        session._startEventMs = Date.now();
        
        // callSidがまだ設定されていない場合、startイベントから取得を試みる
        if (!session.callSid) {
          // TwilioのstartイベントにはcallSidが含まれていない可能性があるが、
          // accountSidや他の情報から推測できる可能性がある
          // または、Firestoreから最新の通話を検索する
          const startCallSid = message.start?.callSid || message.callSid || message.accountSid;
          if (startCallSid) {
            console.log(`[WS] Extracted callSid from start event: ${startCallSid}`);
            session.callSid = startCallSid;
            // セッションをactiveSessionsに追加
            activeSessions.set(startCallSid, session);
            // onStreamSidReadyコールバックを設定
            session.onStreamSidReady = () => onStreamSidReady(session);
          } else {
            // startイベントにcallSidが含まれていない場合、Firestoreから最新の通話を検索
            console.log(`[WS] callSid not found in start event, searching Firestore for recent call`);
            try {
              const recentCalls = await db.collection("calls")
                .where("status", "==", "ringing")
                .orderBy("startTime", "desc")
                .limit(1)
                .get();
              
              if (!recentCalls.empty) {
                const recentCall = recentCalls.docs[0];
                const foundCallSid = recentCall.id;
                console.log(`[WS] Found recent call in Firestore: ${foundCallSid}`);
                session.callSid = foundCallSid;
                activeSessions.set(foundCallSid, session);
                session.onStreamSidReady = () => onStreamSidReady(session);
              } else {
                console.error(`[WS] No recent call found in Firestore`);
              }
            } catch (error) {
              console.error(`[WS] Error searching Firestore for callSid: ${error.message}`);
            }
          }
        }
        
        const callSid = session.callSid;
        if (!callSid) {
          console.error(`[WS] ERROR: callSid still not found after start event`);
          return;
        }
        
        console.log(`[WS] Start event received for call ${callSid}`);
        const streamSid = message.start?.streamSid;
        
        if (streamSid) {
          console.log(`[WS] Saving streamSid to session for call ${callSid}: ${streamSid}`);
          session.streamSid = streamSid;
          session.startReceived = true;
          
          // connectedイベントが既に受信済みの場合は、onStreamSidReadyを呼び出す
          if (session.connected) {
            console.log(`[WS] Checking onStreamSidReady callback for call ${callSid}`);
            if (session.onStreamSidReady) {
              console.log(`[WS] WebSocket is OPEN, calling onStreamSidReady for call ${callSid}`);
              session.onStreamSidReady();
            }
          } else {
            console.log(`[WS] Connected event not received yet, waiting for call ${callSid}`);
            
            // connectedイベントを待つ（最大5秒）
            const maxWaitAttempts = 50;
            let waitAttempts = 0;
            
            const waitForConnected = setInterval(() => {
              waitAttempts++;
              
              if (session.connected) {
                clearInterval(waitForConnected);
                console.log(`[WS] Connected event received, calling onStreamSidReady for call ${callSid} after ${waitAttempts} attempts`);
                if (session.ws.readyState === WebSocket.OPEN) {
                  if (session.onStreamSidReady) {
                    session.onStreamSidReady();
                  }
                } else {
                  console.error(`[WS] WebSocket not OPEN after connected event for call ${callSid}, readyState: ${session.ws.readyState}`);
                }
              } else if (waitAttempts >= maxWaitAttempts) {
                clearInterval(waitForConnected);
                console.error(`[WS] Connected event timeout for call ${callSid} after ${waitAttempts} attempts`);
              }
            }, 100);
          }
        }
      } else if (message.event === "mark") {
        // markイベントの処理
        console.log(`[WS] Mark event received for call ${callSid}: ${message.mark?.name}`);
      }
    } catch (error) {
      console.error(`[WS] Error parsing message for call ${callSid}: ${error.message}`);
    }
  });

  ws.on("close", () => {
    const callSid = session.callSid;
    if (callSid) {
      console.log(`[WS] WebSocket closed for call ${callSid}`);
      activeSessions.delete(callSid);
    } else {
      console.log(`[WS] WebSocket closed but callSid was never set`);
    }
  });

  ws.on("error", (error) => {
    const callSid = session.callSid;
    if (callSid) {
      console.error(`[WS] WebSocket error for call ${callSid}: ${error.message}`);
    } else {
      console.error(`[WS] WebSocket error (callSid not set): ${error.message}`);
    }
  });
});

// 音声応答をMedia Stream経由で送信
async function sendAudioResponseViaMediaStream(session, text) {
  const callSid = session.callSid;
  console.log(`[AUDIO] Generating audio response for call ${callSid}: ${text}`);
  const t0 = Date.now();

  try {
    // Firestoreから音声設定を取得
    const tFs = Date.now();
    const callDoc = await db.collection("calls").doc(callSid).get();
    console.log(`[LAT] tts_firestore_get call=${callSid} dt=${Date.now() - tFs}ms total=${Date.now() - t0}ms`);
    const callData = callDoc.data();
    
    const ttsEngine = callData?.ttsEngine || "openai";
    const ttsVoice = callData?.ttsVoice || callData?.voice || "echo";
    const speed = callData?.speed || 1.3;

    console.log(`[AUDIO] TTS settings for call ${callSid}: engine=${ttsEngine}, voice=${ttsVoice}, speed=${speed}`);

    let audioBuffer;

    if (ttsEngine === "openai") {
      // OpenAI TTSを使用
      const validOpenAIVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
      const finalVoice = validOpenAIVoices.includes(ttsVoice) ? ttsVoice : "echo";
      
      console.log(`[AUDIO] Generating OpenAI TTS for call ${callSid}, voice: ${finalVoice}, speed: ${speed}`);
      
      const tTts = Date.now();
      const response = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts-2025-12-15",
        voice: finalVoice,
        input: text,
        speed: speed,
      });
      console.log(`[LAT] openai_tts_done call=${callSid} dt=${Date.now() - tTts}ms total=${Date.now() - t0}ms`);
      
      const arrayBuffer = await response.arrayBuffer();
      audioBuffer = Buffer.from(arrayBuffer);
      console.log(`[AUDIO] OpenAI TTS generated for call ${callSid}, size: ${audioBuffer.length} bytes`);
    } else {
      // Google Cloud TTSを使用
      const validVoices = [
        "ja-JP-Wavenet-A", "ja-JP-Wavenet-B", "ja-JP-Wavenet-C", "ja-JP-Wavenet-D",
        "ja-JP-Standard-A", "ja-JP-Standard-B", "ja-JP-Standard-C", "ja-JP-Standard-D"
      ];
      const finalVoice = validVoices.includes(ttsVoice) ? ttsVoice : "ja-JP-Wavenet-A";
      
      console.log(`[AUDIO] Generating Google TTS for call ${callSid}, voice: ${finalVoice}, speed: ${speed}`);
      
      const tTts = Date.now();
      const [response] = await ttsClient.synthesizeSpeech({
        input: { text: text },
        voice: {
          languageCode: "ja-JP",
          name: finalVoice,
          ssmlGender: finalVoice.includes("Wavenet-A") || finalVoice.includes("Standard-A") || finalVoice.includes("Wavenet-B") || finalVoice.includes("Standard-B") ? "FEMALE" : "MALE"
        },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: speed,
          pitch: 0.0,
        },
      });
      console.log(`[LAT] google_tts_done call=${callSid} dt=${Date.now() - tTts}ms total=${Date.now() - t0}ms`);
      
      audioBuffer = Buffer.from(response.audioContent || "");
      console.log(`[AUDIO] Google TTS generated for call ${callSid}, size: ${audioBuffer.length} bytes`);
    }

    // MP3をmu-law形式に変換
    const tFfmpeg = Date.now();
    const mulawBuffer = await convertMp3ToMulaw(audioBuffer);
    console.log(`[LAT] ffmpeg_mp3_to_ulaw call=${callSid} dt=${Date.now() - tFfmpeg}ms total=${Date.now() - t0}ms bytes=${mulawBuffer.length}`);
    
    // WebSocket経由で音声を送信
    // 相槌などが再生中の場合はここで停止して切り替える（ただし初期挨拶は中断しない）
    await stopOngoingAudio(session, "new_ai_response");
    const tWsSend = Date.now();
    const isGreeting = (text === "お電話ありがとうございます。テックファンドです。");
    const completed = await sendAudioViaWebSocket(session, mulawBuffer, isGreeting ? { label: "greeting", uninterruptible: true } : { label: "ai_response" });
    console.log(`[LAT] ws_send_done call=${callSid} dt=${Date.now() - tWsSend}ms total=${Date.now() - t0}ms completed=${completed}`);
    
    // 初期メッセージで、事前生成された音声がない場合は保存（非同期で実行して遅延を避ける）
    if (completed && text === "お電話ありがとうございます。テックファンドです。") {
      // 非同期で保存（awaitしない）
      savePreGeneratedInitialAudio(mulawBuffer, ttsEngine, ttsVoice, speed).catch(err => {
        console.error(`[AUDIO] Error saving pre-generated audio: ${err.message}`);
      });
    }
    
    console.log(`[AUDIO] Audio response sent successfully for call ${callSid}`);
  } catch (error) {
    console.error(`[AUDIO] Error generating response for call ${callSid}: ${error.message}`);
    console.error(`[AUDIO] Error stack: ${error.stack}`);
  }
}

// HTTPサーバーの設定
app.use(express.json());

// ヘルスチェックエンドポイント
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// WebSocketアップグレード処理
server.on("upgrade", (request, socket, head) => {
  // デバッグ: アップグレードリクエストの詳細をログ出力
  console.log(`[UPGRADE-DEBUG] Upgrade request received`);
  console.log(`[UPGRADE-DEBUG] Request URL: ${request.url}`);
  console.log(`[UPGRADE-DEBUG] Request headers: ${JSON.stringify(request.headers)}`);
  
  // URLを構築（クエリパラメータを含む）
  const fullUrl = request.url || "/";
  const url = new URL(fullUrl, `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;
  
  console.log(`[UPGRADE-DEBUG] Parsed pathname: ${pathname}`);
  console.log(`[UPGRADE-DEBUG] Parsed search: ${url.search}`);
  console.log(`[UPGRADE-DEBUG] Full URL: ${url.toString()}`);
  
  if (pathname === "/streams") {
    // requestオブジェクトに完全なURLを設定（クエリパラメータを含む）
    // wsライブラリがreq.urlを使用するため、完全なURLを保持する
    const originalUrl = request.url;
    request.url = url.toString().replace(`http://${request.headers.host}`, "");
    
    console.log(`[UPGRADE-DEBUG] Modified request.url: ${request.url}`);
    
    wss.handleUpgrade(request, socket, head, (ws) => {
      // 元のURLを復元
      request.url = originalUrl;
      wss.emit("connection", ws, request);
    });
  } else {
    console.log(`[UPGRADE-DEBUG] Pathname ${pathname} does not match /streams, destroying socket`);
    socket.destroy();
  }
});

// サーバー起動
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("WebSocket server ready for connections");
  console.log("Available endpoints: /health, /streams");
  console.log(`Environment: ${JSON.stringify({
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || "not set",
    AUDIO_BUCKET: process.env.AUDIO_BUCKET || "not set",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "SET" : "not set",
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? "SET" : "not set",
    ADD_BACKGROUND_NOISE: process.env.ADD_BACKGROUND_NOISE || "false",
  })}`);
  console.log("Server started successfully");

  // 起動時にデフォルトの初期挨拶音声をプリロード（存在すれば）
  // これにより接続直後の初期挨拶はGCSダウンロード無しで即送信できる
  primePreGeneratedInitialAudioCache("openai", "echo", 1.3).catch(() => {});

  // 起動時にデフォルトの相槌音声もプリロード（存在すれば）
  primePreGeneratedFillerAudioCache("openai", "echo", 1.3).catch(() => {});
});
