import React, { useEffect, useMemo, useState } from "react";
import { initializeApp } from "firebase/app";
import {
  collection,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
} from "firebase/firestore";
import "./App.css";

type Conversation = {
  role: "user" | "assistant";
  content: string;
  timestamp?: Timestamp;
};

type CallDoc = {
  callSid?: string;
  from?: string;
  to?: string;
  status?: string;
  startTime?: Timestamp;
  endTime?: Timestamp;
  conversations?: Conversation[];
  purposeCaptured?: boolean;
  purposeMessage?: string;
};

function getFirebaseConfig() {
  // CRA想定: REACT_APP_*
  const cfg = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
  };
  const hasProjectId = Boolean(cfg.projectId);
  return { cfg, hasProjectId };
}

export default function App() {
  const { cfg, hasProjectId } = useMemo(() => getFirebaseConfig(), []);
  const [calls, setCalls] = useState<Array<{ id: string; data: CallDoc }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasProjectId) return;
    try {
      const app = initializeApp(cfg);
      const db = getFirestore(app);
      const q = query(collection(db, "calls"), orderBy("startTime", "desc"), limit(50));
      const unsub = onSnapshot(
        q,
        (snap) => {
          const next = snap.docs.map((d) => ({ id: d.id, data: d.data() as CallDoc }));
          setCalls(next);
          if (!selectedId && next[0]) setSelectedId(next[0].id);
        },
        (e) => setError(e.message || String(e))
      );
      return () => unsub();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [cfg, hasProjectId, selectedId]);

  const selected = calls.find((c) => c.id === selectedId);

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <div className="title">owldial</div>
          <div className="subtitle">通話ログ（Firestore: calls）</div>
        </div>
        <div className="hint">
          {!hasProjectId ? (
            <span className="danger">
              Firebase設定が未指定です（REACT_APP_FIREBASE_PROJECT_ID など）
            </span>
          ) : (
            <span className="muted">project: {cfg.projectId}</span>
          )}
        </div>
      </header>

      <main className="main">
        <section className="panel list">
          <div className="panelHeader">
            <div className="panelTitle">通話一覧</div>
            <div className="panelMeta">{calls.length}件</div>
          </div>
          {error ? <div className="error">{error}</div> : null}
          <div className="listBody">
            {calls.map((c) => (
              <button
                key={c.id}
                className={`row ${c.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(c.id)}
              >
                <div className="rowTop">
                  <span className="mono">{c.id}</span>
                  <span className={`badge ${c.data.status || "unknown"}`}>{c.data.status || "unknown"}</span>
                </div>
                <div className="rowSub">
                  <span className="muted">{c.data.from || "-"}</span>
                  <span className="muted">→</span>
                  <span className="muted">{c.data.to || "-"}</span>
                </div>
              </button>
            ))}
            {calls.length === 0 ? <div className="empty">まだ通話がありません</div> : null}
          </div>
        </section>

        <section className="panel detail">
          <div className="panelHeader">
            <div className="panelTitle">詳細</div>
            <div className="panelMeta">{selected ? selected.id : "-"}</div>
          </div>
          {!selected ? (
            <div className="empty">左から通話を選択してください</div>
          ) : (
            <div className="detailBody">
              <div className="kv">
                <div className="k">status</div>
                <div className="v">{selected.data.status || "-"}</div>
              </div>
              <div className="kv">
                <div className="k">from</div>
                <div className="v mono">{selected.data.from || "-"}</div>
              </div>
              <div className="kv">
                <div className="k">to</div>
                <div className="v mono">{selected.data.to || "-"}</div>
              </div>
              <div className="kv">
                <div className="k">purposeCaptured</div>
                <div className="v">{selected.data.purposeCaptured ? "true" : "false"}</div>
              </div>
              {selected.data.purposeMessage ? (
                <div className="kv">
                  <div className="k">purposeMessage</div>
                  <div className="v">{selected.data.purposeMessage}</div>
                </div>
              ) : null}

              <div className="panelDivider" />

              <div className="panelTitle">会話</div>
              <div className="chat">
                {(selected.data.conversations || []).map((m, idx) => (
                  <div key={idx} className={`msg ${m.role}`}>
                    <div className="msgRole">{m.role}</div>
                    <div className="msgText">{m.content}</div>
                  </div>
                ))}
                {(selected.data.conversations || []).length === 0 ? (
                  <div className="empty">会話ログがまだありません</div>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}


