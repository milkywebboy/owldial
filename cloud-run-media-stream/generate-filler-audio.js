// 相槌音声（「はい、ありがとうございます、えー…」）を事前生成してCloud Storageに保存するスクリプト
// 生成形式: ulaw (8kHz, mono) / Twilio Media Streams向け
//
// 実行例（Cloud Runコンテナ内）:
//   node generate-filler-audio.js

const { Storage } = require("@google-cloud/storage");
const { OpenAI } = require("openai");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const fs = require("fs");

const bucketName = process.env.AUDIO_BUCKET || "owldial-tts";
const storage = new Storage();
const bucket = storage.bucket(bucketName);

const openai = new OpenAI({ apiKey: (process.env.OPENAI_API_KEY || "").trim() });

const fillerText = "はい、ありがとうございます、えー…";
const FILLER_VERSION = process.env.FILLER_VERSION || "v2";

async function convertMp3ToMulaw(mp3Buffer) {
  const ts = Date.now();
  const inputFile = `/tmp/filler_${ts}.mp3`;
  const outputFile = `/tmp/filler_${ts}.ulaw`;

  try {
    fs.writeFileSync(inputFile, mp3Buffer);
    const ffmpegCommand = `ffmpeg -i ${inputFile} -ar 8000 -ac 1 -f mulaw ${outputFile} -y`;
    await execAsync(ffmpegCommand);
    const mulawBuffer = fs.readFileSync(outputFile);
    return mulawBuffer;
  } finally {
    try { if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile); } catch (_) {}
    try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch (_) {}
  }
}

async function generateAndUploadOpenAIFiller({ voice, speed }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts-2025-12-15",
    voice,
    input: fillerText,
    speed,
  });

  const arrayBuffer = await response.arrayBuffer();
  const mp3Buffer = Buffer.from(arrayBuffer);
  const mulawBuffer = await convertMp3ToMulaw(mp3Buffer);

  const fileName = `filler-aizuchi-${FILLER_VERSION}-openai-${voice}-${speed}.ulaw`;
  await bucket.file(fileName).save(mulawBuffer, {
    contentType: "audio/basic",
    metadata: {
      cacheControl: "public, max-age=31536000",
    },
  });

  console.log(`Saved gs://${bucketName}/${fileName} bytes=${mulawBuffer.length}`);
}

async function main() {
  // media-stream側のデフォルトと合わせる
  await generateAndUploadOpenAIFiller({ voice: "echo", speed: 1.3 });
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});


