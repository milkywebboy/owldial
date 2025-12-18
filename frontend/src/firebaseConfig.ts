export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
};

// NOTE:
// Firebase Web設定（apiKey等）は秘匿情報ではないため、デフォルト値として同梱してOK。
// 環境変数 (REACT_APP_*) が設定されている場合はそちらを優先する。
export const DEFAULT_FIREBASE_WEB_CONFIG: FirebaseWebConfig = {
  apiKey: "AIzaSyB8PI8MgousmjDPDEAyDxXexyem-l9eiuQ",
  authDomain: "owldial.firebaseapp.com",
  projectId: "owldial",
  storageBucket: "owldial.firebasestorage.app",
  messagingSenderId: "1015425271616",
  appId: "1:1015425271616:web:7d06f413734889da0edca5",
  measurementId: "G-D426YNSQQT",
};

export function getFirebaseWebConfigFromEnvOrDefault(): { cfg: FirebaseWebConfig; hasProjectId: boolean } {
  const envCfg: FirebaseWebConfig = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY || "",
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || "",
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
    measurementId: process.env.REACT_APP_FIREBASE_MEASUREMENT_ID,
  };

  const cfg = envCfg.projectId ? envCfg : DEFAULT_FIREBASE_WEB_CONFIG;
  return { cfg, hasProjectId: Boolean(cfg.projectId) };
}






