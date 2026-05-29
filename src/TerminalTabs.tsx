import { useRef, useState } from "react";
import { Terminal } from "./Terminal";

export interface TerminalTabDef {
  key: string;
  title: string;
  program?: string;
  args?: string[];
  sessionId?: string;
}

interface TerminalTabsProps {
  tabs: TerminalTabDef[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onAdd: () => void;
  onRename?: (key: string, title: string) => void;
  onActivePty?: (id: number | null) => void;
  emptyState?: React.ReactNode;
}

export function TerminalTabs({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onAdd,
  onRename,
  onActivePty,
  emptyState,
}: TerminalTabsProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Map from tab key -> pty id, so we can report the active one.
  const ptyIds = useRef<Map<string, number>>(new Map());

  const handlePty = (key: string, id: number) => {
    ptyIds.current.set(key, id);
    if (key === activeKey) onActivePty?.(id);
  };

  const handleSelect = (key: string) => {
    onSelect(key);
    const id = ptyIds.current.get(key) ?? null;
    onActivePty?.(id);
  };

  const startEdit = (e: React.MouseEvent, tab: TerminalTabDef) => {
    e.stopPropagation();
    setEditingKey(tab.key);
    setDraft(tab.title);
  };

  const commitEdit = (key: string) => {
    const trimmed = draft.trim();
    if (trimmed) onRename?.(key, trimmed);
    setEditingKey(null);
  };

  const cancelEdit = () => setEditingKey(null);

  const handleClose = (e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    ptyIds.current.delete(key);
    onClose(key);
    if (key === activeKey) onActivePty?.(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className={`tab${tab.key === activeKey ? " tab--active" : ""}`}
            onClick={() => handleSelect(tab.key)}
          >
            {editingKey === tab.key ? (
              <input
                className="tab-rename-input"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitEdit(tab.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit(tab.key);
                  else if (e.key === "Escape") cancelEdit();
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="tab__name"
                onDoubleClick={(e) => startEdit(e, tab)}
              >
                {tab.title}
              </span>
            )}
            <button
              className="tab__close"
              title="Close"
              onClick={(e) => handleClose(e, tab.key)}
            >
              <span className="tab__close-x">×</span>
            </button>
          </div>
        ))}
        <button
          className="tab"
          title="New tab"
          onClick={onAdd}
          style={{ padding: "0 10px", fontSize: 16, color: "var(--text-dim)" }}
        >
          +
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {tabs.length === 0
          ? emptyState
          : tabs.map((tab) => (
              <div
                key={tab.key}
                style={{
                  position: "absolute",
                  inset: 0,
                  display: tab.key === activeKey ? undefined : "none",
                }}
              >
                <Terminal
                  program={tab.program}
                  args={tab.args}
                  visible={tab.key === activeKey}
                  onPty={(id) => handlePty(tab.key, id)}
                />
              </div>
            ))}
      </div>
    </div>
  );
}
