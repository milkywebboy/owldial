// 初期音声を事前生成してCloud Storageに保存するスクリプト
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { Storage } = require("@google-cloud/storage");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const { OpenAI } = require("openai");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const fs = require("fs");

// Firebase初期化
initializeApp();
const db = getFirestore();
const storage = new Storage();
const bucket = storage.bucket(process.env.AUDIO_BUCKET || "owldial-tts");
const ttsClient = new TextToSpeechClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const initialMessage = "お電話ありがとうございます。テックファンドです。";

// MP3音声をmu-law形式（8000Hz、モノラル）に変換
async function convertMp3ToMulaw(mp3Buffer) {
  const timestamp = Date.now();
  const inputFile = `/tmp/audio_${timestamp}.mp3`;
  const outputFile = `/tmp/audio_${timestamp}.ulaw`;

  try {
    fs.writeFileSync(inputFile, mp3Buffer);
    const ffmpegCommand = `ffmpeg -i ${inputFile} -ar 8000 -ac 1 -f mulaw ${outputFile} -y`;
    await execAsync(ffmpegCommand);
    const mulawBuffer = fs.readFileSync(outputFile);
    
    // 一時ファイルを削除
    if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    
    return mulawBuffer;
  } catch (error) {
    console.error(`Error converting MP3 to mu-law: ${error.message}`);
    throw error;
  }
}

// 音声を生成して保存
async function generateAndSaveAudio(ttsEngine, ttsVoice, speed) {
  try {
    console.log(`Generating audio: engine=${ttsEngine}, voice=${ttsVoice}, speed=${speed}`);
    
    let audioBuffer;
    
    if (ttsEngine === "openai") {
      const validOpenAIVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
      const finalVoice = validOpenAIVoices.includes(ttsVoice) ? ttsVoice : "echo";
      
      const response = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts-2025-12-15",
        voice: finalVoice,
        input: initialMessage,
        speed: speed,
      });
      
      const arrayBuffer = await response.arrayBuffer();
      audioBuffer = Buffer.from(arrayBuffer);
    } else {
      const validVoices = [
        "ja-JP-Wavenet-A", "ja-JP-Wavenet-B", "ja-JP-Wavenet-C", "ja-JP-Wavenet-D",
        "ja-JP-Standard-A", "ja-JP-Standard-B", "ja-JP-Standard-C", "ja-JP-Standard-D"
      ];
      const finalVoice = validVoices.includes(ttsVoice) ? ttsVoice : "ja-JP-Wavenet-A";
      
      const [response] = await ttsClient.synthesizeSpeech({
        input: { text: initialMessage },
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
    }
    
    // MP3をmu-law形式に変換
    const mulawBuffer = await convertMp3ToMulaw(audioBuffer);
    
    // Cloud Storageに保存
    const fileName = `initial-greeting-${ttsEngine}-${ttsVoice}-${speed}.ulaw`;
    const file = bucket.file(fileName);
    
    await file.save(mulawBuffer, {
      contentType: 'audio/basic',
      metadata: {
        cacheControl: 'public, max-age=31536000',
      },
    });
    
    console.log(`Saved: ${fileName}`);
  } catch (error) {
    console.error(`Error generating audio for ${ttsEngine}-${ttsVoice}-${speed}: ${error.message}`);
  }
}

// メイン処理
async function main() {
  const configs = [
    { ttsEngine: "openai", ttsVoice: "echo", speed: 1.3 },
    { ttsEngine: "openai", ttsVoice: "alloy", speed: 1.3 },
    { ttsEngine: "google", ttsVoice: "ja-JP-Wavenet-A", speed: 1.3 },
    { ttsEngine: "google", ttsVoice: "ja-JP-Wavenet-C", speed: 1.3 },
  ];
  
  for (const config of configs) {
    await generateAndSaveAudio(config.ttsEngine, config.ttsVoice, config.speed);
  }
  
  console.log("Initial audio generation completed!");
}

main().catch(console.error);





