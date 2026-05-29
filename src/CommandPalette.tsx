import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  openProject,
  writeFile,
  gitCommit,
  agentSend,
  type CommandError,
} from "./ipc";
import { acceptPendingEdit, rejectPendingEdit } from "./keybindings";
import { useStore, type PaneId } from "./store";

interface PaletteAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}

interface Props {
  onClose: () => void;
  focusChatInput: () => void;
}

export function CommandPalette({ onClose, focusChatInput }: Props) {
  const store = useStore();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions: PaletteAction[] = [
    {
      id: "open-folder",
      label: "Open Folder",
      run: async () => {
        const path = await open({ directory: true, multiple: false, title: "Open Project" });
        if (!path) return;
        const selected = Array.isArray(path) ? path[0] : path;
        if (!selected) return;
        try {
          const project = await openProject(selected);
          store.setProject(project);
        } catch (e) {
          store.addChatError(-1, `Open folder failed: ${(e as CommandError).message}`);
        }
      },
    },
    {
      id: "save",
      label: "Save",
      run: async () => {
        const path = store.activeBufferPath;
        if (!path) return;
        // Read content from the Monaco model via the buffer (EditorPane keeps it in sync).
        const buf = store.buffers.get(path);
        if (!buf) return;
        try {
          const entry = await writeFile(path, buf.content);
          store.reconcileBuffer(path, entry.content_hash);
          store.pushRecentEdit(path);
        } catch (e) {
          store.addChatError(-1, `Save failed: ${(e as CommandError).message}`);
        }
      },
    },
    {
      id: "git-commit",
      label: "Git Commit…",
      run: async () => {
        const message = prompt("Commit message:");
        if (!message?.trim()) return;
        try {
          const status = await gitCommit(message.trim());
          store.setGitStatus(status);
        } catch (e) {
          store.addChatError(-1, `Commit failed: ${(e as CommandError).message}`);
        }
      },
    },
    {
      id: "focus-explorer",
      label: "Focus Explorer",
      run: () => store.focusPane("explorer" as PaneId),
    },
    {
      id: "focus-editor",
      label: "Focus Editor",
      run: () => store.focusPane("editor" as PaneId),
    },
    {
      id: "focus-terminal",
      label: "Focus Terminal",
      run: () => store.focusPane("terminal" as PaneId),
    },
    {
      id: "focus-chat",
      label: "Focus Chat",
      run: () => store.focusPane("chat" as PaneId),
    },
    {
      id: "ask-agent",
      label: "Ask the Agent…",
      run: async () => {
        store.focusPane("chat" as PaneId);
        focusChatInput();
        const question = prompt("Ask Claude:");
        if (!question?.trim()) return;
        try {
          await agentSend(question.trim(), store.editorContext());
        } catch (e) {
          store.addChatError(-1, `Agent send failed: ${(e as CommandError).message}`);
        }
      },
    },
    {
      id: "accept-diff",
      label: "Accept Diff",
      run: () => acceptPendingEdit(store),
    },
    {
      id: "reject-diff",
      label: "Reject Diff",
      run: () => rejectPendingEdit(store),
    },
  ];

  const filtered = query.trim()
    ? actions.filter((a) => a.label.toLowerCase().includes(query.toLowerCase()))
    : actions;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = (action: PaletteAction) => {
    onClose();
    void action.run();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      run(filtered[selectedIndex]);
    }
  };

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Run a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <ul className="palette__list">
          {filtered.map((action, i) => (
            <li
              key={action.id}
              className={`palette__item${i === selectedIndex ? " palette__item--selected" : ""}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => run(action)}
            >
              {action.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
