import { useEffect, useRef, useState } from "react";
import { OrchestrationSession } from "./OrchestrationSession";
import { listOrchestrations, saveOrchestration, deleteOrchestration } from "./ipc";
import { useStore } from "./store";

interface OrchestratorViewProps {
  visible: boolean;
  onClose(): void;
}

interface SessionRecord {
  id: string;
  title: string;
  goal: string;
  tasks: string[];
}

let orchSeq = 0;
function makeSession(): SessionRecord {
  return {
    id: crypto.randomUUID(),
    title: `Orchestration ${++orchSeq}`,
    goal: "",
    tasks: [""],
  };
}

export function OrchestratorView({ visible, onClose }: OrchestratorViewProps) {
  const store = useStore();
  const [sessions, setSessions] = useState<SessionRecord[]>(() => [makeSession()]);
  const [activeId, setActiveId] = useState<string | null>(() => sessions[0].id);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const scheduleSave = (session: SessionRecord) => {
    const existing = saveTimers.current.get(session.id);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      saveTimers.current.delete(session.id);
      saveOrchestration({
        id: session.id,
        title: session.title,
        goal: session.goal,
        tasks: session.tasks,
      }).catch(() => {});
    }, 400);
    saveTimers.current.set(session.id, timer);
  };

  useEffect(() => {
    listOrchestrations()
      .then((list) => {
        if (list.length) {
          setSessions(
            list.map((o) => ({
              id: o.id,
              title: o.title,
              goal: o.goal,
              tasks: o.tasks.length ? o.tasks : [""],
            })),
          );
          setActiveId(list[0].id);
        }
      })
      .catch(() => {});
    const timers = saveTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, [store.project]);

  const updateSession = (id: string, patch: Partial<Omit<SessionRecord, "id">>) => {
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, ...patch } : s));
      const updated = next.find((s) => s.id === id);
      if (updated) scheduleSave(updated);
      return next;
    });
  };

  const newSession = () => {
    const s = makeSession();
    setSessions((prev) => [...prev, s]);
    setActiveId(s.id);
  };

  const closeSession = (id: string) => {
    const timer = saveTimers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      saveTimers.current.delete(id);
    }
    deleteOrchestration(id).catch(() => {});
    setActiveId((cur) => {
      if (cur !== id) return cur;
      const current = sessionsRef.current;
      const idx = current.findIndex((s) => s.id === id);
      const remaining = current.filter((s) => s.id !== id);
      return (remaining[idx] ?? remaining[idx - 1])?.id ?? null;
    });
    setSessions((prev) => prev.filter((s) => s.id !== id));
  };

  const renameSession = (id: string, title: string) => {
    const trimmed = title.trim();
    if (trimmed) updateSession(id, { title: trimmed });
  };

  const commitRename = () => {
    if (editingId) renameSession(editingId, draft);
    setEditingId(null);
  };

  const startRename = (id: string, currentTitle: string) => {
    setEditingId(id);
    setDraft(currentTitle);
  };

  return (
    <div className="orch-manager">
      <div className="orch-tabs">
        <span className="orch-title">Orchestrator</span>

        <div className="orch-tabs__list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={"orch-tab" + (s.id === activeId ? " orch-tab--active" : "")}
              onClick={() => setActiveId(s.id)}
              onDoubleClick={() => startRename(s.id, s.title)}
            >
              {editingId === s.id ? (
                <input
                  className="tab-rename-input"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditingId(null);
                    e.stopPropagation();
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="orch-tab__label">{s.title}</span>
              )}
              <button
                className="orch-tab__close"
                title="Close session"
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(s.id);
                }}
              >
                &times;
              </button>
            </div>
          ))}
        </div>

        <button className="orch-tab__new" onClick={newSession}>
          + New
        </button>

        <div className="orch-bar__slot" ref={setBarSlot} />

        <button className="asset-browser__close" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className="orch-manager__body">
        {sessions.length === 0 ? (
          <div className="orch__empty">
            No orchestration sessions — + New to start one.
          </div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              style={{ height: "100%", display: visible && s.id === activeId ? undefined : "none" }}
            >
              <OrchestrationSession
                visible={visible && s.id === activeId}
                goal={s.goal}
                tasks={s.tasks}
                onGoalChange={(g) => updateSession(s.id, { goal: g })}
                onTasksChange={(ts) => updateSession(s.id, { tasks: ts })}
                barSlot={barSlot}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
