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
import SimulateCall from "./SimulateCall";
import { getFirebaseWebConfigFromEnvOrDefault } from "./firebaseConfig";

type Conversation = {
  role: "user" | "assistant";
  content: string;
  timestamp?: Timestamp;
  label?: string;
  kind?: string;
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
  realtimeTranscript?: string;
  realtimeTranscriptInterim?: string;
  realtimeTranscriptUpdatedAt?: Timestamp;
  realtimeAssistantUtterances?: Array<{
    role?: "assistant";
    content?: string;
    label?: string;
    timestamp?: Timestamp;
  }>;
  realtimeAssistantUpdatedAt?: Timestamp;
};

export default function App() {
  const { cfg, hasProjectId } = useMemo(() => getFirebaseWebConfigFromEnvOrDefault(), []);
  const [calls, setCalls] = useState<Array<{ id: string; data: CallDoc }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"logs" | "sim">("logs");

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
          <div className="brandRow">
            <img className="logo" src={`${process.env.PUBLIC_URL}/logo.svg`} alt="owldial logo" />
            <div>
              <div className="title">owldial</div>
              <div className="subtitle">通話ログ（Firestore: calls）</div>
            </div>
          </div>
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

      <div className="tabs">
        <button className={`tab ${tab === "logs" ? "active" : ""}`} onClick={() => setTab("logs")}>
          通話ログ
        </button>
        <button className={`tab ${tab === "sim" ? "active" : ""}`} onClick={() => setTab("sim")}>
          疑似電話
        </button>
      </div>

      {tab === "sim" ? (
        <section className="panel">
          <SimulateCall />
        </section>
      ) : (
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

              {selected.data.realtimeTranscript || selected.data.realtimeTranscriptInterim ? (
                <>
                  <div className="panelDivider" />
                  <div className="panelTitle">リアルタイム文字起こし</div>
                  {selected.data.realtimeTranscript ? (
                    <div className="msg user">
                      <div className="msgRole">user (rt final)</div>
                      <div className="msgText">{selected.data.realtimeTranscript}</div>
                    </div>
                  ) : null}
                  {selected.data.realtimeTranscriptInterim ? (
                    <div className="msg user">
                      <div className="msgRole">user (rt interim)</div>
                      <div className="msgText">{selected.data.realtimeTranscriptInterim}</div>
                    </div>
                  ) : null}
                </>
              ) : null}

              {selected.data.realtimeAssistantUtterances?.length ? (
                <>
                  <div className="panelDivider" />
                  <div className="panelTitle">AI（相槌/返答）リアルタイム</div>
                  <div className="chat">
                    {selected.data.realtimeAssistantUtterances.slice(-30).map((m, idx) => (
                      <div key={idx} className="msg assistant">
                        <div className="msgRole">{`assistant (rt${m.label ? `:${m.label}` : ""})`}</div>
                        <div className="msgText">{m.content || ""}</div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}


