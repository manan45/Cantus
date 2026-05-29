import { useStore } from "./store";

export function StatusBar() {
  const store = useStore();

  const activeFile = store.activeBufferPath;
  const fileName = activeFile ? activeFile.split("/").at(-1) : null;
  const dirty = activeFile ? (store.buffers.get(activeFile)?.dirty ?? false) : false;

  const git = store.gitStatus;
  const stagedCount = git ? git.entries.filter((e) => e.staged != null).length : 0;
  const changedCount = git ? git.entries.filter((e) => e.unstaged != null).length : 0;

  const agent = store.agentStatus;
  const lsp = store.lspStatus;

  return (
    <div className="status-bar">
      {git && (
        <span className="status-bar__git">
          <span className="status-bar__git-branch">{git.branch ?? "HEAD"}</span>
          {stagedCount > 0 && (
            <span className="status-bar__staged">+{stagedCount}</span>
          )}
          {changedCount > 0 && (
            <span className="status-bar__changed">~{changedCount}</span>
          )}
        </span>
      )}

      {fileName && (
        <span className="status-bar__file">
          {fileName}
          {dirty && <span className="status-bar__dirty"> •</span>}
        </span>
      )}

      {store.pendingEdit && (
        <span className="status-bar__pending-edit">edit pending</span>
      )}

      <span className="status-bar__spacer" />

      <span
        className={`status-bar__agent status-bar__agent--${agent.state}`}
        title={agent.session_id ?? undefined}
      >
        Claude {agent.state === "running" ? "running" : "idle"}
      </span>

      <span className={`status-bar__lsp status-bar__lsp--${lsp.state}`}>
        {lsp.state === "running" ? `${lsp.language ?? "lsp"} lsp` : "lsp off"}
      </span>
    </div>
  );
}
