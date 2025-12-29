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
import { APP_VERSION } from "./version";
import { DEFAULT_API_BASE } from "./appConfig";

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
  aiResponseEnabled?: boolean;
  startTime?: Timestamp;
  endTime?: Timestamp;
  forwardMessage?: string;
  forwarded?: boolean;
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
  const [transferMessage, setTransferMessage] = useState("人間のスタッフに転送されます。少々お待ちください。");
  const [transferTarget, setTransferTarget] = useState("");
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [transferStatus, setTransferStatus] = useState<string | null>(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [manualText, setManualText] = useState("");
  const [aiToggleStatus, setAiToggleStatus] = useState<string | null>(null);
  const [manualStatus, setManualStatus] = useState<string | null>(null);

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
  useEffect(() => {
    if (!selected) return;
    if (typeof selected.data.aiResponseEnabled === "boolean") {
      setAiEnabled(Boolean(selected.data.aiResponseEnabled));
    }
  }, [selected?.data.aiResponseEnabled]);

  async function triggerTransfer() {
    if (!selected) return;
    setTransferStatus(null);
    try {
      const resp = await fetch(`${apiBase}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callSid: selected.id, message: transferMessage, target: transferTarget }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(txt || resp.statusText);
      }
      setTransferStatus("転送案内を送信しました");
    } catch (e: any) {
      setTransferStatus(`エラー: ${e?.message || e}`);
    }
  }

  async function toggleAi(enabled: boolean) {
    if (!selected) return;
    setAiToggleStatus(null);
    try {
      const resp = await fetch(`${apiBase}/ai-response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callSid: selected.id, enabled }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setAiEnabled(enabled);
      setAiToggleStatus(enabled ? "AI応答を再開しました" : "AI応答を停止しました");
    } catch (e: any) {
      setAiToggleStatus(`エラー: ${e?.message || e}`);
    }
  }

  async function sendManualResponse() {
    if (!selected || !manualText.trim()) return;
    setManualStatus(null);
    try {
      const resp = await fetch(`${apiBase}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callSid: selected.id, text: manualText }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setManualStatus("送信しました");
      setManualText("");
    } catch (e: any) {
      setManualStatus(`エラー: ${e?.message || e}`);
    }
  }

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
            <span className="muted">
              project: {cfg.projectId} <span className="mono">· {APP_VERSION}</span>
            </span>
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
                  <div className="k">API base</div>
                  <div className="v">
                    <input
                      value={apiBase}
                      onChange={(e) => setApiBase(e.target.value)}
                      className="input"
                      placeholder="https://media-stream...（/transfer 用）"
                    />
                  </div>
                </div>
                <div className="kv">
                  <div className="k">status</div>
                  <div className="v">{selected.data.status || "-"}</div>
                </div>
                <div className="kv">
                  <div className="k">AI応答</div>
                  <div className="v">
                    <span className={`badge ${aiEnabled ? "active" : "unknown"}`}>{aiEnabled ? "enabled" : "stopped"}</span>
                    <button className="primary" onClick={() => toggleAi(true)} disabled={aiEnabled}>再開</button>
                    <button onClick={() => toggleAi(false)} disabled={!aiEnabled}>停止</button>
                    {aiToggleStatus ? <div className="muted">{aiToggleStatus}</div> : null}
                  </div>
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
                <div className="kv">
                  <div className="k">forwarded</div>
                  <div className="v">{selected.data.forwarded ? "true" : "false"}</div>
                </div>
                <div className="kv">
                  <div className="k">forwardMessage</div>
                  <div className="v">{selected.data.forwardMessage || "-"}</div>
                </div>

                <div className="panelDivider" />
                <div className="panelTitle">転送ボタン</div>
                <div className="kv">
                  <div className="k">案内メッセージ</div>
                  <div className="v">
                    <input
                      className="input"
                      value={transferMessage}
                      onChange={(e) => setTransferMessage(e.target.value)}
                    />
                  </div>
                </div>
                <div className="kv">
                  <div className="k">転送先番号</div>
                  <div className="v">
                    <input
                      className="input"
                      value={transferTarget}
                      onChange={(e) => setTransferTarget(e.target.value)}
                      placeholder="例: +81..."
                    />
                  </div>
                </div>
                <button className="primary" onClick={triggerTransfer}>転送案内を再生</button>
                {transferStatus ? <div className="muted">{transferStatus}</div> : null}

                <div className="panelDivider" />
                <div className="panelTitle">手動返答</div>
                <div className="kv">
                  <div className="k">テキスト</div>
                  <div className="v">
                    <textarea
                      className="input"
                      value={manualText}
                      onChange={(e) => setManualText(e.target.value)}
                      placeholder="通話相手への返答"
                    />
                  </div>
                </div>
                <button className="primary" onClick={sendManualResponse} disabled={!manualText.trim()}>通話中の相手に返答する</button>
                {manualStatus ? <div className="muted">{manualStatus}</div> : null}

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

              {selected.data.realtimeTranscript ||
              selected.data.realtimeTranscriptInterim ||
              selected.data.realtimeAssistantUtterances?.length ? (
                <>
                  <div className="panelDivider" />
                  <div className="panelTitle">リアルタイム文字起こし（顧客 + AI）</div>
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

                  {selected.data.realtimeAssistantUtterances?.length ? (
                    <div className="chat">
                      {selected.data.realtimeAssistantUtterances.slice(-30).map((m, idx) => (
                        <div key={idx} className="msg assistant">
                          <div className="msgRole">{`assistant (rt${m.label ? `:${m.label}` : ""})`}</div>
                          <div className="msgText">{m.content || ""}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
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
