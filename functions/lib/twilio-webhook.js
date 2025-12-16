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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwilioWebhookHandler = void 0;
const admin = __importStar(require("firebase-admin"));
const twilio_1 = __importDefault(require("twilio"));
class TwilioWebhookHandler {
    // テスト用: TwiMLの内容を確認するエンドポイント
    async getTestTwiml(req, res, mediaStreamUrlBase) {
        try {
            const testCallSid = "test-call-sid-12345";
            // Media Stream WebSocket URLを生成（handleIncomingCallと同じロジック）
            let baseUrl = mediaStreamUrlBase;
            if (!baseUrl.startsWith("wss://") && !baseUrl.startsWith("ws://")) {
                baseUrl = baseUrl.replace("https://", "wss://").replace("http://", "ws://");
            }
            // URLにパスが含まれていない場合は/streamsを追加
            const urlObj = new URL(baseUrl);
            if (urlObj.pathname === "/" || urlObj.pathname === "") {
                urlObj.pathname = "/streams";
            }
            // callSidをクエリパラメータとして追加
            urlObj.searchParams.set("callSid", testCallSid);
            const mediaStreamUrl = urlObj.toString();
            const twiml = new twilio_1.default.twiml.VoiceResponse();
            // <Connect><Stream>を使用してMedia Streamを開始（handleIncomingCallと同じ）
            const connect = twiml.connect();
            connect.stream({
                url: mediaStreamUrl,
            });
            res.type("text/xml");
            res.send(twiml.toString());
        }
        catch (error) {
            console.error("Error generating test TwiML:", error);
            res.status(500).send("Error");
        }
    }
    async handleIncomingCall(req, res, mediaStreamUrlBase) {
        try {
            const callSid = req.body.CallSid;
            const from = req.body.From;
            const to = req.body.To;
            // Firestoreに通話情報を保存
            const db = admin.firestore();
            const callRef = db.collection("calls").doc(callSid);
            await callRef.set({
                callSid,
                from,
                to,
                status: "ringing",
                startTime: admin.firestore.FieldValue.serverTimestamp(),
                conversations: [],
                name: "",
                requirement: "",
                aiResponseEnabled: true,
                forwarded: false,
                voice: "echo", // デフォルトの音声設定（後方互換性のため）
                ttsEngine: "openai", // TTSエンジン: "google" または "openai"
                ttsVoice: "echo", // TTS音声（OpenAI TTS: Echo）
            });
            // Media Stream WebSocket URLを生成
            // Cloud RunのURLはhttps://なので、wss://に変換
            // パスは/でも/streamsでも動作するが、Twilioのサンプルに合わせて/streamsを使用
            let baseUrl = mediaStreamUrlBase;
            if (!baseUrl.startsWith("wss://") && !baseUrl.startsWith("ws://")) {
                baseUrl = baseUrl.replace("https://", "wss://").replace("http://", "ws://");
            }
            // URLにパスが含まれていない場合は/streamsを追加
            const urlObj = new URL(baseUrl);
            if (urlObj.pathname === "/" || urlObj.pathname === "") {
                urlObj.pathname = "/streams";
            }
            // callSidをクエリパラメータとして追加
            urlObj.searchParams.set("callSid", callSid);
            const mediaStreamUrl = urlObj.toString();
            console.log(`Media Stream URL: ${mediaStreamUrl}`);
            // TwiMLを生成（双方向Media Streamsを使用）
            const twiml = new twilio_1.default.twiml.VoiceResponse();
            // <Connect><Stream>を使用してMedia Streamを開始
            // これにより、WebSocket接続が確立されるまで通話が継続される
            const connect = twiml.connect();
            connect.stream({
                url: mediaStreamUrl,
            });
            // <Connect><Stream>を使用すると、その後のTwiML命令は実行されない
            // WebSocket接続が確立されたら、Cloud Runから直接音声を送信する
            res.type("text/xml");
            const twimlResponse = twiml.toString();
            console.log(`TwiML Response: ${twimlResponse}`);
            res.send(twimlResponse);
        }
        catch (error) {
            console.error("Error handling incoming call:", error);
            res.status(500).send("Error");
        }
    }
}
exports.TwilioWebhookHandler = TwilioWebhookHandler;
//# sourceMappingURL=twilio-webhook.js.map