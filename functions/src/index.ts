import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { TwilioWebhookHandler } from "./twilio-webhook";
import { processCallSummary } from "./call-processor";

admin.initializeApp();

// Media Stream URL（Cloud RunのURL）
const MEDIA_STREAM_URL = "wss://media-stream-oide2bsh4a-uc.a.run.app";

// シークレットの定義
const openaiApiKeySecret = defineSecret("OPENAI_API_KEY");

// Twilio受電Webhook
export const twilioIncomingCall = onRequest(
  {
    cors: true,
    region: "us-central1",
    secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "OPENAI_API_KEY", "SLACK_BOT_TOKEN"],
  },
  async (req, res) => {
    const handler = new TwilioWebhookHandler();
    // テスト用エンドポイント: GETリクエストでTwiMLを確認
    if (req.method === "GET" && req.query.test === "true") {
      await handler.getTestTwiml(req, res, MEDIA_STREAM_URL);
      return;
    }
    await handler.handleIncomingCall(req, res, MEDIA_STREAM_URL);
  }
);

// テスト用: ChatGPT TTSで音声を生成して確認
export const testTTS = onRequest(
  {
    cors: true,
    region: "us-central1",
    secrets: [openaiApiKeySecret],
  },
  async (req, res) => {
    try {
      const text = (req.query.text as string) || "お電話ありがとうございます。テックファンドです。";
      const ttsEngine = (req.query.ttsEngine as string) || "google";
      const ttsVoice = (req.query.ttsVoice as string) || (req.query.voice as string) || "ja-JP-Wavenet-A";
      const speed = parseFloat((req.query.speed as string) || "1.3");
      const finalSpeed = Math.max(0.25, Math.min(4.0, speed));
      let audioBuffer;

      if (ttsEngine === "openai") {
        // OpenAI TTS APIで音声を生成
        const { OpenAI } = await import("openai");
        const apiKey = openaiApiKeySecret.value();
        if (!apiKey || apiKey.trim() === "") {
          throw new Error("OpenAI API key is not set");
        }
        const openaiClient = new OpenAI({
          apiKey: apiKey.trim(),
          timeout: 30000, // 30秒のタイムアウト
          maxRetries: 2,
        });
        const validOpenAIVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
        const finalVoice = validOpenAIVoices.includes(ttsVoice as string) ? (ttsVoice as string) : "shimmer";
        console.log(`Generating OpenAI TTS for text: ${text}, model: gpt-4o-mini-tts-2025-12-15, voice: ${finalVoice}, speed: ${finalSpeed}`);
        console.log(`OpenAI API key length: ${apiKey ? apiKey.length : 0}`);
        try {
          const response = await openaiClient.audio.speech.create({
            model: "gpt-4o-mini-tts-2025-12-15",
            voice: finalVoice as any,
            input: text,
            speed: finalSpeed,
          });
          const arrayBuffer = await response.arrayBuffer();
          audioBuffer = Buffer.from(arrayBuffer);
          console.log(`OpenAI TTS generated, size: ${audioBuffer.length} bytes`);
        } catch (openaiError: any) {
          console.error("OpenAI API error:", {
            message: openaiError?.message,
            code: openaiError?.code,
            status: openaiError?.status,
            type: openaiError?.constructor?.name,
            stack: openaiError?.stack,
          });
          throw new Error(`OpenAI TTS error: ${openaiError?.message || String(openaiError)}`);
        }
      } else {
        // Google Cloud Text-to-Speech APIで音声を生成
        const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
        const validVoices = [
          "ja-JP-Wavenet-A", "ja-JP-Wavenet-B", "ja-JP-Wavenet-C", "ja-JP-Wavenet-D",
          "ja-JP-Standard-A", "ja-JP-Standard-B", "ja-JP-Standard-C", "ja-JP-Standard-D"
        ];
        const finalVoice = validVoices.includes(ttsVoice as string) ? (ttsVoice as string) : "ja-JP-Wavenet-A";
        console.log(`Generating Google TTS for text: ${text}, voice: ${finalVoice}, speed: ${finalSpeed}`);
        const ttsClient = new TextToSpeechClient();
        const response = await ttsClient.synthesizeSpeech({
          input: { text: text },
          voice: {
            languageCode: "ja-JP",
            name: finalVoice,
            ssmlGender: finalVoice.includes("Wavenet-A") || finalVoice.includes("Standard-A") || finalVoice.includes("Wavenet-B") || finalVoice.includes("Standard-B") ? "FEMALE" : "MALE"
          },
          audioConfig: {
            audioEncoding: "MP3",
            speakingRate: finalSpeed,
            pitch: 0.0,
          },
        });
        audioBuffer = Buffer.from((response[0]?.audioContent as Uint8Array) || "");
        console.log(`Google TTS generated, size: ${audioBuffer.length} bytes`);
      }

      // 注意: Firebase Functionsではffmpegが使用できないため、
      // 環境音追加機能はCloud Runでのみ利用可能です
      // テスト用エンドポイントでは環境音なしで返します
      res.type("audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="test-tts.mp3"`);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(audioBuffer);
    } catch (error: any) {
      console.error("Error generating TTS:", error);
      console.error("Error details:", {
        message: error?.message,
        code: error?.code,
        status: error?.status,
        stack: error?.stack,
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: "Error generating TTS",
          details: error?.message || String(error),
          code: error?.code,
          type: error?.constructor?.name,
        });
      }
    }
  }
);

// 通話終了後の処理（要約・感情分析・Slack通知）
export const processCallEnd = onDocumentUpdated(
  {
    document: "calls/{callId}",
    region: "us-central1",
    secrets: ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"],
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;

    // ステータスが"ended"に変わった場合のみ処理
    if (before.status !== "ended" && after.status === "ended") {
      const callId = event.params.callId;
      await processCallSummary(callId, after);
    }
  }
);

