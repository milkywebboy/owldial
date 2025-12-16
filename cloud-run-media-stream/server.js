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
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
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
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

// WebSocketサーバー
const wss = new WebSocket.Server({ noServer: true });

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
  console.log(`[WS-AUDIO] Starting audio send via WebSocket for call ${session.callSid}`);
  
  // WebSocket接続状態の検証
  if (!session || !session.ws) {
    console.error(`[WS-AUDIO] WebSocket session not found for call ${session.callSid}`);
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

  // 音声送信開始フラグを設定
  session.isSendingAudio = true;
  session.shouldStopAudio = false;

  // チャンクサイズ（Twilioの推奨: 約160バイト = 20ms分の音声）
  // mu-law形式は8000Hzなので、160バイト = 20ms
  const chunkSize = 160;
  const totalChunks = Math.ceil(mulawBuffer.length / chunkSize);

  console.log(`[WS-AUDIO] Sending audio via WebSocket: ${totalChunks} chunks, total size: ${mulawBuffer.length} bytes`);

  let sentChunks = 0;
  let wasInterrupted = false;

  // 音声データをバイナリチャンクに分割して送信
  for (let i = 0; i < totalChunks; i++) {
    // 中断フラグをチェック
    if (session.shouldStopAudio) {
      console.log(`[WS-AUDIO] Audio sending interrupted by caller for call ${session.callSid} at chunk ${i}/${totalChunks}`);
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
    
    // 送信レートを制御（20msごとに送信）
    if (i < totalChunks - 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  // 音声送信完了フラグをリセット
  session.isSendingAudio = false;
  session.shouldStopAudio = false;

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

  return !wasInterrupted;
}

// 受信した音声を処理（Whisperで転写して返答を生成）
async function processIncomingAudio(session) {
  const callSid = session.callSid;
  
  if (session.processingIncomingAudio || session.incomingAudioBuffer.length === 0) {
    return;
  }
  
  session.processingIncomingAudio = true;
  console.log(`[AUDIO-IN] Processing incoming audio for call ${callSid}, buffer size: ${session.incomingAudioBuffer.length}`);
  
  try {
    // バッファに蓄積された音声データを結合
    const combinedAudio = Buffer.concat(session.incomingAudioBuffer);
    session.incomingAudioBuffer = []; // バッファをクリア
    
    // mu-law形式の音声をWAV形式に変換（Whisper用）
    const timestamp = Date.now();
    const inputFile = `/tmp/incoming_${timestamp}.ulaw`;
    const outputFile = `/tmp/incoming_${timestamp}.wav`;
    
    fs.writeFileSync(inputFile, combinedAudio);
    
    // FFmpegでmu-lawをWAVに変換
    const ffmpegCommand = `ffmpeg -f mulaw -ar 8000 -ac 1 -i ${inputFile} -ar 16000 -ac 1 -f wav ${outputFile} -y`;
    await execAsync(ffmpegCommand);
    
    const wavBuffer = fs.readFileSync(outputFile);
    
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
    
    // OpenAI APIに直接リクエストを送信
    const https = require("https");
    const transcriptionPromise = new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.openai.com",
        path: "/v1/audio/transcriptions",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
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
            resolve(result.text || "");
          } catch (error) {
            reject(error);
          }
        });
      });
      
      req.on("error", reject);
      formData.pipe(req);
    });
    
    const userMessage = await transcriptionPromise;
    console.log(`[AUDIO-IN] Transcription for call ${callSid}: ${userMessage}`);
    
    // Firestoreに会話を保存
    const callRef = db.collection("calls").doc(callSid);
    await callRef.update({
      conversations: require("firebase-admin/firestore").FieldValue.arrayUnion({
        role: "user",
        content: userMessage,
        timestamp: Timestamp.now(),
      }),
    });
    
    // ChatGPTで返答を生成
    const callDoc = await callRef.get();
    const callData = callDoc.data();
    const conversations = callData?.conversations || [];
    
    const chatResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "あなたはテックファンドの電話応対AIです。丁寧で親切な対応を心がけてください。",
        },
        ...conversations.slice(-10).map((c) => ({
          role: c.role === "user" ? "user" : "assistant",
          content: c.content,
        })),
      ],
      temperature: 0.7,
      max_tokens: 200,
    });
    
    const aiResponse = chatResponse.choices[0]?.message?.content || "";
    console.log(`[AUDIO-IN] AI response for call ${callSid}: ${aiResponse}`);
    
    // FirestoreにAI返答を保存
    await callRef.update({
      conversations: require("firebase-admin/firestore").FieldValue.arrayUnion({
        role: "assistant",
        content: aiResponse,
        timestamp: Timestamp.now(),
      }),
    });
    
    // AI返答を音声で送信
    await sendAudioResponseViaMediaStream(session, aiResponse);
    
  } catch (error) {
    console.error(`[AUDIO-IN] Error processing incoming audio for call ${callSid}: ${error.message}`);
    console.error(`[AUDIO-IN] Error stack: ${error.stack}`);
  } finally {
    session.processingIncomingAudio = false;
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

    // Firestoreから音声設定を取得（並列処理で高速化）
    // デフォルト値を使用して事前生成された音声を先に読み込む
    const defaultTtsEngine = "openai";
    const defaultTtsVoice = "echo";
    const defaultSpeed = 1.3;
    
    console.log(`[INIT-DEBUG] Loading pre-generated audio with default settings: engine=${defaultTtsEngine}, voice=${defaultTtsVoice}, speed=${defaultSpeed}`);
    
    // Firestoreから音声設定を取得（並列処理で開始）
    const callDocPromise = db.collection("calls").doc(callSid).get();
    
    // 事前生成された音声を先に読み込む（デフォルト設定）
    let mulawBuffer = await loadPreGeneratedInitialAudio(defaultTtsEngine, defaultTtsVoice, defaultSpeed);
    console.log(`[INIT-DEBUG] Pre-generated audio loaded (default): ${mulawBuffer ? `found, size=${mulawBuffer.length}` : 'not found'}`);
    
    // Firestoreの設定を取得（既に並列で開始している）
    const callDoc = await callDocPromise;
    const callData = callDoc.data();
    
    const ttsEngine = callData?.ttsEngine || defaultTtsEngine;
    const ttsVoice = callData?.ttsVoice || callData?.voice || defaultTtsVoice;
    const speed = callData?.speed || defaultSpeed;
    
    console.log(`[INIT-DEBUG] Firestore settings: engine=${ttsEngine}, voice=${ttsVoice}, speed=${speed}`);
    
    // デフォルト設定の音声がない場合、設定に基づいて事前生成された音声を読み込む
    if (!mulawBuffer && (ttsEngine !== defaultTtsEngine || ttsVoice !== defaultTtsVoice || speed !== defaultSpeed)) {
      console.log(`[INIT-DEBUG] Loading pre-generated audio with Firestore settings: engine=${ttsEngine}, voice=${ttsVoice}, speed=${speed}`);
      mulawBuffer = await loadPreGeneratedInitialAudio(ttsEngine, ttsVoice, speed);
      console.log(`[INIT-DEBUG] Pre-generated audio loaded (Firestore): ${mulawBuffer ? `found, size=${mulawBuffer.length}` : 'not found'}`);
    }
    
    if (!mulawBuffer) {
      // 事前生成された音声がない場合、リアルタイムで生成
      console.log(`[INIT] Pre-generated audio not found, generating on demand for call ${callSid}`);
      const initialMessage = "お電話ありがとうございます。テックファンドです。";
      session.initialMessageSent = true;
      await sendAudioResponseViaMediaStream(session, initialMessage);
    } else {
      // 事前生成された音声を即座に送信
      console.log(`[INIT] Using pre-generated audio for call ${callSid}, size: ${mulawBuffer.length} bytes`);
      session.initialMessageSent = true;
      await sendAudioViaWebSocket(session, mulawBuffer);
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
    };
  } else {
    console.log(`[WS] WebSocket connection established for call ${callSid}`);
    session = initializeSession(callSid, ws);
  }

  // connectedイベントの処理
  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // start/connected/stopイベントは特に詳細にログ出力
      if (message.event === "start" || message.event === "connected" || message.event === "stop") {
        console.log(`[WS-DEBUG] Received ${message.event} event: ${JSON.stringify(message)}`);
      }
      
      // すべてのWebSocketメッセージをログ出力（デバッグ用）
      console.log(`[WS-DEBUG] Received WebSocket message: ${JSON.stringify(message)}`);
      
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
      } else if (message.event === "media") {
        // 音声データを受信（相手の音声）
        const payload = message.media?.payload;
        
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
          // ただし、streamSidとstartReceivedが設定されている場合のみ
          if (!session.initialMessageSent && session.callSid && session.streamSid && session.startReceived && session.onStreamSidReady) {
            console.log(`[WS] Triggering onStreamSidReady from media event handler for call ${session.callSid}`);
            session.onStreamSidReady();
          }
        }
        
        if (payload) {
          try {
            // base64デコードしてmu-lawデータを取得
            const audioData = Buffer.from(payload, "base64");
            
            // 音声レベルを計算
                    const audioLevel = calculateAudioLevel(audioData);
                    const threshold = Number(process.env.VAD_THRESHOLD || "3"); // 0..100スケール
            
            // 音声レベルが閾値を超えた場合
            if (audioLevel > threshold) {
              const callSid = session.callSid || "unknown";
              console.log(`[WS] Caller audio detected for call ${callSid}, level: ${audioLevel.toFixed(2)}`);
              
              // AI音声送信中の場合、送信を中断
              if (session.isSendingAudio) {
                console.log(`[WS] Interrupting AI audio for call ${callSid} due to caller speech`);
                session.shouldStopAudio = true;
              }
              
              // 受信した音声データをバッファに追加
              session.incomingAudioBuffer.push(audioData);
              session.lastIncomingAudioTime = Date.now();
              
              // 音声が終了したかチェック（500ms間音声がない場合）
              if (!session.processingIncomingAudio && session.callSid) {
                setTimeout(async () => {
                  if (session.lastIncomingAudioTime && Date.now() - session.lastIncomingAudioTime > 500) {
                    await processIncomingAudio(session);
                  }
                }, 600);
              }
            }
          } catch (error) {
            const callSid = session.callSid || "unknown";
            console.error(`[WS] Error processing incoming audio for call ${callSid}: ${error.message}`);
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

  try {
    // Firestoreから音声設定を取得
    const callDoc = await db.collection("calls").doc(callSid).get();
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
      
      const response = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts-2025-12-15",
        voice: finalVoice,
        input: text,
        speed: speed,
      });
      
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
      
      audioBuffer = Buffer.from(response.audioContent || "");
      console.log(`[AUDIO] Google TTS generated for call ${callSid}, size: ${audioBuffer.length} bytes`);
    }

    // MP3をmu-law形式に変換
    const mulawBuffer = await convertMp3ToMulaw(audioBuffer);
    
    // WebSocket経由で音声を送信
    const completed = await sendAudioViaWebSocket(session, mulawBuffer);
    
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
});
