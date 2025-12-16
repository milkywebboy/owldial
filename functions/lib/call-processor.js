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
exports.processCallSummary = processCallSummary;
const admin = __importStar(require("firebase-admin"));
const openai_1 = require("openai");
const web_api_1 = require("@slack/web-api");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || "";
const openai = new openai_1.OpenAI({ apiKey: OPENAI_API_KEY });
const slack = new web_api_1.WebClient(SLACK_BOT_TOKEN);
async function processCallSummary(callId, callData) {
    var _a, _b, _c, _d;
    try {
        const db = admin.firestore();
        // 会話履歴を取得
        const conversations = callData.conversations || [];
        const conversationText = conversations
            .map((c) => `${c.role === "user" ? "顧客" : "AI"}: ${c.content}`)
            .join("\n");
        // 要約を生成
        const summaryResponse = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "通話内容を要約してください。重要な情報（名前、要件、連絡先など）を含めてください。",
                },
                {
                    role: "user",
                    content: `以下の通話内容を要約してください：\n\n${conversationText}`,
                },
            ],
            temperature: 0.3,
        });
        const summary = ((_b = (_a = summaryResponse.choices[0]) === null || _a === void 0 ? void 0 : _a.message) === null || _b === void 0 ? void 0 : _b.content) || "";
        // 感情分析を実行
        const emotionResponse = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "通話内容から顧客の感情を分析してください。感情（ポジティブ、ネガティブ、中立など）と感情の強度を返してください。",
                },
                {
                    role: "user",
                    content: `以下の通話内容から感情を分析してください：\n\n${conversationText}`,
                },
            ],
            temperature: 0.3,
        });
        const emotion = ((_d = (_c = emotionResponse.choices[0]) === null || _c === void 0 ? void 0 : _c.message) === null || _d === void 0 ? void 0 : _d.content) || "";
        // Firestoreに保存
        await db.collection("calls").doc(callId).update({
            summary,
            emotion,
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // Slackに通知
        await sendSlackNotification(callData, summary, emotion);
    }
    catch (error) {
        console.error("Error processing call summary:", error);
    }
}
async function sendSlackNotification(callData, summary, emotion) {
    try {
        const message = {
            channel: SLACK_CHANNEL_ID,
            text: "新しい通話が終了しました",
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "📞 通話終了通知",
                    },
                },
                {
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `*電話番号:*\n${callData.from || "不明"}`,
                        },
                        {
                            type: "mrkdwn",
                            text: `*名前:*\n${callData.name || "不明"}`,
                        },
                    ],
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*要約:*\n${summary}`,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*感情分析:*\n${emotion}`,
                    },
                },
            ],
        };
        await slack.chat.postMessage(message);
    }
    catch (error) {
        console.error("Error sending Slack notification:", error);
    }
}
//# sourceMappingURL=call-processor.js.map