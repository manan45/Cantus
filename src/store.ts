import { createContext, useContext } from "react";
import type { Project, DirEntry, GitStatus, AgentStatus, LspStatus, Selection, RecentEdit, EditorContext, ChatHistory, SessionMeta } from "./ipc";

export type { EditorContext };

export interface Buffer {
  path: string;
  content: string;
  contentHash: string;
  dirty: boolean;
  externallyChanged: boolean;
}

export interface AppStore {
  project: Project | null;
  setProject: (p: Project | null) => void;

  // Invalidated tree paths; consumers re-fetch readDir for these.
  invalidatedPaths: Set<string>;
  invalidatePath: (path: string) => void;
  clearInvalidated: (path: string) => void;

  // Expanded dirs in the file tree (project-relative paths).
  expandedDirs: Set<string>;
  toggleDir: (path: string) => void;

  // Dir entry cache keyed by project-relative path.
  dirCache: Map<string, DirEntry[]>;
  setDirCache: (path: string, entries: DirEntry[]) => void;

  // Open editor buffers.
  buffers: Map<string, Buffer>;
  activeBufferPath: string | null;
  openBuffer: (path: string, content: string, hash: string) => void;
  setActiveBuffer: (path: string) => void;
  closeBuffer: (path: string) => void;
  // Mirror the editor's live content into the buffer on each keystroke so Save
  // (palette / keybinding) writes what the user sees, not the on-open snapshot.
  updateBuffer: (path: string, content: string) => void;
  reconcileBuffer: (path: string, hash: string) => void;
  flagExternalChange: (path: string) => void;

  // Git state — mirrors backend authoritatively.
  gitStatus: GitStatus | null;
  setGitStatus: (s: GitStatus | null) => void;

  // Which file's inline diff is open (null = none).
  diffPath: string | null;
  openDiff: (path: string) => void;
  closeDiff: () => void;

  // Agent lifecycle mirror.
  agentStatus: AgentStatus;
  setAgentStatus: (s: AgentStatus) => void;

  // Chat messages accumulated from agent://event and hydrated from persisted history.
  chatMessages: ChatMessage[];
  appendChatDelta: (runId: number, text: string) => void;
  finalizeChatMessage: (runId: number, role: string, text: string) => void;
  addChatActivity: (runId: number, line: string) => void;
  addChatError: (runId: number, message: string) => void;
  hydrateHistory: (history: ChatHistory) => void;

  // Live editor context for the agent (debounced selection + recent edits).
  activeSelection: Selection | null;
  setActiveSelection: (s: Selection | null) => void;
  recentEdits: RecentEdit[];
  pushRecentEdit: (path: string) => void;
  editorContext: () => EditorContext;

  // Agent-proposed edit pending accept/reject.
  pendingEdit: ProposeEdit | null;
  setPendingEdit: (edit: ProposeEdit) => void;
  clearPendingEdit: () => void;

  // LSP lifecycle mirror.
  lspStatus: LspStatus;
  setLspStatus: (s: LspStatus) => void;

  // Which pane is keyboard-focused.
  focusedPane: PaneId;
  focusPane: (pane: PaneId) => void;

  // Cross-component bridge: text to send to the active chat PTY on next render.
  chatLaunch: string | null;
  setChatLaunch: (v: string | null) => void;

  // Cross-component bridge: session to open/resume in the right-pane chat.
  chatOpenSession: SessionMeta | null;
  setChatOpenSession: (v: SessionMeta | null) => void;

  // Paths Claude changed this session (most-recent first, de-duplicated).
  agentChanges: string[];
  noteAgentChange: (path: string) => void;
  dismissAgentChange: (path: string) => void;
  clearAgentChanges: () => void;

  // Whether any chat session tab is currently open.
  chatActive: boolean;
  setChatActive: (b: boolean) => void;
}

export interface ProposeEdit {
  run_id: number;
  edit_id: number;
  path: string;
  new_content: string;
}

export type PaneId = "explorer" | "editor" | "terminal" | "chat";

export type ChatMessageKind = "assistant" | "user" | "activity" | "error";

export interface ChatMessage {
  runId: number;
  kind: ChatMessageKind;
  text: string;
  // For in-progress streaming assistant messages.
  streaming: boolean;
}

export const StoreContext = createContext<AppStore | null>(null);

export function useStore(): AppStore {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore used outside StoreProvider");
  return ctx;
}
