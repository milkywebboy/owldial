import React, { useEffect, useMemo, useRef, useState } from "react";
import { muLawToPcm16, pcm16ToMuLaw } from "./audio/mulaw";
import { pcm16ToWavBlob } from "./audio/wav";
import { DEFAULT_MEDIA_STREAM_WS_BASE } from "./appConfig";

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

export default function SimulateCall() {
  const [wsUrl, setWsUrl] = useState("");
  const [callSid, setCallSid] = useState(() => randomId("SIM_CALL_"));
  const [streamSid, setStreamSid] = useState(() => randomId("SIM_STREAM_"));
  const [pace, setPace] = useState(1.0);
  const [chunkBytes, setChunkBytes] = useState(160);
  const [chunkMs, setChunkMs] = useState(20);
  const [waitBeforeSpeakMs, setWaitBeforeSpeakMs] = useState(250);
  const [state, setState] = useState<SimState>({ kind: "idle", msg: "" });

  const [micEnabled, setMicEnabled] = useState(false);
  const [sentChunks, setSentChunks] = useState(0);
  const [sentBytes, setSentBytes] = useState(0);

  const [rtInterim, setRtInterim] = useState("");
  const [rtFinal, setRtFinal] = useState<string[]>([]);
  const recognitionRef = useRef<any>(null);

  const [outboundBytes, setOutboundBytes] = useState(0);
  const [outboundChunks, setOutboundChunks] = useState(0);
  const outboundMulawRef = useRef<Uint8Array[]>([]);
  const [outWavUrl, setOutWavUrl] = useState<string | null>(null);
  const [outMulawUrl, setOutMulawUrl] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const procNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sendTimerRef = useRef<number | null>(null);
  const sendQueueRef = useRef<Uint8Array>(new Uint8Array(0));
  const resampleRef = useRef<ResampleState>({ buf: new Float32Array(0), pos: 0 });
  const playAtRef = useRef<number>(0);

  const wsUrlAuto = useMemo(() => {
    // Hosting(owldial.web.app) は WebSocket の upgrade を扱えないため、
    // デフォルトは Cloud Run(media-stream) の /streams を使う。
    const u = new URL(DEFAULT_MEDIA_STREAM_WS_BASE);
    u.searchParams.set("callSid", callSid);
    return u.toString();
  }, [callSid]);

  useEffect(() => {
    // wsUrl が未入力のときだけ自動補完（手入力を上書きしない）
    setWsUrl((prev) => prev || wsUrlAuto);
  }, [wsUrlAuto]);

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
            // リアルタイム再生
            playOutboundMulaw(bytes);
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
    playAtRef.current = 0;
    return ctx;
  }

  function playOutboundMulaw(mulaw: Uint8Array) {
    const ctx = ensurePlaybackCtx();
    const pcm = muLawToPcm16(mulaw);
    const buf = ctx.createBuffer(1, pcm.length, 8000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = Math.max(-1, Math.min(1, pcm[i] / 32768));

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    const startAt = Math.max(playAtRef.current || now, now + 0.05);
    src.start(startAt);
    playAtRef.current = startAt + buf.duration;
  }

  async function startMic() {
    if (micEnabled) return;
    setState({ kind: "preparing", msg: "マイク許可をリクエスト中…" });
    setSentBytes(0);
    setSentChunks(0);
    setOutboundBytes(0);
    setOutboundChunks(0);
    outboundMulawRef.current = [];
    sendQueueRef.current = new Uint8Array(0);
    resampleRef.current = { buf: new Float32Array(0), pos: 0 };
    playAtRef.current = 0;

    if (outWavUrl) URL.revokeObjectURL(outWavUrl);
    if (outMulawUrl) URL.revokeObjectURL(outMulawUrl);
    setOutWavUrl(null);
    setOutMulawUrl(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as any,
      });
      micStreamRef.current = stream;

      const captureCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      captureCtxRef.current = captureCtx;

      // Playback context init (so first audio starts quickly)
      ensurePlaybackCtx();

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
          const pcm8k = resampleTo8kLinear(input, captureCtx.sampleRate, resampleRef.current);
          if (!pcm8k.length) return;
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
      setState({ kind: "error", msg: e?.message ? `開始できません: ${e.message}` : "開始できません" });
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
          </div>
        </div>

        <div className="panelDivider" />

        <div className="simResults">
          <div className="panelTitle">送受信</div>
          <div className="muted">sent chunks={sentChunks} / bytes={sentBytes}</div>
          <div className="muted">
            outbound chunks={outboundChunks} / bytes={outboundBytes}
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


