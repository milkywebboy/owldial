import { Request, Response } from "express";
import * as admin from "firebase-admin";
import twilio from "twilio";

export class TwilioWebhookHandler {
  // テスト用: TwiMLの内容を確認するエンドポイント
  async getTestTwiml(req: Request, res: Response, mediaStreamUrlBase: string) {
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
      
      const twiml = new twilio.twiml.VoiceResponse();
      
      // <Connect><Stream>を使用してMedia Streamを開始（handleIncomingCallと同じ）
      const connect = twiml.connect();
      connect.stream({
        url: mediaStreamUrl,
      });
      
      res.type("text/xml");
      res.send(twiml.toString());
    } catch (error) {
      console.error("Error generating test TwiML:", error);
      res.status(500).send("Error");
    }
  }

  async handleIncomingCall(req: Request, res: Response, mediaStreamUrlBase: string) {
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
      const twiml = new twilio.twiml.VoiceResponse();
      
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
    } catch (error) {
      console.error("Error handling incoming call:", error);
      res.status(500).send("Error");
    }
  }
}

