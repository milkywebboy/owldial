export const DEFAULT_MEDIA_STREAM_WS_BASE =
  process.env.REACT_APP_MEDIA_STREAM_WS_BASE ||
  "wss://media-stream-oide2bsh4a-uc.a.run.app/streams";

export const DEFAULT_API_BASE =
  process.env.REACT_APP_API_BASE ||
  (typeof window !== "undefined" ? `${window.location.origin}` : "");





