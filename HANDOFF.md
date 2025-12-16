# owldial 引き継ぎメモ（Cursor/別端末向け）

## 現状（2025-12-16時点）
- **Cloud Run service**: `media-stream`（region: `us-central1`）
- **主なエンドポイント**: `/streams`（Twilio Media Streams WebSocket）
- **TwiML**: Firebase Functions `twilioIncomingCall` が `<Connect><Stream>` を返す
- **TTS**: OpenAI `gpt-4o-mini-tts-2025-12-15`（voice: `echo` デフォルト）
- **STT**: Whisper（`/v1/audio/transcriptions`）

## 直近で入れた重要な挙動
- **相槌**:
  - 文言: 「はい、ありがとうございます。AIが思考中ですので少々お待ちください」
  - 相槌再生中に相手が話し始めたら**相槌を停止**（barge-in）
  - 直前発話の“続き”として扱えるよう、短い猶予で**音声セグメント結合**（ログに`[MERGE]`）
- **目的情報が取れたらクロージング**:
  - 「他にご用件はありますか？特になければ、このままお電話をお切りください。」
- **対応可能/不可能判定をAI分類**:
  - 単語ベースではなく、分類AIが `normal / take_message / closing / farewell` を返す
- **聞き取り改善（小声/モゴモゴ）**:
  - VADのデフォルト閾値を下げた
  - Whisper前のFFmpegに `highpass/lowpass + volume(+dB)` を追加

## Cloud Run 環境変数（確認ポイント）
- `SILENCE_MS=500`
- `OPENAI_API_KEY` / `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` は **Secret参照**
- 調整用（未設定ならデフォルト動作）:
  - `VAD_THRESHOLD`, `VAD_THRESHOLD_WHILE_PLAYING`
  - `SPEECH_WARMUP_FRAMES`, `SPEECH_WARMUP_FRAMES_WHILE_PLAYING`
  - `WHISPER_GAIN_DB`（例: 6〜12）
  - `WHISPER_AUDIO_FILTERS`（ffmpeg `-af` 文字列）
  - `MERGE_WINDOW_MS`（デフォルト1200）
  - `CLASSIFIER_MODEL`（デフォルト `gpt-4o-mini`）

## ログ確認コマンド（例）
```bash
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name=media-stream' \
  --project=owldial --freshness=30m --limit=400 \
  --format='value(timestamp,resource.labels.revision_name,textPayload)'
```

見るべきログ:
- `Received start event` / `eos_confirmed ... silenceThresholdMs=...`
- `Whisper meta ... status=200`
- `[FLOW] intent ... action=...`
- `transfer_request_refused`（旧）や `take_message`（新）

## 別端末（別Cursor）での再開手順
1. このリポジトリを同じブランチで開く（現状 `main`）
2. `git log -1` で最新コミットを確認
3. Cloud Runの状態確認:
   - `gcloud run services describe media-stream --region us-central1 --project owldial --format='value(status.latestReadyRevisionName,status.url)'`
4. 必要なら環境変数変更:
   - `gcloud run services update media-stream --region us-central1 --project owldial --update-env-vars SILENCE_MS=500`


