#!/usr/bin/env node
/**
 * 疑似電話（Twilio Media Streams 互換）:
 * - 音声ファイルを ffmpeg で 8kHz / mono / mu-law(raw) に変換
 * - WebSocket (/streams) に connected/start/media/stop を送る
 * - サーバーからの outbound audio (event=media) を out.ulaw に保存（任意）
 *
 * 例:
 *   node simulate-call.js --ws ws://localhost:8080/streams --in ./samples/user.wav --out ./out.ulaw
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomId(prefix) {
  return `${prefix}${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-6)}`;
}

async function ffmpegToMulawBuffer(inputPath) {
  return await new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-ac", "1",
      "-ar", "8000",
      "-f", "mulaw",
      "-acodec", "pcm_mulaw",
      "pipe:1",
    ];
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg failed (code=${code}): ${stderr.trim()}`));
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function maybeRenderMulawToWav(mulawPath, wavPath) {
  await new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "mulaw",
      "-ar", "8000",
      "-ac", "1",
      "-i", mulawPath,
      wavPath,
    ];
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg render failed (code=${code}): ${stderr.trim()}`));
      resolve();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  const wsUrlRaw = String(args.ws || "ws://localhost:8080/streams");
  const input = args.in ? String(args.in) : "";
  if (!input) {
    console.error("Usage: node simulate-call.js --ws ws://host:port/streams --in ./input.wav [--out ./out.ulaw] [--pace 1.0]");
    process.exit(2);
  }

  const wsUrl = new URL(wsUrlRaw);
  const callSid = String(args.callSid || randomId("SIM_CALL_"));
  const streamSid = String(args.streamSid || randomId("SIM_STREAM_"));
  const outPath = args.out ? String(args.out) : "";
  const renderWav = Boolean(args.renderWav);
  const outWavPath = args.outWav ? String(args.outWav) : (outPath ? outPath.replace(/\.ulaw$/i, ".wav") : "");

  const chunkMs = Number(args.chunkMs || "20");
  const chunkBytes = Number(args.chunkBytes || "160"); // Twilio推奨: 160 bytes = 20ms @ 8k mulaw
  const pace = Number(args.pace || "1.0"); // 1.0=実時間, 2.0=2倍速
  const waitBeforeSpeakMs = Number(args.waitBeforeSpeakMs || "250");

  if (!wsUrl.searchParams.get("callSid")) {
    wsUrl.searchParams.set("callSid", callSid);
  }

  const absIn = path.resolve(process.cwd(), input);
  if (!fs.existsSync(absIn)) {
    console.error(`Input not found: ${absIn}`);
    process.exit(2);
  }

  console.log(`[SIM] ws=${wsUrl.toString()}`);
  console.log(`[SIM] callSid=${callSid} streamSid=${streamSid}`);
  console.log(`[SIM] reading input=${absIn}`);

  const mulaw = await ffmpegToMulawBuffer(absIn);
  console.log(`[SIM] input converted to mulaw bytes=${mulaw.length} (~${(mulaw.length / 8000).toFixed(2)}s)`);

  let outFd = null;
  if (outPath) {
    const absOut = path.resolve(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    outFd = fs.openSync(absOut, "w");
    console.log(`[SIM] outbound audio will be saved: ${absOut}`);
  }

  let receivedBytes = 0;
  let receivedChunks = 0;

  const ws = new WebSocket(wsUrl.toString());

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "media" && msg.media?.payload) {
        // サーバー送信（outbound）は track を付けていない想定。こちらが送る inbound は track=inbound。
        const track = msg.media?.track;
        if (!track) {
          const buf = Buffer.from(msg.media.payload, "base64");
          receivedBytes += buf.length;
          receivedChunks += 1;
          if (outFd) fs.writeSync(outFd, buf);
          if (receivedChunks % 200 === 0) {
            console.log(`[SIM] outbound received chunks=${receivedChunks} bytes=${receivedBytes}`);
          }
        }
      } else if (msg.event === "mark") {
        console.log(`[SIM] mark: ${msg.mark?.name || "unknown"}`);
      }
    } catch (e) {
      console.warn(`[SIM] failed to parse message: ${e.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  // Twilio互換のイベント順序で送る
  ws.send(JSON.stringify({ event: "connected" }));
  ws.send(JSON.stringify({
    event: "start",
    start: {
      streamSid,
      callSid,
      accountSid: "SIMULATED",
    },
  }));

  console.log(`[SIM] sent connected/start. waitBeforeSpeakMs=${waitBeforeSpeakMs}`);
  await sleep(waitBeforeSpeakMs);

  const totalChunks = Math.ceil(mulaw.length / chunkBytes);
  console.log(`[SIM] sending inbound media chunks=${totalChunks} chunkBytes=${chunkBytes} pace=${pace}`);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkBytes;
    const end = Math.min(start + chunkBytes, mulaw.length);
    const chunk = mulaw.slice(start, end);
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: {
        payload: chunk.toString("base64"),
        track: "inbound",
      },
    }));
    if (i < totalChunks - 1) {
      await sleep(Math.max(0, Math.floor(chunkMs / pace)));
    }
  }

  ws.send(JSON.stringify({ event: "stop", streamSid }));
  console.log("[SIM] sent stop; waiting a bit for outbound audio...");
  await sleep(1500);

  ws.close();
  await new Promise((resolve) => ws.on("close", resolve));

  if (outFd) {
    fs.closeSync(outFd);
    console.log(`[SIM] outbound saved. receivedBytes=${receivedBytes} receivedChunks=${receivedChunks}`);
    if (renderWav && outPath && outWavPath) {
      const absOut = path.resolve(process.cwd(), outPath);
      const absWav = path.resolve(process.cwd(), outWavPath);
      try {
        await maybeRenderMulawToWav(absOut, absWav);
        console.log(`[SIM] rendered wav: ${absWav}`);
      } catch (e) {
        console.warn(`[SIM] wav render failed: ${e.message}`);
      }
    }
  } else {
    console.log(`[SIM] done. outbound receivedBytes=${receivedBytes} receivedChunks=${receivedChunks}`);
  }
}

main().catch((e) => {
  console.error(`[SIM] fatal: ${e.stack || e.message}`);
  process.exit(1);
});






