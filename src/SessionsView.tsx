import { useEffect, useState } from "react";
import { listSessions, type SessionMeta } from "./ipc";

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface SessionsViewProps {
  onClose(): void;
  onOpen(s: SessionMeta): void;
}

export function SessionsView({ onClose, onOpen }: SessionsViewProps) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((e: { message?: string }) =>
        setError(e.message ?? "Failed to load sessions"),
      );
  }, []);

  return (
    <div className="asset-browser">
      <div className="asset-browser__header">
        <span className="asset-browser__title">Sessions</span>
        <button className="asset-browser__close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="asset-browser__body">
        {error && <div className="asset-browser__error">{error}</div>}
        {!sessions && !error && (
          <div className="asset-browser__loading">Loading…</div>
        )}
        {sessions && sessions.length === 0 && !error && (
          <div className="asset-browser__empty">No sessions for this project.</div>
        )}
        {sessions?.map((s) => (
          <button key={s.id} className="session-row" onClick={() => onOpen(s)}>
            <span className="session-row__title">
              {s.title.length > 60 ? s.title.slice(0, 60) + "…" : s.title}
            </span>
            <span className="session-row__meta">
              {s.git_branch && (
                <span className="session-row__branch">{s.git_branch}</span>
              )}
              <span className="session-row__time">{relativeTime(s.updated_at)}</span>
              <span className="session-row__count">
                {s.message_count} msg{s.message_count !== 1 ? "s" : ""}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
