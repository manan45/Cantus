use crate::error::CommandError;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// ── Public types (IPC contract) ───────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct AgentStatus {
    pub state: AgentLifecycle,
    pub project_id: Option<i64>,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentLifecycle {
    Running,
    Stopped,
}

/// Tagged-union emitted as `agent://event`.  The `run_id` field lets the chat
/// pane group/discard tokens from stale or replaced runs (same role as the PTY
/// `id` field).
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Streamed partial token from `includePartialMessages`.
    Delta { run_id: u32, text: String },
    /// Completed message (assistant or user turn).
    Message {
        run_id: u32,
        role: String,
        text: String,
    },
    /// Tool invocation for live display (read-only tools in M4).
    Tool {
        run_id: u32,
        name: String,
        input: Value,
    },
    /// Terminal SDK result message.
    Result {
        run_id: u32,
        subtype: String,
        total_cost_usd: f64,
        num_turns: u32,
    },
    /// SDK or host-level error.
    Error { run_id: u32, message: String },
    /// Lifecycle change: emitted on spawn and on host exit.
    Status { state: AgentLifecycle },
    /// Host requests the user accept/reject a proposed file edit.
    ProposeEdit {
        run_id: u32,
        edit_id: u32,
        path: String,
        new_content: String,
    },
}

/// Cursor selection in the active editor buffer. All positions are 0-based.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct Selection {
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub text: String,
}

/// A recent file edit the user made, summarized (no full body).
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct RecentEdit {
    pub path: String,
    pub summary: String,
}

/// Minimal editor context shipped with each prompt so the agent is
/// natively aware of what the user is looking at.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct EditorContext {
    pub active_path: Option<String>,
    pub selection: Option<Selection>,
    pub recent_edits: Vec<RecentEdit>,
}

/// The user's decision on a proposed edit.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum EditDecision {
    Accepted,
    Rejected,
}

// ── Internal process handle ───────────────────────────────────────────────────

pub struct AgentProcess {
    pub child: Child,
    pub stdin: ChildStdin,
    /// Generation claimed from `AppState::agent_generation` at spawn. The reader
    /// thread captures it and only self-cleans if the live process still carries
    /// it, so a stale thread can never clobber a newer process.
    pub generation: u32,
    pub project_id: i64,
    pub session_id: String,
}

// ── Host-script message shapes (SDK output on stdout) ────────────────────────

/// The host emits `{ run_id, type, ...rest }` for every SDK message.
/// `run_id` is the host's monotonic counter, incremented per prompt.
/// For internal host messages (e.g. session_summary) run_id may be absent.
#[derive(Deserialize)]
struct HostMessage {
    #[serde(default)]
    run_id: u32,
    #[serde(rename = "type")]
    kind: String,
    #[serde(flatten)]
    rest: Value,
}

/// Normalize one LDJSON line from the host into an `AgentEvent`, or `None`
/// for unknown/internal SDK bookkeeping lines.
fn normalize(line: &str) -> Option<AgentEvent> {
    let msg: HostMessage = serde_json::from_str(line).ok()?;
    let run_id = msg.run_id;
    match msg.kind.as_str() {
        // Partial streamed token (SDKPartialAssistantMessage, includePartialMessages: true)
        "partial_assistant_message" => {
            let text = extract_content_text(&msg.rest["message"]["content"])?;
            Some(AgentEvent::Delta { run_id, text })
        }
        // Completed assistant turn (SDKAssistantMessage)
        "assistant" => {
            let text = extract_content_text(&msg.rest["message"]["content"])?;
            Some(AgentEvent::Message {
                run_id,
                role: "assistant".into(),
                text,
            })
        }
        // User echo (SDKUserMessage)
        "user" => {
            let text = extract_content_text(&msg.rest["message"]["content"])?;
            Some(AgentEvent::Message {
                run_id,
                role: "user".into(),
                text,
            })
        }
        // Tool invocation
        "tool_use" => {
            let name = msg.rest["name"].as_str()?.to_owned();
            let input = msg.rest["input"].clone();
            Some(AgentEvent::Tool {
                run_id,
                name,
                input,
            })
        }
        // Terminal result (SDKResultMessage)
        "result" => {
            let subtype = msg.rest["subtype"].as_str().unwrap_or("").to_owned();
            let total_cost_usd = msg.rest["total_cost_usd"].as_f64().unwrap_or(0.0);
            let num_turns = msg.rest["num_turns"].as_u64().unwrap_or(0) as u32;
            Some(AgentEvent::Result {
                run_id,
                subtype,
                total_cost_usd,
                num_turns,
            })
        }
        // Host-injected error (not an SDK type; added by index.mjs catch block)
        "error" => {
            let message = msg.rest["message"]
                .as_str()
                .unwrap_or("unknown error")
                .to_owned();
            Some(AgentEvent::Error { run_id, message })
        }
        // Host requests user accept/reject a file edit before the agent continues.
        "propose_edit" => {
            let edit_id = msg.rest["edit_id"].as_u64()? as u32;
            let path = msg.rest["path"].as_str()?.to_owned();
            let new_content = msg.rest["new_content"].as_str()?.to_owned();
            Some(AgentEvent::ProposeEdit {
                run_id,
                edit_id,
                path,
                new_content,
            })
        }
        // session_summary is consumed by the reader for persistence — not forwarded.
        // system, permission_denied, task_progress, hook_* — informational, not wired in M4.
        _ => None,
    }
}

/// Extract concatenated text from a content array (handles both full `text` blocks
/// and partial `partial_text` blocks used in streaming).
fn extract_content_text(content: &Value) -> Option<String> {
    let arr = content.as_array()?;
    let text: String = arr
        .iter()
        .filter_map(|block| {
            block
                .get("partial_text")
                .or_else(|| block.get("text"))
                .and_then(Value::as_str)
        })
        .collect();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn now_iso() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn mint_session_id() -> String {
    // Epoch-seconds + generation counter gives a monotonic, unique-enough id
    // without pulling in a uuid crate.
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!(
        "{}-{seq}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    )
}

// ── Broker functions (called by command handlers) ─────────────────────────────

pub fn start(
    state: &AppState,
    app: AppHandle,
    project_id: i64,
    cwd: std::path::PathBuf,
) -> Result<AgentStatus, CommandError> {
    let mut guard = state.agent.lock().unwrap();

    // Idempotent: already running for the same project — return current status.
    if let Some(ref p) = *guard {
        if p.project_id == project_id {
            return Ok(AgentStatus {
                state: AgentLifecycle::Running,
                project_id: Some(project_id),
                session_id: Some(p.session_id.clone()),
            });
        }
        // Different project — tear down before spawning for the new one.
        wind_down(guard.take().unwrap());
    }

    let host_script = locate_host_script(&app)?;
    let node = locate_node(&app)?;

    let mut child = Command::new(&node)
        .arg(&host_script)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| CommandError::Agent(format!("spawn failed: {e}")))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| CommandError::Agent("failed to open stdin".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CommandError::Agent("failed to open stdout".into()))?;

    let generation = state
        .agent_generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let session_id = mint_session_id();

    // Load seed: latest summary + last 20 messages for this project.
    let seed = tauri::async_runtime::block_on(load_seed(&state.db, project_id))
        .map_err(|e| CommandError::Db(e.to_string()))?;

    if let Some((summary, recent)) = seed {
        let seed_line = serde_json::json!({
            "type": "seed",
            "summary": summary,
            "recent": recent,
        });
        let mut buf = serde_json::to_vec(&seed_line).unwrap();
        buf.push(b'\n');
        stdin
            .write_all(&buf)
            .map_err(|e| CommandError::Agent(format!("seed write failed: {e}")))?;
    }

    *guard = Some(AgentProcess {
        child,
        stdin,
        generation,
        project_id,
        session_id: session_id.clone(),
    });

    // Reader thread: parse LDJSON from the host, normalize, emit AgentEvents,
    // and persist Message/Tool/Result rows to SQLite as a side effect.
    let app_thread = app.clone();
    let session_id_thread = session_id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.is_empty() => {
                    // Check for session_summary before normalize() so we can
                    // persist it without forwarding it to the frontend.
                    if let Ok(v) = serde_json::from_str::<Value>(&l) {
                        if v.get("type").and_then(Value::as_str) == Some("session_summary") {
                            if let Some(summary) = v["summary"].as_str() {
                                let db = app_thread.state::<AppState>().db.clone();
                                let summary = summary.to_owned();
                                let sid = session_id_thread.clone();
                                let ts = now_iso();
                                tauri::async_runtime::block_on(async move {
                                    let _ = sqlx::query(
                                        "INSERT INTO session_summaries \
                                         (project_id, session_id, summary, created_at) \
                                         VALUES (?1, ?2, ?3, ?4)",
                                    )
                                    .bind(project_id)
                                    .bind(&sid)
                                    .bind(&summary)
                                    .bind(&ts)
                                    .execute(&db)
                                    .await;
                                });
                            }
                            continue;
                        }
                    }

                    if let Some(event) = normalize(&l) {
                        persist_event(&app_thread, project_id, &session_id_thread, &event);
                        let _ = app_thread.emit("agent://event", event);
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        // Host stdout closed → process exited. Self-clean if still our generation.
        let state = app_thread.state::<AppState>();
        let mut g = state.agent.lock().unwrap();
        if g.as_ref().map(|p| p.generation) == Some(generation) {
            *g = None;
        }
        let _ = app_thread.emit(
            "agent://event",
            AgentEvent::Status {
                state: AgentLifecycle::Stopped,
            },
        );
    });

    let _ = app.emit(
        "agent://event",
        AgentEvent::Status {
            state: AgentLifecycle::Running,
        },
    );

    Ok(AgentStatus {
        state: AgentLifecycle::Running,
        project_id: Some(project_id),
        session_id: Some(session_id),
    })
}

/// Persist a normalized AgentEvent to SQLite on the reader thread.
/// Runs synchronously via block_on — acceptable because this is a dedicated
/// std::thread, not the async Tokio runtime thread.
fn persist_event(app: &AppHandle, project_id: i64, session_id: &str, event: &AgentEvent) {
    let db = app.state::<AppState>().db.clone();
    let ts = now_iso();
    match event {
        AgentEvent::Message { role, text, .. } => {
            let role = role.clone();
            let text = text.clone();
            let sid = session_id.to_owned();
            tauri::async_runtime::block_on(async move {
                let _ = sqlx::query(
                    "INSERT INTO messages (project_id, session_id, role, content, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .bind(project_id)
                .bind(&sid)
                .bind(&role)
                .bind(&text)
                .bind(&ts)
                .execute(&db)
                .await;
            });
        }
        AgentEvent::Tool { name, input, .. } => {
            let content = serde_json::json!({ "name": name, "input": input }).to_string();
            tauri::async_runtime::block_on(async move {
                let _ = sqlx::query(
                    "INSERT INTO agent_events \
                     (project_id, agent_id, task_id, kind, content, created_at) \
                     VALUES (?1, 'default', NULL, 'tool_use', ?2, ?3)",
                )
                .bind(project_id)
                .bind(&content)
                .bind(&ts)
                .execute(&db)
                .await;
            });
        }
        AgentEvent::Result {
            subtype,
            total_cost_usd,
            num_turns,
            ..
        } => {
            let content = serde_json::json!({
                "subtype": subtype,
                "total_cost_usd": total_cost_usd,
                "num_turns": num_turns,
            })
            .to_string();
            tauri::async_runtime::block_on(async move {
                let _ = sqlx::query(
                    "INSERT INTO agent_events \
                     (project_id, agent_id, task_id, kind, content, created_at) \
                     VALUES (?1, 'default', NULL, 'result', ?2, ?3)",
                )
                .bind(project_id)
                .bind(&content)
                .bind(&ts)
                .execute(&db)
                .await;
            });
        }
        _ => {}
    }
}

async fn load_seed(
    db: &sqlx::SqlitePool,
    project_id: i64,
) -> Result<Option<(String, Vec<serde_json::Value>)>, sqlx::Error> {
    let summary: Option<String> = sqlx::query_scalar(
        "SELECT summary FROM session_summaries \
         WHERE project_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;

    // Pull the 20 newest, then restore chronological order for the seed.
    let mut rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT role, content FROM messages \
         WHERE project_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 20",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    rows.reverse();

    if summary.is_none() && rows.is_empty() {
        return Ok(None);
    }

    let recent: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
        .collect();

    Ok(Some((summary.unwrap_or_default(), recent)))
}

pub fn send(
    agent: &Mutex<Option<AgentProcess>>,
    text: String,
    context: EditorContext,
) -> Result<(), CommandError> {
    write_stdin(
        agent,
        &serde_json::json!({ "type": "prompt", "text": text, "context": context }),
    )
}

pub fn resolve_edit(
    agent: &Mutex<Option<AgentProcess>>,
    edit_id: u32,
    decision: EditDecision,
) -> Result<(), CommandError> {
    write_stdin(
        agent,
        &serde_json::json!({ "type": "resolve_edit", "edit_id": edit_id, "decision": decision }),
    )
}

fn write_stdin(
    agent: &Mutex<Option<AgentProcess>>,
    value: &serde_json::Value,
) -> Result<(), CommandError> {
    let mut guard = agent.lock().unwrap();
    let proc = guard
        .as_mut()
        .ok_or_else(|| CommandError::Agent("agent not running".into()))?;
    let mut buf = serde_json::to_vec(value).unwrap();
    buf.push(b'\n');
    proc.stdin
        .write_all(&buf)
        .map_err(|e| CommandError::Agent(format!("stdin write failed: {e}")))
}

pub fn stop(agent: &Mutex<Option<AgentProcess>>) -> Result<AgentStatus, CommandError> {
    let proc = agent.lock().unwrap().take();
    if let Some(proc) = proc {
        wind_down(proc);
    }
    Ok(AgentStatus {
        state: AgentLifecycle::Stopped,
        project_id: None,
        session_id: None,
    })
}

pub fn status(agent: &Mutex<Option<AgentProcess>>) -> AgentStatus {
    let guard = agent.lock().unwrap();
    match guard.as_ref() {
        Some(p) => AgentStatus {
            state: AgentLifecycle::Running,
            project_id: Some(p.project_id),
            session_id: Some(p.session_id.clone()),
        },
        None => AgentStatus {
            state: AgentLifecycle::Stopped,
            project_id: None,
            session_id: None,
        },
    }
}

/// Ask the host to emit a final session_summary, then tear it down off the
/// caller's thread. Ownership of `proc` is moved here, so the agent mutex is
/// already released — this never blocks an async command or the Tokio runtime.
///
/// On receiving `summarize` the host emits the summary (persisted by the reader
/// thread) and exits, closing its stdout so the reader self-cleans and emits
/// `Stopped`. The detached thread waits for that exit, force-killing after a
/// grace period if the host hangs.
fn wind_down(mut proc: AgentProcess) {
    std::thread::spawn(move || {
        let _ = proc.stdin.write_all(b"{\"type\":\"summarize\"}\n");
        drop(proc.stdin);
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
        loop {
            match proc.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if std::time::Instant::now() >= deadline => break,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    });
}

// ── Path resolution ───────────────────────────────────────────────────────────

/// Resolve the bundled Node sidecar path.
///
/// In the signed .app bundle Tauri places the sidecar next to the main
/// executable (`Contents/MacOS/node`). During `tauri dev` the sidecar is not
/// present, so we fall back to the system node found on PATH — development
/// machines are expected to have it.
fn locate_node(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    use tauri::Manager;
    // Bundle: sidecar lives in the same dir as the main exe.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            let bundled = bin_dir.join("node");
            if bundled.exists() {
                return Ok(bundled);
            }
        }
    }
    // tauri dev: try resource_dir parent chain then common install paths.
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join("node");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    for path in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        let p = std::path::Path::new(path);
        if p.exists() {
            return Ok(p.to_path_buf());
        }
    }
    if let Ok(out) = Command::new("which").arg("node").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            if !s.is_empty() {
                return Ok(std::path::PathBuf::from(s));
            }
        }
    }
    Err(CommandError::Agent("node runtime not found".into()))
}

/// Resolve the agent-host entry point.
///
/// In the signed .app bundle it lives in `Contents/Resources/agent-host/index.mjs`
/// (placed there by the `resources` bundle config). During `tauri dev` we walk up
/// from the executable until we find the source-tree copy.
fn locate_host_script(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    use tauri::Manager;
    // Bundle: resources dir contains agent-host/.
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("agent-host").join("index.mjs");
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    // tauri dev: walk up from the exe to find the workspace copy.
    let mut dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    while let Some(d) = dir {
        let candidate = d.join("agent-host").join("index.mjs");
        if candidate.exists() {
            return Ok(candidate);
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
    Err(CommandError::Agent(
        "agent-host/index.mjs not found — run `npm install` in agent-host/".into(),
    ))
}
