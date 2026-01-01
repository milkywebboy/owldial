import React, { useEffect, useMemo, useRef, useState } from "react";
import { muLawToPcm16, pcm16ToMuLaw } from "./audio/mulaw";
import { pcm16ToWavBlob } from "./audio/wav";
import { DEFAULT_MEDIA_STREAM_WS_BASE } from "./appConfig";
import { getApp, getApps, initializeApp } from "firebase/app";
import { doc, getFirestore, onSnapshot, Timestamp } from "firebase/firestore";
import { getFirebaseWebConfigFromEnvOrDefault } from "./firebaseConfig";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomId(prefix: string) {
  return `${prefix}${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-6)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  // chunk to avoid callstack limits（ES5 targetでも動くようにスプレッドは使わない）
  let binary = "";
  const chunk = 0x4000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    let part = "";
    for (let j = 0; j < sub.length; j++) {
      part += String.fromCharCode(sub[j]);
    }
    binary += part;
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

type ResampleState = {
  buf: Float32Array;
  pos: number;
};

function resampleTo8kLinear(input: Float32Array, inputRate: number, st: ResampleState): Int16Array {
  const targetRate = 8000;
  const ratio = inputRate / targetRate;

  // concat leftover + new input
  const prev = st.buf;
  const buf = new Float32Array(prev.length + input.length);
  buf.set(prev, 0);
  buf.set(input, prev.length);

  let pos = st.pos; // fractional index in buf
  const out: number[] = [];

  // Need at least 2 samples for interpolation
  while (pos + 1 < buf.length) {
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = buf[idx];
    const s1 = buf[idx + 1];
    const v = s0 + (s1 - s0) * frac;
    const clamped = Math.max(-1, Math.min(1, v));
    out.push((clamped < 0 ? clamped * 32768 : clamped * 32767) | 0);
    pos += ratio;
  }

  const keepFrom = Math.max(0, Math.floor(pos));
  st.buf = buf.slice(keepFrom);
  st.pos = pos - keepFrom;

  return Int16Array.from(out);
}

type SimState = {
  kind: "idle" | "preparing" | "running" | "done" | "error";
  msg: string;
};

type AssistantUtterance = {
  role?: "assistant";
  content?: string;
  label?: string;
  timestamp?: Timestamp;
};

export default function SimulateCall() {
  const [wsUrl, setWsUrl] = useState("");
  const [callSid, setCallSid] = useState(() => randomId("SIM_CALL_"));
  const [streamSid, setStreamSid] = useState(() => randomId("SIM_STREAM_"));
  const [pace, setPace] = useState(1.0);
  const [chunkBytes, setChunkBytes] = useState(160);
  const [chunkMs, setChunkMs] = useState(20);
  const [waitBeforeSpeakMs, setWaitBeforeSpeakMs] = useState(250);
  const [state, setState] = useState<SimState>({ kind: "idle", msg: "" });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileModeMessage, setFileModeMessage] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [micFrames, setMicFrames] = useState(0);
  const [lastMicAt, setLastMicAt] = useState<number | null>(null);
  const [rawPeak, setRawPeak] = useState(0);
  const [zeroFrames, setZeroFrames] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  const [micEnabled, setMicEnabled] = useState(false);
  const [sentChunks, setSentChunks] = useState(0);
  const [sentBytes, setSentBytes] = useState(0);

  const [rtInterim, setRtInterim] = useState("");
  const [rtFinal, setRtFinal] = useState<string[]>([]);
  const recognitionRef = useRef<any>(null);

  // Server-side realtime transcript (Firestore)
  const { cfg, hasProjectId } = useMemo(() => getFirebaseWebConfigFromEnvOrDefault(), []);
  const [fsRtFinal, setFsRtFinal] = useState("");
  const [fsRtInterim, setFsRtInterim] = useState("");
  const [fsAssistant, setFsAssistant] = useState<AssistantUtterance[]>([]);

  const [outboundBytes, setOutboundBytes] = useState(0);
  const [outboundChunks, setOutboundChunks] = useState(0);
  const outboundMulawRef = useRef<Uint8Array[]>([]);
  const [outWavUrl, setOutWavUrl] = useState<string | null>(null);
  const [outMulawUrl, setOutMulawUrl] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackNodeRef = useRef<ScriptProcessorNode | null>(null);
  const playbackGainRef = useRef<GainNode | null>(null);
  const playbackStateRef = useRef<{ buf: Float32Array; pos: number }>({ buf: new Float32Array(0), pos: 0 });
  const playbackStartedRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const procNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sendTimerRef = useRef<number | null>(null);
  const sendQueueRef = useRef<Uint8Array>(new Uint8Array(0));
  const resampleRef = useRef<ResampleState>({ buf: new Float32Array(0), pos: 0 });
  const levelAvgRef = useRef<number[]>([]);
  const micFramesRef = useRef(0);
  const zeroFramesRef = useRef(0);
  const recentMicPcmRef = useRef<Int16Array[]>([]);
  const deviceLoadInFlightRef = useRef(false);

  const wsUrlAuto = useMemo(() => {
    // Hosting(owldial.web.app) は WebSocket の upgrade を扱えないため、
    // デフォルトは Cloud Run(media-stream) の /streams を使う。
    const u = new URL(DEFAULT_MEDIA_STREAM_WS_BASE);
    u.searchParams.set("callSid", callSid);
    return u.toString();
  }, [callSid]);

  useEffect(() => {
    if (!hasProjectId) return;
    try {
      const app = getApps().length ? getApp() : initializeApp(cfg);
      const db = getFirestore(app);
      const ref = doc(db, "calls", callSid);
      const unsub = onSnapshot(
        ref,
        (snap) => {
          const d: any = snap.exists() ? snap.data() : {};
          setFsRtFinal(String(d?.realtimeTranscript || ""));
          setFsRtInterim(String(d?.realtimeTranscriptInterim || ""));
          setFsAssistant(Array.isArray(d?.realtimeAssistantUtterances) ? d.realtimeAssistantUtterances : []);
        },
        () => {
          // ignore (simulator should still work without Firestore)
        }
      );
      return () => unsub();
    } catch {
      // ignore
    }
  }, [callSid, cfg, hasProjectId]);

  useEffect(() => {
    // wsUrl が未入力のときだけ自動補完（手入力を上書きしない）
    setWsUrl((prev) => prev || wsUrlAuto);
  }, [wsUrlAuto]);

  async function loadDevices() {
    if (deviceLoadInFlightRef.current) return;
    deviceLoadInFlightRef.current = true;
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const list = await navigator.mediaDevices.enumerateDevices();
      const inputs = list.filter((d) => d.kind === "audioinput");
      setDevices(inputs);
      if (!selectedDeviceId && inputs[0]) {
        setSelectedDeviceId(inputs[0].deviceId);
      }
    } catch {
      // ignore
    } finally {
      deviceLoadInFlightRef.current = false;
    }
  }

  useEffect(() => {
    loadDevices();
  }, []);

  async function sendFileAsCall() {
    if (!selectedFile) {
      setFileModeMessage("音声ファイルを選択してください");
      return;
    }
    try {
      setState({ kind: "preparing", msg: "ファイルを読み込み中..." });
      const arr = await selectedFile.arrayBuffer();
      const audioCtx = new AudioContext();
      const decoded = await audioCtx.decodeAudioData(arr.slice(0));
      const channelData = decoded.getChannelData(0);
      const resampleState: ResampleState = { buf: new Float32Array(0), pos: 0 };
      const pcm16 = resampleTo8kLinear(channelData, decoded.sampleRate, resampleState);
      const mulaw = pcm16ToMuLaw(pcm16);
      await openSocketAndSend(mulaw);
      setFileModeMessage("送信が完了しました");
    } catch (e: any) {
      setFileModeMessage(`送信に失敗しました: ${e?.message || e}`);
      setState({ kind: "error", msg: String(e) });
    }
  }

  async function openSocketAndSend(mulaw: Uint8Array) {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl || wsUrlAuto);
      const localCallSid = callSid;
      const localStreamSid = streamSid;
      ws.onopen = async () => {
        try {
          ws.send(JSON.stringify({ event: "connected" }));
          ws.send(JSON.stringify({
            event: "start",
            start: { streamSid: localStreamSid, callSid: localCallSid, accountSid: "SIMULATED" },
          }));
          await sleep(waitBeforeSpeakMs);
          const totalChunks = Math.ceil(mulaw.length / chunkBytes);
          for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkBytes;
            const end = Math.min(start + chunkBytes, mulaw.length);
            const chunk = mulaw.slice(start, end);
            ws.send(JSON.stringify({
              event: "media",
              streamSid: localStreamSid,
              media: { payload: bytesToBase64(chunk), track: "inbound" },
            }));
            if (i < totalChunks - 1) {
              await sleep(Math.max(0, Math.floor(chunkMs / pace)));
            }
          }
          ws.send(JSON.stringify({ event: "stop", streamSid: localStreamSid }));
          setState({ kind: "done", msg: "送信完了" });
          ws.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      ws.onerror = (err) => reject(err);
    });
  }

  useEffect(() => {
    // unmount cleanup: refs only（state更新はしない）
    return () => {
      try {
        if (sendTimerRef.current) {
          window.clearInterval(sendTimerRef.current);
          sendTimerRef.current = null;
        }
        if (procNodeRef.current) {
          try {
            procNodeRef.current.disconnect();
          } catch {
            // ignore
          }
          procNodeRef.current.onaudioprocess = null;
          procNodeRef.current = null;
        }
        if (micStreamRef.current) {
          for (const t of micStreamRef.current.getTracks()) t.stop();
          micStreamRef.current = null;
        }
        if (captureCtxRef.current) {
          captureCtxRef.current.close().catch(() => {});
          captureCtxRef.current = null;
        }
        if (wsRef.current) {
          try {
            wsRef.current.close();
          } catch {
            // ignore
          }
          wsRef.current = null;
        }
        if (playbackCtxRef.current) {
          playbackCtxRef.current.close().catch(() => {});
          playbackCtxRef.current = null;
        }
        playbackNodeRef.current = null;
        playbackGainRef.current = null;
        playbackStateRef.current = { buf: new Float32Array(0), pos: 0 };
        playbackStartedRef.current = false;
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (outWavUrl) URL.revokeObjectURL(outWavUrl);
      if (outMulawUrl) URL.revokeObjectURL(outMulawUrl);
    };
  }, [outWavUrl, outMulawUrl]);

  async function connectWs(): Promise<WebSocket> {
    const url = new URL(wsUrl);
    if (!url.searchParams.get("callSid")) url.searchParams.set("callSid", callSid);
    const ws = new WebSocket(url.toString());
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ""));
        if (msg.event === "media" && msg.media?.payload) {
          const track = msg.media?.track;
          // サーバー送信（outbound）は通常 track がない想定。inbound はこちらが track=inbound で送る。
          if (!track) {
            const bytes = base64ToBytes(msg.media.payload);
            outboundMulawRef.current.push(bytes);
            setOutboundBytes((x) => x + bytes.length);
            setOutboundChunks((x) => x + 1);
            // リアルタイム再生（ストリーミング）
            pushOutboundMulawForPlayback(bytes);
          }
        } else if (msg.event === "mark") {
          // ignore
        }
      } catch {
        // ignore
      }
    };

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket接続に失敗しました"));
    });

    ws.send(JSON.stringify({ event: "connected" }));
    ws.send(JSON.stringify({ event: "start", start: { streamSid, callSid, accountSid: "SIMULATED" } }));
    return ws;
  }

  function appendToSendQueue(bytes: Uint8Array) {
    const prev = sendQueueRef.current;
    if (prev.length === 0) {
      sendQueueRef.current = bytes;
      return;
    }
    const merged = new Uint8Array(prev.length + bytes.length);
    merged.set(prev, 0);
    merged.set(bytes, prev.length);
    sendQueueRef.current = merged;
  }

  function takeFromSendQueue(n: number): Uint8Array | null {
    const q = sendQueueRef.current;
    if (q.length < n) return null;
    const head = q.subarray(0, n);
    const rest = q.subarray(n);
    sendQueueRef.current = rest.length ? new Uint8Array(rest) : new Uint8Array(0);
    return new Uint8Array(head);
  }

  function ensurePlaybackCtx(): AudioContext {
    if (playbackCtxRef.current) return playbackCtxRef.current;
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    playbackCtxRef.current = ctx;
    return ctx;
  }

  function ensurePlaybackStream() {
    const ctx = ensurePlaybackCtx();
    if (playbackNodeRef.current) return;

    // ScriptProcessorで連続再生（1チャンク=1ソース再生だと「ブツブツ」になりやすい）
    const node = ctx.createScriptProcessor(4096, 0, 1);
    playbackNodeRef.current = node;
    const gain = ctx.createGain();
    gain.gain.value = 1.0;
    playbackGainRef.current = gain;
    node.connect(gain);
    gain.connect(ctx.destination);

    node.onaudioprocess = (ev) => {
      const out = ev.outputBuffer.getChannelData(0);
      const st = playbackStateRef.current;
      const input = st.buf;
      const outRate = ctx.sampleRate;
      const step = 8000 / outRate; // input(8k) samples per output sample
      let pos = st.pos;

      for (let i = 0; i < out.length; i++) {
        const idx = Math.floor(pos);
        if (idx + 1 >= input.length) {
          out[i] = 0;
        } else {
          const frac = pos - idx;
          const s0 = input[idx];
          const s1 = input[idx + 1];
          out[i] = s0 + (s1 - s0) * frac;
        }
        pos += step;
      }

      const keepFrom = Math.max(0, Math.floor(pos));
      if (keepFrom > 0) {
        st.buf = input.slice(keepFrom);
        pos = pos - keepFrom;
      }
      st.pos = pos;
    };

    playbackStartedRef.current = true;
  }

  function saveRecentMicWav() {
    try {
      const chunks = recentMicPcmRef.current.flatMap((arr) => Array.from(arr));
      if (!chunks.length) {
        alert("最近のマイクPCMがありません");
        return;
      }
      const pcm = Int16Array.from(chunks);
      const wavBlob = pcm16ToWavBlob(pcm, 8000);
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "recent-mic.wav";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function pushOutboundMulawForPlayback(mulaw: Uint8Array) {
    ensurePlaybackStream();
    const pcm = muLawToPcm16(mulaw);
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) floats[i] = Math.max(-1, Math.min(1, pcm[i] / 32768));

    const st = playbackStateRef.current;
    const prev = st.buf;
    const merged = new Float32Array(prev.length + floats.length);
    merged.set(prev, 0);
    merged.set(floats, prev.length);
    st.buf = merged;
  }

  async function startMic() {
    if (micEnabled) return;
    setMicError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicError("このブラウザ/環境ではマイクを利用できません");
      setState({ kind: "error", msg: "マイク非対応環境です" });
      return;
    }
    setState({ kind: "preparing", msg: "マイク許可をリクエスト中…" });
    setSentBytes(0);
    setSentChunks(0);
    setOutboundBytes(0);
    setOutboundChunks(0);
    outboundMulawRef.current = [];
    sendQueueRef.current = new Uint8Array(0);
    resampleRef.current = { buf: new Float32Array(0), pos: 0 };
    playbackStateRef.current = { buf: new Float32Array(0), pos: 0 };
    levelAvgRef.current = [];
    micFramesRef.current = 0;
    zeroFramesRef.current = 0;
    recentMicPcmRef.current = [];
    setMicFrames(0);
    setLastMicAt(null);
    setRawPeak(0);
    setZeroFrames(0);

    if (outWavUrl) URL.revokeObjectURL(outWavUrl);
    if (outMulawUrl) URL.revokeObjectURL(outMulawUrl);
    setOutWavUrl(null);
    setOutMulawUrl(null);

    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      micStreamRef.current = stream;

      const captureCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      captureCtxRef.current = captureCtx;
      try {
        await captureCtx.resume();
      } catch {
        // ignore
      }

      // Playback context init (so first audio starts quickly)
      ensurePlaybackCtx();
      ensurePlaybackStream();
      try {
        await playbackCtxRef.current?.resume();
      } catch {
        // ignore
      }

      setState({ kind: "preparing", msg: "WebSocket接続中…" });
      await connectWs();
      setState({ kind: "running", msg: "マイク送信中（ヘッドホン推奨）" });
      startRealtimeRecognition();

      const src = captureCtx.createMediaStreamSource(stream);
      const proc = captureCtx.createScriptProcessor(4096, 1, 1);
      procNodeRef.current = proc;

      proc.onaudioprocess = (ev) => {
        try {
          const input = ev.inputBuffer.getChannelData(0);
          let peakRaw = 0;
          for (let i = 0; i < input.length; i++) {
            const v = Math.abs(input[i]);
            if (v > peakRaw) peakRaw = v;
          }
          setRawPeak(Math.min(1, peakRaw));
          const pcm8k = resampleTo8kLinear(input, captureCtx.sampleRate, resampleRef.current);
          if (!pcm8k.length) return;
          // meter from resampled PCM (same data as送信)
          let peak = 0;
          for (let i = 0; i < pcm8k.length; i++) {
            const v = Math.abs(pcm8k[i]) / 32768;
            if (v > peak) peak = v;
          }
          levelAvgRef.current.push(peak);
          if (levelAvgRef.current.length > 8) levelAvgRef.current.shift();
          const avg = levelAvgRef.current.reduce((a, b) => a + b, 0) / levelAvgRef.current.length;
          setAudioLevel(Math.min(1, avg));
          micFramesRef.current += 1;
          recentMicPcmRef.current.push(Int16Array.from(pcm8k));
          const keep = 50; // ~1s if chunkMs=20
          if (recentMicPcmRef.current.length > keep) recentMicPcmRef.current.shift();
          if (peak < 0.0005) {
            zeroFramesRef.current += 1;
            if (zeroFramesRef.current % 10 === 0) setZeroFrames(zeroFramesRef.current);
          }
          if (micFramesRef.current % 5 === 0) {
            setMicFrames(micFramesRef.current);
            setLastMicAt(Date.now());
          }

          const mulaw = pcm16ToMuLaw(pcm8k);
          appendToSendQueue(mulaw);
        } catch {
          // ignore
        }
      };

      src.connect(proc);
      // Connect to destination with zero gain to keep node alive without audible feedback
      const zero = captureCtx.createGain();
      zero.gain.value = 0;
      proc.connect(zero);
      zero.connect(captureCtx.destination);

      const tick = Math.max(5, chunkMs);
      sendTimerRef.current = window.setInterval(() => {
        try {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
          const chunk = takeFromSendQueue(chunkBytes);
          if (!chunk) return;
          wsRef.current.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: bytesToBase64(chunk), track: "inbound" },
            })
          );
          setSentChunks((x) => x + 1);
          setSentBytes((x) => x + chunk.length);
        } catch {
          // ignore
        }
      }, tick);

      setMicEnabled(true);
    } catch (e: any) {
      await stopMic();
      const msg = e?.name === "NotAllowedError"
        ? "マイク利用が拒否されました。ブラウザの権限を確認してください。"
        : e?.message || "開始できません";
      setMicError(msg);
      setState({ kind: "error", msg });
      loadDevices().catch(() => {});
    }
  }

  async function stopMic() {
    stopRealtimeRecognition();
    if (sendTimerRef.current) {
      window.clearInterval(sendTimerRef.current);
      sendTimerRef.current = null;
    }
    if (procNodeRef.current) {
      try {
        procNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      procNodeRef.current.onaudioprocess = null;
      procNodeRef.current = null;
    }
    if (micStreamRef.current) {
      for (const t of micStreamRef.current.getTracks()) t.stop();
      micStreamRef.current = null;
    }
    if (captureCtxRef.current) {
      try {
        await captureCtxRef.current.close();
      } catch {
        // ignore
      }
      captureCtxRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ event: "stop", streamSid }));
      } catch {
        // ignore
      }
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
    }
    wsRef.current = null;
    setMicEnabled(false);
    setState({ kind: "done", msg: "停止しました" });

    // outbound保存リンク作成（セッション中に受け取った分）
    const merged = mergeChunks(outboundMulawRef.current);
    if (merged.length > 0) {
      const pcmOut = muLawToPcm16(merged);
      const wavBlob = pcm16ToWavBlob(pcmOut, 8000);
      setOutWavUrl(URL.createObjectURL(wavBlob));
      setOutMulawUrl(URL.createObjectURL(new Blob([merged], { type: "application/octet-stream" })));
    }
  }

  function startRealtimeRecognition() {
    // Browser native speech recognition (Chrome/Edge). Best-effort.
    try {
      const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) return;
      const rec = new SR();
      recognitionRef.current = rec;
      rec.lang = "ja-JP";
      rec.interimResults = true;
      rec.continuous = true;
      setRtInterim("");
      setRtFinal([]);

      rec.onresult = (event: any) => {
        try {
          let interim = "";
          const finals: string[] = [];
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const r = event.results[i];
            const txt = (r[0]?.transcript || "").trim();
            if (!txt) continue;
            if (r.isFinal) finals.push(txt);
            else interim += (interim ? " " : "") + txt;
          }
          if (finals.length) setRtFinal((prev) => [...prev, ...finals].slice(-30));
          setRtInterim(interim);
        } catch {
          // ignore
        }
      };
      rec.onerror = () => {
        // ignore（環境によっては頻繁に出る）
      };
      rec.onend = () => {
        // continuousでも勝手に止まることがあるので、通話中なら再開
        if (micEnabled) {
          try {
            rec.start();
          } catch {
            // ignore
          }
        }
      };
      rec.start();
    } catch {
      // ignore
    }
  }

  function stopRealtimeRecognition() {
    try {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      if (rec) rec.stop();
    } catch {
      // ignore
    }
    setRtInterim("");
  }

  return (
    <div className="sim">
      <div className="panelHeader">
        <div className="panelTitle">疑似電話（ブラウザ）</div>
        <div className="panelMeta">マイクをリアルタイムに Twilio Media Streams互換WS（/streams）へ送信します</div>
      </div>

      <div className="simBody">
        <div className="simGrid">
          <label className="simField">
            <div className="simLabel">WebSocket URL</div>
            <input className="simInput" value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} />
            <div className="simHelp">例: `wss://media-stream-...a.run.app/streams?callSid=...`（HostingドメインはWS不可）</div>
          </label>

          <label className="simField">
            <div className="simLabel">callSid</div>
            <input className="simInput mono" value={callSid} onChange={(e) => setCallSid(e.target.value)} />
          </label>

          <label className="simField">
            <div className="simLabel">streamSid</div>
            <input className="simInput mono" value={streamSid} onChange={(e) => setStreamSid(e.target.value)} />
          </label>

          <label className="simField">
            <div className="simLabel">マイクデバイス</div>
            <div className="deviceRow">
              <select
                className="simInput"
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
              >
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `input ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
                {!devices.length ? <option value="">(取得できませんでした)</option> : null}
              </select>
              <button className="simBtn inlineBtn" onClick={() => loadDevices()}>
                再取得
              </button>
            </div>
            <div className="simHelp">※権限許可後にデバイス名が表示されます</div>
          </label>

          <div className="simRow">
            <label className="simField">
              <div className="simLabel">chunkBytes</div>
              <input
                className="simInput"
                type="number"
                value={chunkBytes}
                onChange={(e) => setChunkBytes(Number(e.target.value))}
                min={80}
                step={1}
              />
              <div className="simHelp">推奨: 160（20ms @ 8k mulaw）</div>
            </label>
            <label className="simField">
              <div className="simLabel">chunkMs</div>
              <input
                className="simInput"
                type="number"
                value={chunkMs}
                onChange={(e) => setChunkMs(Number(e.target.value))}
                min={5}
                step={1}
              />
            </label>
            <label className="simField">
              <div className="simLabel">pace</div>
              <input
                className="simInput"
                type="number"
                value={pace}
                onChange={(e) => setPace(Number(e.target.value))}
                min={0.1}
                step={0.1}
              />
              <div className="simHelp">1.0=実時間, 2.0=2倍速</div>
            </label>
            <label className="simField">
              <div className="simLabel">waitBeforeSpeakMs</div>
              <input
                className="simInput"
                type="number"
                value={waitBeforeSpeakMs}
                onChange={(e) => setWaitBeforeSpeakMs(Number(e.target.value))}
                min={0}
                step={50}
              />
            </label>
          </div>

          <div className="simHelp">
            - **マイク権限が必要**です（初回はブラウザが確認を出します）<br />
            - **スピーカーだと回り込み**で誤検知しやすいので、できればヘッドホン推奨です
          </div>
        </div>

        <div className="simActions">
          <div className="simActionRow">
            <button className="simBtn" onClick={() => startMic()} disabled={micEnabled || state.kind === "preparing"}>
              マイクで開始
            </button>
            <button className="simBtn" onClick={() => stopMic()} disabled={!micEnabled}>
              停止
            </button>
          </div>
          <div className="simStatus">
            <span className={`simPill ${state.kind}`}>{state.kind}</span>
            <span className="muted">{state.msg}</span>
            {micError ? <div className="danger">{micError}</div> : null}
          </div>
        </div>

        <div className="panelDivider" />

        <div className="panelTitle">音声ファイル送信</div>
        <div className="simGrid">
          <label className="simField">
            <div className="simLabel">音声ファイル (wav/mp3等)</div>
            <input
              className="simInput"
              type="file"
              accept="audio/*"
              onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
            />
          </label>
          <button className="simBtn" onClick={sendFileAsCall} disabled={!selectedFile}>
            選択ファイルを送信
          </button>
          {fileModeMessage ? <div className="muted">{fileModeMessage}</div> : null}
        </div>

        <div className="panelDivider" />

        <div className="simResults">
          <div className="panelTitle">送受信</div>
          <div className="muted">sent chunks={sentChunks} / bytes={sentBytes}</div>
          <div className="muted">
            outbound chunks={outboundChunks} / bytes={outboundBytes}
          </div>
          <div className="muted micLevel">
            mic level <span className="mono">{(audioLevel * 100).toFixed(0)}%</span>
            <div className="levelBar">
              <div className="levelFill" style={{ width: `${Math.min(100, audioLevel * 100)}%` }} />
            </div>
            <div className="muted">
              mic frames={micFrames} {lastMicAt ? `(last ${(Date.now() - lastMicAt) / 1000}s ago)` : ""}
            </div>
            <div className="muted">
              raw peak={(rawPeak * 100).toFixed(1)}% / near-zero frames={zeroFrames}
              <button className="simBtn inlineBtn" onClick={saveRecentMicWav}>最近のマイク音声を保存</button>
            </div>
          </div>

          <div className="panelDivider" />
          <div className="panelTitle">リアルタイム文字起こし（ブラウザ）</div>
          <div className="muted">※Chrome/Edgeで動作。AIに渡すWhisperとは別系統の“表示用”です。</div>
          <div className="chat">
            {rtFinal.map((t, idx) => (
              <div key={idx} className="msg user">
                <div className="msgRole">user (rt)</div>
                <div className="msgText">{t}</div>
              </div>
            ))}
            {rtInterim ? (
              <div className="msg user">
                <div className="msgRole">user (rt interim)</div>
                <div className="msgText">{rtInterim}</div>
              </div>
            ) : null}
            {!rtFinal.length && !rtInterim ? <div className="empty">まだありません</div> : null}
          </div>

          <div className="panelDivider" />
          <div className="panelTitle">リアルタイム文字起こし（サーバ/Firestore：顧客 + AI）</div>
          <div className="muted">※通話サーバ側で生成した転写/相槌/返答のリアルタイム表示です。</div>
          <div className="chat">
            {fsRtFinal ? (
              <div className="msg user">
                <div className="msgRole">user (server final)</div>
                <div className="msgText">{fsRtFinal}</div>
              </div>
            ) : null}
            {fsRtInterim ? (
              <div className="msg user">
                <div className="msgRole">user (server interim)</div>
                <div className="msgText">{fsRtInterim}</div>
              </div>
            ) : null}
            {fsAssistant.slice(-30).map((m, idx) => (
              <div key={idx} className="msg assistant">
                <div className="msgRole">{`assistant (server${m.label ? `:${m.label}` : ""})`}</div>
                <div className="msgText">{m.content || ""}</div>
              </div>
            ))}
            {!fsRtFinal && !fsRtInterim && fsAssistant.length === 0 ? <div className="empty">まだありません</div> : null}
          </div>

          {outWavUrl ? (
            <div className="simAudio">
              <audio controls src={outWavUrl} />
              <div className="simDownloads">
                <a className="simLink" href={outWavUrl} download={`outbound-${callSid}.wav`}>
                  WAVを保存
                </a>
                {outMulawUrl ? (
                  <a className="simLink" href={outMulawUrl} download={`outbound-${callSid}.ulaw`}>
                    μ-law(raw)を保存
                  </a>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="muted">まだ受信音声がありません</div>
          )}
        </div>
      </div>
    </div>
  );
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
