import * as admin from "firebase-admin";
import { OpenAI } from "openai";
import { WebClient } from "@slack/web-api";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || "";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const slack = new WebClient(SLACK_BOT_TOKEN);

export async function processCallSummary(callId: string, callData: any) {
  try {
    const db = admin.firestore();
    // 会話履歴を取得
    const conversations = callData.conversations || [];
    const conversationText = conversations
      .map((c: any) => `${c.role === "user" ? "顧客" : "AI"}: ${c.content}`)
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
    const summary = summaryResponse.choices[0]?.message?.content || "";

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
    const emotion = emotionResponse.choices[0]?.message?.content || "";

    // Firestoreに保存
    await db.collection("calls").doc(callId).update({
      summary,
      emotion,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Slackに通知
    await sendSlackNotification(callData, summary, emotion);
  } catch (error) {
    console.error("Error processing call summary:", error);
  }
}

async function sendSlackNotification(callData: any, summary: string, emotion: string) {
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
  } catch (error) {
    console.error("Error sending Slack notification:", error);
  }
}





