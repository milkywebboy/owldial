"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.processCallEnd = exports.testTTS = exports.twilioIncomingCall = void 0;
const admin = __importStar(require("firebase-admin"));
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-functions/v2/firestore");
const params_1 = require("firebase-functions/params");
const twilio_webhook_1 = require("./twilio-webhook");
const call_processor_1 = require("./call-processor");
admin.initializeApp();
// Media Stream URL（Cloud RunのURL）
const MEDIA_STREAM_URL = "wss://media-stream-oide2bsh4a-uc.a.run.app";
// シークレットの定義
const openaiApiKeySecret = (0, params_1.defineSecret)("OPENAI_API_KEY");
// Twilio受電Webhook
exports.twilioIncomingCall = (0, https_1.onRequest)({
    cors: true,
    region: "us-central1",
    secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "OPENAI_API_KEY", "SLACK_BOT_TOKEN"],
}, async (req, res) => {
    const handler = new twilio_webhook_1.TwilioWebhookHandler();
    // テスト用エンドポイント: GETリクエストでTwiMLを確認
    if (req.method === "GET" && req.query.test === "true") {
        await handler.getTestTwiml(req, res, MEDIA_STREAM_URL);
        return;
    }
    await handler.handleIncomingCall(req, res, MEDIA_STREAM_URL);
});
// テスト用: ChatGPT TTSで音声を生成して確認
exports.testTTS = (0, https_1.onRequest)({
    cors: true,
    region: "us-central1",
    secrets: [openaiApiKeySecret],
}, async (req, res) => {
    var _a, _b, _c;
    try {
        const text = req.query.text || "お電話ありがとうございます。テックファンドです。";
        const ttsEngine = req.query.ttsEngine || "google";
        const ttsVoice = req.query.ttsVoice || req.query.voice || "ja-JP-Wavenet-A";
        const speed = parseFloat(req.query.speed || "1.3");
        const finalSpeed = Math.max(0.25, Math.min(4.0, speed));
        let audioBuffer;
        if (ttsEngine === "openai") {
            // OpenAI TTS APIで音声を生成
            const { OpenAI } = await Promise.resolve().then(() => __importStar(require("openai")));
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
            const finalVoice = validOpenAIVoices.includes(ttsVoice) ? ttsVoice : "shimmer";
            console.log(`Generating OpenAI TTS for text: ${text}, model: gpt-4o-mini-tts-2025-12-15, voice: ${finalVoice}, speed: ${finalSpeed}`);
            console.log(`OpenAI API key length: ${apiKey ? apiKey.length : 0}`);
            try {
                const response = await openaiClient.audio.speech.create({
                    model: "gpt-4o-mini-tts-2025-12-15",
                    voice: finalVoice,
                    input: text,
                    speed: finalSpeed,
                });
                const arrayBuffer = await response.arrayBuffer();
                audioBuffer = Buffer.from(arrayBuffer);
                console.log(`OpenAI TTS generated, size: ${audioBuffer.length} bytes`);
            }
            catch (openaiError) {
                console.error("OpenAI API error:", {
                    message: openaiError === null || openaiError === void 0 ? void 0 : openaiError.message,
                    code: openaiError === null || openaiError === void 0 ? void 0 : openaiError.code,
                    status: openaiError === null || openaiError === void 0 ? void 0 : openaiError.status,
                    type: (_a = openaiError === null || openaiError === void 0 ? void 0 : openaiError.constructor) === null || _a === void 0 ? void 0 : _a.name,
                    stack: openaiError === null || openaiError === void 0 ? void 0 : openaiError.stack,
                });
                throw new Error(`OpenAI TTS error: ${(openaiError === null || openaiError === void 0 ? void 0 : openaiError.message) || String(openaiError)}`);
            }
        }
        else {
            // Google Cloud Text-to-Speech APIで音声を生成
            const { TextToSpeechClient } = await Promise.resolve().then(() => __importStar(require("@google-cloud/text-to-speech")));
            const validVoices = [
                "ja-JP-Wavenet-A", "ja-JP-Wavenet-B", "ja-JP-Wavenet-C", "ja-JP-Wavenet-D",
                "ja-JP-Standard-A", "ja-JP-Standard-B", "ja-JP-Standard-C", "ja-JP-Standard-D"
            ];
            const finalVoice = validVoices.includes(ttsVoice) ? ttsVoice : "ja-JP-Wavenet-A";
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
            audioBuffer = Buffer.from(((_b = response[0]) === null || _b === void 0 ? void 0 : _b.audioContent) || "");
            console.log(`Google TTS generated, size: ${audioBuffer.length} bytes`);
        }
        // 注意: Firebase Functionsではffmpegが使用できないため、
        // 環境音追加機能はCloud Runでのみ利用可能です
        // テスト用エンドポイントでは環境音なしで返します
        res.type("audio/mpeg");
        res.setHeader("Content-Disposition", `attachment; filename="test-tts.mp3"`);
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.send(audioBuffer);
    }
    catch (error) {
        console.error("Error generating TTS:", error);
        console.error("Error details:", {
            message: error === null || error === void 0 ? void 0 : error.message,
            code: error === null || error === void 0 ? void 0 : error.code,
            status: error === null || error === void 0 ? void 0 : error.status,
            stack: error === null || error === void 0 ? void 0 : error.stack,
        });
        if (!res.headersSent) {
            res.status(500).json({
                error: "Error generating TTS",
                details: (error === null || error === void 0 ? void 0 : error.message) || String(error),
                code: error === null || error === void 0 ? void 0 : error.code,
                type: (_c = error === null || error === void 0 ? void 0 : error.constructor) === null || _c === void 0 ? void 0 : _c.name,
            });
        }
    }
});
// 通話終了後の処理（要約・感情分析・Slack通知）
exports.processCallEnd = (0, firestore_1.onDocumentUpdated)({
    document: "calls/{callId}",
    region: "us-central1",
    secrets: ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"],
}, async (event) => {
    var _a, _b;
    const before = (_a = event.data) === null || _a === void 0 ? void 0 : _a.before.data();
    const after = (_b = event.data) === null || _b === void 0 ? void 0 : _b.after.data();
    if (!before || !after)
        return;
    // ステータスが"ended"に変わった場合のみ処理
    if (before.status !== "ended" && after.status === "ended") {
        const callId = event.params.callId;
        await (0, call_processor_1.processCallSummary)(callId, after);
    }
});
//# sourceMappingURL=index.js.map