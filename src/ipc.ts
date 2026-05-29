import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CommandError {
  kind:
    | "not_found"
    | "io"
    | "no_project"
    | "forbidden"
    | "db"
    | "pty"
    | "git"
    | "agent"
    | "lsp";
  message: string;
}

export type LspLanguage = "python";

export interface LspStatus {
  state: "running" | "stopped";
  language: LspLanguage | null;
  generation: number;
}

export interface LspMessage {
  generation: number;
  payload: string;
}

export type GitChange =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export interface GitFileStatus {
  path: string;
  staged: GitChange | null;
  unstaged: GitChange | null;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitFileStatus[];
}

export interface GitDiffLine {
  origin: "context" | "addition" | "deletion";
  content: string;
  old_lineno: number | null;
  new_lineno: number | null;
}

export interface GitHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: GitDiffLine[];
}

export interface GitDiff {
  path: string;
  old_text: string;
  new_text: string;
  binary: boolean;
  hunks: GitHunk[];
}

export interface SpawnedTerminal {
  id: number;
}

export interface PtyOutput {
  id: number;
  data: string;
}

export interface PtyExit {
  id: number;
}

export interface AppInfo {
  name: string;
  version: string;
}

export interface Project {
  id: number;
  root_path: string;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface FileContent {
  content: string;
  content_hash: string;
}

export interface FileEntry {
  path: string;
  content_hash: string;
  updated_at: string;
}

export interface FsChange {
  path: string;
  kind: "created" | "modified" | "removed";
  content_hash: string | null;
}

export const appInfo = (): Promise<AppInfo> => invoke("app_info");

export const openProject = (path: string): Promise<Project> =>
  invoke("open_project", { path });

export const currentProject = (): Promise<Project | null> =>
  invoke("current_project");

export const readDir = (path: string): Promise<DirEntry[]> =>
  invoke("read_dir", { path });

export const readFile = (path: string): Promise<FileContent> =>
  invoke("read_file", { path });

export const writeFile = (path: string, content: string): Promise<FileEntry> =>
  invoke("write_file", { path, content });

export const listenFsChanged = (
  cb: (change: FsChange) => void,
): Promise<UnlistenFn> => listen<FsChange>("fs://changed", (e) => cb(e.payload));

export interface SessionMeta {
  id: string;
  title: string;
  updated_at: number; // epoch milliseconds
  git_branch: string | null;
  message_count: number;
}

export interface AssetItem {
  name: string;
  description: string;
  scope: "user" | "project";
  path: string;
}

export interface ClaudeAssets {
  skills: AssetItem[];
  agents: AssetItem[];
  workflows: AssetItem[];
}

export const ptySpawn = (
  cols: number,
  rows: number,
  program?: string,
  args?: string[],
): Promise<SpawnedTerminal> => invoke("pty_spawn", { cols, rows, program, args });

export const listSessions = (): Promise<SessionMeta[]> => invoke("list_sessions");

export const listClaudeAssets = (): Promise<ClaudeAssets> => invoke("list_claude_assets");

export const ptyWrite = (id: number, data: string): Promise<void> =>
  invoke("pty_write", { id, data });

export const ptyResize = (id: number, cols: number, rows: number): Promise<void> =>
  invoke("pty_resize", { id, cols, rows });

export const ptyKill = (id: number): Promise<void> => invoke("pty_kill", { id });

export const listenPtyOutput = (
  cb: (o: PtyOutput) => void,
): Promise<UnlistenFn> => listen<PtyOutput>("pty://output", (e) => cb(e.payload));

export const listenPtyExit = (
  cb: (e: PtyExit) => void,
): Promise<UnlistenFn> => listen<PtyExit>("pty://exit", (e) => cb(e.payload));

export const gitStatus = (): Promise<GitStatus> => invoke("git_status");

export const gitStage = (paths: string[]): Promise<GitStatus> =>
  invoke("git_stage", { paths });

export const gitUnstage = (paths: string[]): Promise<GitStatus> =>
  invoke("git_unstage", { paths });

export const gitCommit = (message: string): Promise<GitStatus> =>
  invoke("git_commit", { message });

export const gitDiff = (path: string): Promise<GitDiff> =>
  invoke("git_diff", { path });

export interface Branch { name: string; is_current: boolean; is_remote: boolean }
export const gitBranches = (): Promise<Branch[]> => invoke("git_branches");
export const gitCheckout = (name: string): Promise<GitStatus> => invoke("git_checkout", { name });
export const gitCreateBranch = (name: string): Promise<GitStatus> => invoke("git_create_branch", { name });
export const gitDiscard = (paths: string[]): Promise<GitStatus> => invoke("git_discard", { paths });

export const gitStageHunk = (path: string, hunkIndex: number): Promise<GitStatus> => invoke("git_stage_hunk", { path, hunkIndex });
export const gitUnstageHunk = (path: string, hunkIndex: number): Promise<GitStatus> => invoke("git_unstage_hunk", { path, hunkIndex });
export const gitStageLines = (path: string, hunkIndex: number, lineIndices: number[]): Promise<GitStatus> => invoke("git_stage_lines", { path, hunkIndex, lineIndices });
export const gitUnstageLines = (path: string, hunkIndex: number, lineIndices: number[]): Promise<GitStatus> => invoke("git_unstage_lines", { path, hunkIndex, lineIndices });
export const gitDiscardHunk = (path: string, hunkIndex: number): Promise<GitStatus> => invoke("git_discard_hunk", { path, hunkIndex });
export const gitDiscardLines = (path: string, hunkIndex: number, lineIndices: number[]): Promise<GitStatus> => invoke("git_discard_lines", { path, hunkIndex, lineIndices });

// ── Orchestration seam ───────────────────────────────────────────────────────

export interface Orchestration {
  id: string;
  title: string;
  goal: string;
  tasks: string[];
  updated_at: number;
}

export const listOrchestrations = (): Promise<Orchestration[]> =>
  invoke("list_orchestrations");

export const saveOrchestration = (o: {
  id: string;
  title: string;
  goal: string;
  tasks: string[];
}): Promise<void> => invoke("save_orchestration", { o });

export const deleteOrchestration = (id: string): Promise<void> =>
  invoke("delete_orchestration", { id });

export const planTasks = (goal: string): Promise<string[]> =>
  invoke("plan_tasks", { goal });

// ── Agent seam ────────────────────────────────────────────────────────────────

export interface Selection {
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  text: string;
}

export interface RecentEdit {
  path: string;
  summary: string;
}

export interface EditorContext {
  active_path: string | null;
  selection: Selection | null;
  recent_edits: RecentEdit[];
}

export interface AgentStatus {
  state: "running" | "stopped";
  project_id: number | null;
  session_id: string | null;
}

export interface HistoryMessage {
  role: string;
  content: string;
  created_at: string;
}

export interface SessionSummary {
  session_id: string;
  summary: string;
  created_at: string;
}

export interface ChatHistory {
  messages: HistoryMessage[];
  summaries: SessionSummary[];
}

export type AgentEvent =
  | { event: "delta"; run_id: number; text: string }
  | { event: "message"; run_id: number; role: string; text: string }
  | { event: "tool"; run_id: number; name: string; input: unknown }
  | { event: "result"; run_id: number; subtype: string; total_cost_usd: number; num_turns: number }
  | { event: "error"; run_id: number; message: string }
  | { event: "status"; state: "running" | "stopped" }
  | { event: "propose_edit"; run_id: number; edit_id: number; path: string; new_content: string };

export const loadHistory = (): Promise<ChatHistory> => invoke("load_history");

export const agentStart = (): Promise<AgentStatus> => invoke("agent_start");

export const agentSend = (text: string, context: EditorContext): Promise<void> =>
  invoke("agent_send", { text, context });

export const agentResolveEdit = (
  editId: number,
  decision: "accepted" | "rejected",
): Promise<void> => invoke("agent_resolve_edit", { editId, decision });

export const agentStop = (): Promise<AgentStatus> => invoke("agent_stop");

export const agentStatus = (): Promise<AgentStatus> => invoke("agent_status");

export const listenAgentEvent = (
  cb: (e: AgentEvent) => void,
): Promise<UnlistenFn> =>
  listen<AgentEvent>("agent://event", (e) => cb(e.payload));

// ── LSP seam ─────────────────────────────────────────────────────────────────

export const lspStart = (language: LspLanguage): Promise<LspStatus> =>
  invoke("lsp_start", { language });

export const lspSend = (payload: string): Promise<void> =>
  invoke("lsp_send", { payload });

export const lspStop = (): Promise<LspStatus> => invoke("lsp_stop");

export const lspStatus = (): Promise<LspStatus> => invoke("lsp_status");

export const listenLspMessage = (
  cb: (m: LspMessage) => void,
): Promise<UnlistenFn> =>
  listen<LspMessage>("lsp-message", (e) => cb(e.payload));
