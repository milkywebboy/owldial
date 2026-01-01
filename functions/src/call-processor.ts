import * as admin from "firebase-admin";
import { OpenAI } from "openai";
import twilio from "twilio";
import { sendSlackSummaryMessage } from "./slack-notifier";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const SMS_FROM_NUMBER = process.env.SMS_FROM_NUMBER || "";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

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
    await sendSlackSummaryMessage(callData, summary, emotion);

    // プロファイル更新
    const profileId = (callData.from || "").replace(/[^0-9+]/g, "");
    if (profileId) {
      await db.collection("callerProfiles").doc(profileId).set(
        {
          lastCallId: callId,
          lastSummary: summary,
          lastEmotion: emotion,
          lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          lastName: callData.name || "",
        },
        { merge: true }
      );
    }

    // 伝言URLをSMS送付（設定がある場合のみ）
    if (twilioClient && SMS_FROM_NUMBER && callData.from) {
      try {
        const messageText = `通話内容を受け付けました（ID: ${callId}）。担当者から折り返します。`;
        await twilioClient.messages.create({
          to: callData.from,
          from: SMS_FROM_NUMBER,
          body: messageText,
        });
      } catch (error) {
        console.error("Error sending SMS:", error);
      }
    }
  } catch (error) {
    console.error("Error processing call summary:", error);
  }
}


