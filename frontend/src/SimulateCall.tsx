import React, { useEffect, useMemo, useRef, useState } from "react";
import { muLawToPcm16, pcm16ToMuLaw } from "./audio/mulaw";
import { pcm16ToWavBlob } from "./audio/wav";

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

async function decodeAndResampleTo8kMono(file: File): Promise<Int16Array> {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));

  // Resample with OfflineAudioContext to 8000Hz, mono
  const targetRate = 8000;
  const length = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, length, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  try {
    await audioCtx.close();
  } catch {
    // ignore
  }

  const ch0 = rendered.getChannelData(0);
  const pcm16 = new Int16Array(ch0.length);
  for (let i = 0; i < ch0.length; i++) {
    const v = Math.max(-1, Math.min(1, ch0[i]));
    pcm16[i] = (v < 0 ? v * 32768 : v * 32767) | 0;
  }
  return pcm16;
}

type SimState =
  | { kind: "idle" }
  | { kind: "preparing"; msg: string }
  | { kind: "running"; msg: string }
  | { kind: "done"; msg: string }
  | { kind: "error"; msg: string };

export default function SimulateCall() {
  const [wsUrl, setWsUrl] = useState("");
  const [callSid, setCallSid] = useState(() => randomId("SIM_CALL_"));
  const [streamSid, setStreamSid] = useState(() => randomId("SIM_STREAM_"));
  const [pace, setPace] = useState(1.0);
  const [chunkBytes, setChunkBytes] = useState(160);
  const [chunkMs, setChunkMs] = useState(20);
  const [waitBeforeSpeakMs, setWaitBeforeSpeakMs] = useState(250);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<SimState>({ kind: "idle" });

  const [outboundBytes, setOutboundBytes] = useState(0);
  const [outboundChunks, setOutboundChunks] = useState(0);
  const outboundMulawRef = useRef<Uint8Array[]>([]);
  const [outWavUrl, setOutWavUrl] = useState<string | null>(null);
  const [outMulawUrl, setOutMulawUrl] = useState<string | null>(null);

  const wsUrlAuto = useMemo(() => {
    // フロントと同一ドメインでリバプロしている場合はこれで動く。違う場合は手入力でOK。
    const u = new URL(window.location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/streams";
    u.search = "";
    u.searchParams.set("callSid", callSid);
    return u.toString();
  }, [callSid]);

  useEffect(() => {
    // wsUrl が未入力のときだけ自動補完（手入力を上書きしない）
    setWsUrl((prev) => prev || wsUrlAuto);
  }, [wsUrlAuto]);

  useEffect(() => {
    return () => {
      if (outWavUrl) URL.revokeObjectURL(outWavUrl);
      if (outMulawUrl) URL.revokeObjectURL(outMulawUrl);
    };
  }, [outWavUrl, outMulawUrl]);

  async function run() {
    if (!file) {
      setState({ kind: "error", msg: "入力音声ファイルを選択してください" });
      return;
    }
    setState({ kind: "preparing", msg: "音声を8kHz/monoに変換中…" });
    setOutboundBytes(0);
    setOutboundChunks(0);
    outboundMulawRef.current = [];
    if (outWavUrl) URL.revokeObjectURL(outWavUrl);
    if (outMulawUrl) URL.revokeObjectURL(outMulawUrl);
    setOutWavUrl(null);
    setOutMulawUrl(null);

    // Inbound: File -> PCM16 -> mulaw
    const pcm16 = await decodeAndResampleTo8kMono(file);
    const inboundMulaw = pcm16ToMuLaw(pcm16);
    const totalSeconds = inboundMulaw.length / 8000;

    setState({ kind: "preparing", msg: `WS接続中…（inbound 約${totalSeconds.toFixed(2)}秒）` });

    const url = new URL(wsUrl);
    if (!url.searchParams.get("callSid")) url.searchParams.set("callSid", callSid);

    const ws = new WebSocket(url.toString());

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
          }
        }
      } catch {
        // ignore
      }
    };

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket接続に失敗しました"));
    });

    setState({ kind: "running", msg: "connected/start を送信…" });
    ws.send(JSON.stringify({ event: "connected" }));
    ws.send(
      JSON.stringify({
        event: "start",
        start: { streamSid, callSid, accountSid: "SIMULATED" },
      })
    );

    await sleep(waitBeforeSpeakMs);

    const totalChunks = Math.ceil(inboundMulaw.length / chunkBytes);
    setState({ kind: "running", msg: `inbound送信中… chunks=${totalChunks}` });

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkBytes;
      const end = Math.min(start + chunkBytes, inboundMulaw.length);
      const chunk = inboundMulaw.subarray(start, end);
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: bytesToBase64(chunk), track: "inbound" },
        })
      );
      if (i < totalChunks - 1) {
        await sleep(Math.max(0, Math.floor(chunkMs / pace)));
      }
    }

    ws.send(JSON.stringify({ event: "stop", streamSid }));
    setState({ kind: "running", msg: "stop送信。outbound受信待ち…" });
    await sleep(1500);
    ws.close();

    const merged = mergeChunks(outboundMulawRef.current);
    if (merged.length > 0) {
      const pcmOut = muLawToPcm16(merged);
      const wavBlob = pcm16ToWavBlob(pcmOut, 8000);
      const wavUrl = URL.createObjectURL(wavBlob);
      setOutWavUrl(wavUrl);

      const mulawBlob = new Blob([merged], { type: "application/octet-stream" });
      const mulawUrl = URL.createObjectURL(mulawBlob);
      setOutMulawUrl(mulawUrl);
    }

    setState({ kind: "done", msg: "完了" });
  }

  return (
    <div className="sim">
      <div className="panelHeader">
        <div className="panelTitle">疑似電話（ブラウザ）</div>
        <div className="panelMeta">Twilio Media Streams互換WSに音声ファイルを流し込みます</div>
      </div>

      <div className="simBody">
        <div className="simGrid">
          <label className="simField">
            <div className="simLabel">WebSocket URL</div>
            <input className="simInput" value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} />
            <div className="simHelp">例: `wss://.../streams?callSid=...`（httpsページからは wss 推奨）</div>
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

          <label className="simField">
            <div className="simLabel">入力音声ファイル</div>
            <input
              className="simInput"
              type="file"
              accept="audio/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            <div className="simHelp">任意の音声（wav/mp3等）→ブラウザで8kHz/monoへ変換して送ります</div>
          </label>
        </div>

        <div className="simActions">
          <button className="simBtn" onClick={run} disabled={state.kind === "preparing" || state.kind === "running"}>
            送信してテスト
          </button>
          <div className="simStatus">
            <span className={`simPill ${state.kind}`}>{state.kind}</span>
            <span className="muted">{state.msg}</span>
          </div>
        </div>

        <div className="panelDivider" />

        <div className="simResults">
          <div className="panelTitle">受信（outbound）</div>
          <div className="muted">
            chunks={outboundChunks} / bytes={outboundBytes}
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


