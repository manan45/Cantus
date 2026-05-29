import { useEffect, useRef, useState } from "react";
import {
  gitStatus,
  gitStage,
  gitUnstage,
  gitCommit,
  type GitFileStatus,
  type GitStatus,
  type CommandError,
} from "./ipc";
import {
  gitBranches,
  gitCheckout,
  gitCreateBranch,
  gitDiscard,
  type Branch,
} from "./ipc";
import { useStore } from "./store";

const CHANGE_LABEL: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
};

function FileRow({
  entry,
  side,
  onAction,
  onDiscard,
  onDiff,
}: {
  entry: GitFileStatus;
  side: "staged" | "unstaged";
  onAction: (paths: string[]) => Promise<void>;
  onDiscard?: (path: string) => Promise<void>;
  onDiff: (path: string) => void;
}) {
  const change = side === "staged" ? entry.staged! : entry.unstaged!;
  const label = CHANGE_LABEL[change] ?? "?";
  const name = entry.path.split("/").at(-1) ?? entry.path;

  return (
    <div className="git-row" onClick={() => onDiff(entry.path)} title={entry.path}>
      <span className={`git-badge git-badge--${change}`}>{label}</span>
      <span className="git-row__name">{name}</span>
      {onDiscard && (
        <button
          className="git-row__action git-row__action--discard"
          title="Discard changes"
          onClick={(e) => {
            e.stopPropagation();
            void onDiscard(entry.path);
          }}
        >
          ↺
        </button>
      )}
      <button
        className="git-row__action"
        title={side === "staged" ? "Unstage" : "Stage"}
        onClick={(e) => {
          e.stopPropagation();
          void onAction([entry.path]);
        }}
      >
        {side === "staged" ? "−" : "+"}
      </button>
    </div>
  );
}

function BranchSwitcher({
  currentBranch,
  onSwitch,
}: {
  currentBranch: string | null;
  onSwitch: (name: string, isNew: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [newName, setNewName] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  const openDropdown = async () => {
    setLoading(true);
    try {
      const list = await gitBranches();
      setBranches(list.filter((b) => !b.is_remote));
      setOpen(true);
    } catch {
      // silently skip; branch switcher is non-critical
    } finally {
      setLoading(false);
    }
  };

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreatingNew(false);
        setNewName("");
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setCreatingNew(false);
        setNewName("");
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  // Auto-focus the new-branch input when it appears.
  useEffect(() => {
    if (creatingNew) newInputRef.current?.focus();
  }, [creatingNew]);

  const handleSelect = async (name: string) => {
    setOpen(false);
    setCreatingNew(false);
    setNewName("");
    await onSwitch(name, false);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setOpen(false);
    setCreatingNew(false);
    setNewName("");
    await onSwitch(name, true);
  };

  return (
    <div className="branch-switcher" ref={dropdownRef}>
      <button
        className="git-panel__branch git-panel__branch--btn"
        onClick={() => (open ? setOpen(false) : void openDropdown())}
        title="Switch branch"
        disabled={loading}
      >
        {currentBranch ?? "detached HEAD"}
        <span className="branch-switcher__chevron">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="branch-switcher__dropdown">
          {branches.map((b) => (
            <button
              key={b.name}
              className={`branch-switcher__item${b.is_current ? " branch-switcher__item--current" : ""}`}
              onClick={() => void handleSelect(b.name)}
            >
              {b.is_current && <span className="branch-switcher__check">✓</span>}
              {b.name}
            </button>
          ))}

          {creatingNew ? (
            <div className="branch-switcher__new-row">
              <input
                ref={newInputRef}
                className="branch-switcher__new-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                  if (e.key === "Escape") {
                    setCreatingNew(false);
                    setNewName("");
                  }
                }}
                placeholder="branch name"
              />
              <button
                className="branch-switcher__new-confirm"
                onClick={() => void handleCreate()}
                disabled={!newName.trim()}
              >
                Create
              </button>
            </div>
          ) : (
            <button
              className="branch-switcher__item branch-switcher__item--new"
              onClick={() => setCreatingNew(true)}
            >
              + new branch
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function GitPanel() {
  const store = useStore();
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const projectRef = useRef(store.project);
  projectRef.current = store.project;

  const load = async () => {
    if (!projectRef.current) return;
    try {
      store.setGitStatus(await gitStatus());
      setError(null);
    } catch (e) {
      const err = e as CommandError;
      if (err.kind === "git" || err.kind === "no_project") {
        store.setGitStatus(null);
        setError(err.kind === "no_project" ? null : "Not a git repository");
      }
    }
  };

  useEffect(() => {
    void load();
  }, [store.project]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStage = async (paths: string[]) => {
    try {
      store.setGitStatus(await gitStage(paths));
      setError(null);
    } catch (e) {
      setError((e as CommandError).message);
    }
  };

  const handleUnstage = async (paths: string[]) => {
    try {
      store.setGitStatus(await gitUnstage(paths));
      setError(null);
    } catch (e) {
      setError((e as CommandError).message);
    }
  };

  const handleDiscard = async (path: string) => {
    if (!confirm(`Discard changes to ${path.split("/").at(-1)}?`)) return;
    try {
      store.setGitStatus(await gitDiscard([path]));
      setError(null);
    } catch (e) {
      setError((e as CommandError).message);
    }
  };

  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    setCommitting(true);
    try {
      store.setGitStatus(await gitCommit(commitMsg.trim()));
      setCommitMsg("");
      setError(null);
    } catch (e) {
      setError((e as CommandError).message);
    } finally {
      setCommitting(false);
    }
  };

  const handleBranchSwitch = async (name: string, isNew: boolean) => {
    try {
      const result = isNew
        ? await gitCreateBranch(name)
        : await gitCheckout(name);
      store.setGitStatus(result);
      setError(null);
    } catch (e) {
      setError((e as CommandError).message);
    }
  };

  if (!store.project) {
    return (
      <div className="git-panel git-panel--empty">
        <span>No project open</span>
      </div>
    );
  }

  if (error === "Not a git repository") {
    return (
      <div className="git-panel git-panel--empty">
        <span>Not a git repository</span>
      </div>
    );
  }

  const status: GitStatus | null = store.gitStatus;
  const staged = status?.entries.filter((e) => e.staged != null) ?? [];
  const unstaged = status?.entries.filter((e) => e.unstaged != null) ?? [];
  const canCommit = !committing && commitMsg.trim().length > 0 && staged.length > 0;

  return (
    <div className="git-panel">
      <div className="git-panel__header">
        <BranchSwitcher
          currentBranch={status?.branch ?? null}
          onSwitch={handleBranchSwitch}
        />
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="git-panel__sync">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
      </div>

      {error && <div className="git-panel__error">{error}</div>}

      <div className="git-panel__scroll">
        {staged.length > 0 && (
          <section className="git-section">
            <div className="git-section__title">
              Staged
              <button
                className="git-section__action"
                onClick={() => void handleUnstage(staged.map((e) => e.path))}
                title="Unstage all"
              >
                −
              </button>
            </div>
            {staged.map((entry) => (
              <FileRow
                key={entry.path + ":staged"}
                entry={entry}
                side="staged"
                onAction={handleUnstage}
                onDiff={store.openDiff}
              />
            ))}
          </section>
        )}

        {unstaged.length > 0 && (
          <section className="git-section">
            <div className="git-section__title">
              Changes
              <button
                className="git-section__action"
                onClick={() => void handleStage(unstaged.map((e) => e.path))}
                title="Stage all"
              >
                +
              </button>
            </div>
            {unstaged.map((entry) => (
              <FileRow
                key={entry.path + ":unstaged"}
                entry={entry}
                side="unstaged"
                onAction={handleStage}
                onDiscard={handleDiscard}
                onDiff={store.openDiff}
              />
            ))}
          </section>
        )}

        {staged.length === 0 && unstaged.length === 0 && status && (
          <div className="git-panel__clean">No changes</div>
        )}
      </div>

      <div className="git-panel__commit">
        <textarea
          className="git-commit-msg"
          placeholder="Commit message"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          rows={3}
        />
        <button
          className="git-commit-btn"
          disabled={!canCommit}
          onClick={() => void handleCommit()}
        >
          Commit{staged.length > 0 ? ` (${staged.length})` : ""}
        </button>
      </div>
    </div>
  );
}
