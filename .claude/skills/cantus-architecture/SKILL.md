---
name: cantus-architecture
description: The architecture, conventions, data model, and scope boundaries for the Cantus IDE. Consult before any non-trivial change to the backend, frontend, agent seam, IPC contract, or data store. Use to answer "where does this go", "what's in scope", "what's the convention here", or "how do the layers talk".
---

# Cantus architecture (read before non-trivial work)

Cantus is a **Claude-first, Tauri-based desktop coding environment**. One thesis: *Claude is a first-class citizen, not a bolted-on sidebar.* It composes mature components — Monaco, xterm.js, libgit2, SQLite, the Claude Agent SDK — into one coherent app where the agent is natively aware of what you're editing. Source of truth is `prd.md` at the repo root; this skill is the build-time digest. macOS Apple Silicon first.

## Layer split

```
┌─────────────────────────── Frontend (OS webview, TypeScript + React) ───────────────────────────┐
│  Four panes: file tree │ Monaco editor │ xterm.js terminal │ Claude agent chat                    │
│  Coordination layer: shared app-state store · command palette · keybindings · theme              │
│  Owns: all UI. Mirrors backend state. Captures live editor context for the agent.                │
└───────────────────────────────────────────── IPC (typed Tauri commands + events) ────────────────┘
┌─────────────────────────── Backend (Rust core, `src-tauri/`) ────────────────────────────────────┐
│  Privileged ops only: git (git2/libgit2) · PTY · SQLite · scoped FS read/watch · agent subprocess │
│  Authoritative for filesystem / process / data-store state.                                       │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
                                              │ stdio
                              ┌───────────────▼───────────────┐
                              │  Claude Agent SDK (subprocess) │  inherits agent loop, tools,
                              │  Python or TypeScript SDK      │  subagents, skills, MCP, hooks
                              └────────────────────────────────┘
```

## Component map (what wraps what)

| Capability | Component | Layer |
|---|---|---|
| Code editor | Monaco (MIT) | Frontend |
| Terminal | xterm.js + backend-spawned PTY | Frontend + Backend |
| Version control | libgit2 via the `git2` crate | Backend |
| AI chat (current) | Embedded `claude` CLI in a PTY; sessions from Claude Code's own store | Frontend + Backend |
| AI agent (dormant) | Claude Agent SDK subprocess (`agent.rs` + `ChatPane.tsx`) — built, not mounted | Backend ⇄ both |
| Local store | SQLite | Backend |
| Coordination | command palette, shared state, keybindings, theme, top bar | Frontend |

## Claude integration — current implementation (post Phase-A)

The product pivoted the chat experience to the **real `claude` CLI**, not the Agent SDK:

- **Chat = embedded `claude` CLI in a PTY.** The right pane (`ChatSessions.tsx`) runs `claude` in a tabbed terminal. `pty_spawn(cols, rows, program?, args?)` takes args so a tab can spawn `claude --resume <id>`.
- **Sessions = Claude Code's own store.** `list_sessions` (`sessions.rs`) reads `~/.claude/projects/<cwd with / and . → ->/*.jsonl` for the open project: id (file stem), title (`aiTitle` line, else first user line), mtime (epoch ms), gitBranch, message count. The pane lands on this history; a row spawns `claude --resume <id>`; `+` spawns a fresh `claude`.
- **Skills / Agents / Workflows / Sessions = an app-wide top bar** (`TopBar.tsx`). `list_claude_assets` (`assets.rs`) scans `~/.claude/{skills,agents,workflows}` (user) and `<project>/.claude/{…}` (project). "Run" prefills an invocation into the active chat PTY (`/skill `, "Use the … agent to ", "Run the … workflow"). The top views overlay the workspace (`.workspace-overlay`) so panes/PTYs stay alive.
- **Multiple terminals + multiple chats** are just multiple PTYs in a reusable `TerminalTabs.tsx`; the backend PTY registry (`HashMap<u32, …>`) already multiplexed by id.
- **Read-only `~/.claude` exception:** `sessions.rs`/`assets.rs` read the user's own Claude data *outside* the project sandbox. This is a deliberate, strictly **read-only** exception to rule 5 — never write under `~/.claude`, don't route these through `resolve_scoped`.
- **The Agent SDK path is dormant**, not deleted: `agent.rs`, `ChatPane.tsx`, the `agent_*` commands, `propose_edit → Monaco accept/reject`, and the `messages`/`session_summaries` SQLite tables exist but are not wired into the live UI. Its `propose_edit` diff flow is the basis for any future "surface Claude's edits like Cursor" work.
- **Edits made by the CLI are NOT yet surfaced.** When `claude` writes a file, the FS watcher refreshes the tree and flags *already-open* buffers as externally changed — it does not auto-open the file or show a diff. Cursor-like edit surfacing is unbuilt (Phase B).

## The five rules (these override convenience)

1. **IPC is the only contract.** Frontend ⇄ backend talk exclusively through typed Tauri commands (request/response) and events (backend→frontend streams: PTY bytes, agent tokens, git updates). No hidden side channels. Keep frontend bindings in one typed module; keep Rust handlers thin (validate → privileged work → typed result/error).
2. **Backend is authoritative; frontend mirrors.** Anything touching the filesystem, a process, or the store lives in Rust and is the source of truth. The frontend reflects it via command results and events — never keeps a copy that can silently drift.
3. **Errors are typed values across IPC.** No `anyhow`/`Box<dyn Error>` leaking over the bridge. Define explicit serializable error enums; the frontend must render a useful message.
4. **Keep the Rust surface minimal (anti-scope-creep, PRD §11).** If logic can safely live in TypeScript, it does. The backend is process spawning, file I/O, git, SQLite, and the agent subprocess — not business logic.
5. **Local-first / private.** The *only* thing leaving the machine is the agent's own model API calls. No other outbound network. Agent file access is scoped to the open project dir.

## Clean-code doctrine (applies to every change)

Cantus is greenfield — write it lean and keep it lean. Every agent follows this; `clean-code` enforces it as a pass, `cantus-reviewer` flags violations. A `PostToolUse` hook (`.claude/hooks/format.sh`) auto-formats edits, so don't hand-format.

1. **Better architecture.** Right layer, smallest correct design, no needless indirection. Names carry meaning so code needs little explaining.
2. **Less code.** Fewer lines for the same behavior. Delete duplication; prefer idiomatic/std constructs over hand-rolled ones; don't extract a helper used once.
3. **Fewer comments.** Only comments that explain *why* something non-obvious is done. No restating code, no history narration, no section banners.
4. **Targeted diff.** Touch only what the task needs. No drive-by reformatting of untouched lines, no unrelated edits.
5. **No legacy fallbacks.** No backwards-compat shims, no old-path/new-path branches, no dead flags, no `if version <` guards. There is nothing to be compatible with — pick the one correct path.
6. **No unwanted code.** No dead code, unused params/imports, commented-out blocks, or speculative "might need later" abstractions. YAGNI.

## How context reaches the agent (no RAG — PRD §7)

- **Live editor context:** frontend always knows open file + selection + recent edits; ships it as *structured, minimal* context per request. Don't dump the whole project.
- **Agent-driven file access:** the SDK reads/greps/navigates with its own tools; grant scoped access and let it pull what it needs.
- **SDK-managed working context:** rely on the SDK's in-session compaction + Claude's large window. **Do not build embeddings/vector store/RAG** — deliberately deferred (§7.4). Revisit only with measured evidence of failure.
- **Cross-session memory:** SQLite persists chat + agent events; on resume, re-seed with a *summary* of prior sessions + recent history, not the full transcript.

## Data model (SQLite, source of truth, never leaves device)

- `projects(id, root_path, created_at)`
- `files(id, project_id, path, content_hash, updated_at)` — hashes for change detection, **not** the agent's read path
- `messages(id, project_id, session_id, role, content, created_at)`
- `agent_events(id, project_id, agent_id, task_id, kind, content, created_at)`
- `session_summaries(id, project_id, session_id, summary, created_at)`

## Scope boundary

**Phase 1 MVP (shipped):** Tauri shell (macOS ARM) · four-pane layout · open any local folder · Monaco editing + syntax highlighting + ≥1 language server (Python first) · terminal via backend PTY · basic git (status/stage/commit + inline diff) · SQLite persistence · command palette + baseline keybindings.

**Phase A (shipped):** multiple shell terminals in tabs (bottom) · embedded `claude` CLI chat with per-project session history + new/resume tabs (right) · app-wide top bar — Skills / Agents / Workflows / Sessions — browse + launch into the active chat. See "Claude integration" above.

**Phase B (shipped):**
- **Edit surfacing** — the FS watcher feeds a `ChangesStrip` (store `agentChanges`) listing files changed by the CLI (filtered to git-tracked, editor saves excluded via buffer hash); clicking opens the diff, and the diff auto-reveals while a chat is active but never yanks you out of the file you're editing. `git diff` uses `include_untracked` + `show_untracked_content` so newly-created files diff as all-added.
- **Orchestrator tab** (`OrchestratorView.tsx`, 5th top-bar view) — two-step: **(1) Prepare** spawns one `claude` session seeded to create/modify the project's `.claude/{agents,skills,workflows}` for the goal (modify-not-duplicate); **(2) Start orchestration** (gated on prepared) fans out one worker `claude` PTY per task, each told to use those assets. Workers seeded race-free via a positional prompt arg (`claude "<prompt>"`), watchable as `TerminalTabs`.

**Phase B (deeper, not yet built):** parent-plans-then-dispatches (auto-derive tasks), real worker status (Octogent's `todo.md`/tentacle model — workers report progress to a file the UI reads), cross-worker coordination.

**Still out:** debugging/DAP, multi-project, vector retrieval, Windows/Linux.

## Stack

Tauri · Rust (backend) · TypeScript + React (frontend) · Monaco · xterm.js + PTY · `git2` · Claude Agent SDK · SQLite · (Phase 2: DAP/debugpy).

## Who owns what (delegate to the right agent)

- `rust-tauri-backend` — `src-tauri/`: IPC handlers, git2, PTY, SQLite, FS.
- `react-frontend` — `src/`: panes, Monaco/xterm.js, shared state, palette, IPC bindings.
- `agent-sdk-bridge` — the agent seam: subprocess lifecycle, streaming, context injection, edit→diff, session memory.
- `cantus-reviewer` — review before landing.

When a change spans the IPC boundary, define the command/event signature explicitly and make sure both the backend handler and the frontend binding are accounted for.
