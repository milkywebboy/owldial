import { WebClient } from "@slack/web-api";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN || "");
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || "";

function slackAvailable() {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID);
}

export async function sendSlackStartMessage(callData: any, callId: string) {
  if (!slackAvailable()) return;
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "📞 新しい着信" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*callSid:*\n${callId}` },
        { type: "mrkdwn", text: `*from:*\n${callData.from || "不明"}` },
        { type: "mrkdwn", text: `*to:*\n${callData.to || "不明"}` },
        { type: "mrkdwn", text: `*status:*\n${callData.status || "ringing"}` },
      ],
    },
  ];
  await slack.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    text: "新しい着信があります",
    blocks,
  });
}

export async function sendSlackSummaryMessage(callData: any, summary: string, emotion: string) {
  if (!slackAvailable()) return;
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "📞 通話終了通知" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*電話番号:*\n${callData.from || "不明"}` },
        { type: "mrkdwn", text: `*名前:*\n${callData.name || "不明"}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*要約:*\n${summary}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*感情分析:*\n${emotion}` },
    },
  ];
  await slack.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    text: "通話の要約が更新されました",
    blocks,
  });
}
