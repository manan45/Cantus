import { useEffect, useRef, useState } from "react";
import { listSessions, ptyWrite, type SessionMeta } from "./ipc";
import { useStore } from "./store";
import { TerminalTabs, type TerminalTabDef } from "./TerminalTabs";

let tabCounter = 0;
const newKey = () => `chat-${++tabCounter}`;

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function SessionHistory({
  onNew,
  onResume,
}: {
  onNew: () => void;
  onResume: (session: SessionMeta) => void;
}) {
  const store = useStore();
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSessions(null);
    setError(null);
    listSessions()
      .then(setSessions)
      .catch((e: { message?: string }) =>
        setError(e.message ?? "Failed to load sessions"),
      );
  }, [store.project]);

  return (
    <div className="session-history">
      <div className="session-history__header">
        <span className="session-history__title">Chat sessions</span>
        <button className="session-history__new" onClick={onNew}>
          New session
        </button>
      </div>
      <div className="session-history__body">
        {error && <div className="session-history__error">{error}</div>}
        {!sessions && !error && (
          <div className="session-history__loading">Loading…</div>
        )}
        {sessions && sessions.length === 0 && (
          <div className="session-history__empty">No previous sessions.</div>
        )}
        {sessions?.map((s) => (
          <button
            key={s.id}
            className="session-row"
            onClick={() => onResume(s)}
          >
            <span className="session-row__title">
              {s.title.length > 48 ? s.title.slice(0, 48) + "…" : s.title}
            </span>
            <span className="session-row__meta">
              {s.git_branch && (
                <span className="session-row__branch">{s.git_branch}</span>
              )}
              <span className="session-row__time">{relativeTime(s.updated_at)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatSessions() {
  const store = useStore();
  const [tabs, setTabs] = useState<TerminalTabDef[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Refs so the bridge effects always read current values, not stale closures.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePtyRef = useRef<number | null>(null);
  // Queue: text to write once a pty id is known (handles new-tab races).
  const pendingWriteRef = useRef<string | null>(null);

  useEffect(() => {
    store.setChatActive(tabs.length > 0);
  }, [tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps -- store.setChatActive is stable

  const openNewTab = (title = "New chat", args?: string[], sessionId?: string) => {
    const key = newKey();
    setTabs((prev) => [...prev, { key, title, program: "claude", args, sessionId }]);
    setActiveKey(key);
    return key;
  };

  const handleNew = () => void openNewTab();

  const openSession = (s: SessionMeta) => {
    // If a tab for this session id is already open, select it instead of duplicating.
    const existing = tabsRef.current.find((t) => t.sessionId === s.id);
    if (existing) {
      setActiveKey(existing.key);
      return;
    }
    const title = s.title.length > 32 ? s.title.slice(0, 32) + "…" : s.title;
    openNewTab(title, ["--resume", s.id], s.id);
  };

  const handleResume = (s: SessionMeta) => openSession(s);

  const handleClose = (key: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      if (activeKey === key) {
        const idx = prev.findIndex((t) => t.key === key);
        const fallback = next[idx] ?? next[idx - 1] ?? null;
        setActiveKey(fallback?.key ?? null);
      }
      return next;
    });
  };

  const handleActivePty = (id: number | null) => {
    activePtyRef.current = id;
    // Flush any pending write queued before the pty was ready.
    if (id !== null && pendingWriteRef.current !== null) {
      const text = pendingWriteRef.current;
      pendingWriteRef.current = null;
      void ptyWrite(id, text).catch(() => {});
    }
  };

  // Asset-launch bridge: write chatLaunch text into the active chat pty.
  useEffect(() => {
    const text = store.chatLaunch;
    if (!text) return;
    store.setChatLaunch(null);

    const id = activePtyRef.current;
    if (id !== null) {
      void ptyWrite(id, text).catch(() => {});
    } else {
      // No active pty yet — open a new tab and write once its pty resolves.
      pendingWriteRef.current = text;
      openNewTab();
    }
  }, [store.chatLaunch]); // eslint-disable-line react-hooks/exhaustive-deps -- openNewTab uses only stable setters; activePtyRef is a ref

  // Sessions-view bridge: open/resume a session picked from the top-bar Sessions tab.
  useEffect(() => {
    const s = store.chatOpenSession;
    if (!s) return;
    store.setChatOpenSession(null);
    openSession(s);
  }, [store.chatOpenSession]); // eslint-disable-line react-hooks/exhaustive-deps -- openSession/tabs/setActiveKey captured via closure at effect time

  return (
    <TerminalTabs
      tabs={tabs}
      activeKey={activeKey}
      onSelect={setActiveKey}
      onClose={handleClose}
      onAdd={handleNew}
      onRename={(key, title) => setTabs((prev) => prev.map((t) => t.key === key ? { ...t, title } : t))}
      onActivePty={handleActivePty}
      emptyState={
        <SessionHistory onNew={handleNew} onResume={handleResume} />
      }
    />
  );
}
