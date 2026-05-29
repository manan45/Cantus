use crate::error::CommandError;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// ── Public types (IPC contract) ───────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LspLanguage {
    Python,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LspLifecycle {
    Running,
    Stopped,
}

#[derive(Debug, Serialize, Clone)]
pub struct LspStatus {
    pub state: LspLifecycle,
    pub language: Option<LspLanguage>,
    pub generation: Option<u32>,
    pub root_path: Option<String>,
}

// ── Internal process handle ───────────────────────────────────────────────────

pub struct LspProcess {
    pub child: Child,
    pub stdin: ChildStdin,
    pub generation: u32,
    pub language: LspLanguage,
    pub root: String,
}

// ── Event payload ─────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct LspMessage {
    generation: u32,
    payload: String,
}

// ── Broker functions ──────────────────────────────────────────────────────────

pub fn start(
    state: &AppState,
    app: AppHandle,
    language: LspLanguage,
    root: String,
) -> Result<LspStatus, CommandError> {
    let mut guard = state.lsp.lock().unwrap();

    if let Some(ref p) = *guard {
        if p.language == language && p.root == root {
            return Ok(LspStatus {
                state: LspLifecycle::Running,
                language: Some(p.language.clone()),
                generation: Some(p.generation),
                root_path: Some(p.root.clone()),
            });
        }
        tear_down(guard.take().unwrap());
    }

    let pyright = which_pyright()?;

    let mut child = Command::new(&pyright)
        .arg("--stdio")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| CommandError::Lsp(format!("spawn failed: {e}")))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| CommandError::Lsp("failed to open stdin".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CommandError::Lsp("failed to open stdout".into()))?;

    let generation = state.lsp_generation.fetch_add(1, Ordering::Relaxed);

    *guard = Some(LspProcess {
        child,
        stdin,
        generation,
        language: language.clone(),
        root: root.clone(),
    });

    // Reader thread: parse Content-Length framed messages and emit lsp-message.
    // Self-cleans on EOF only if still its generation (staleness guard).
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            // Read headers until blank line.
            let mut content_length: Option<usize> = None;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        cleanup_on_eof(&app, generation);
                        return;
                    }
                    Ok(_) => {}
                }
                let line = line.trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    break;
                }
                if let Some(val) = line.strip_prefix("Content-Length: ") {
                    content_length = val.parse().ok();
                }
            }

            let len = match content_length {
                Some(n) => n,
                None => continue,
            };

            let mut body = vec![0u8; len];
            if reader.read_exact(&mut body).is_err() {
                cleanup_on_eof(&app, generation);
                return;
            }

            let payload = match String::from_utf8(body) {
                Ok(s) => s,
                Err(_) => continue,
            };

            // Drop messages from stale servers; generation guard mirrors PTY id / agent run_id.
            let live_gen = app
                .state::<AppState>()
                .lsp_generation
                .load(Ordering::Relaxed)
                .saturating_sub(1);
            if live_gen != generation {
                continue;
            }

            let _ = app.emit(
                "lsp-message",
                LspMessage {
                    generation,
                    payload,
                },
            );
        }
    });

    Ok(LspStatus {
        state: LspLifecycle::Running,
        language: Some(language),
        generation: Some(generation),
        root_path: Some(root),
    })
}

pub fn send(lsp: &Mutex<Option<LspProcess>>, payload: String) -> Result<(), CommandError> {
    let mut guard = lsp.lock().unwrap();
    let proc = guard
        .as_mut()
        .ok_or_else(|| CommandError::Lsp("language server not running".into()))?;
    let framed = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
    proc.stdin
        .write_all(framed.as_bytes())
        .map_err(|e| CommandError::Lsp(format!("stdin write failed: {e}")))
}

pub fn stop(lsp: &Mutex<Option<LspProcess>>) -> LspStatus {
    if let Some(proc) = lsp.lock().unwrap().take() {
        tear_down(proc);
    }
    LspStatus {
        state: LspLifecycle::Stopped,
        language: None,
        generation: None,
        root_path: None,
    }
}

pub fn status(lsp: &Mutex<Option<LspProcess>>) -> LspStatus {
    match lsp.lock().unwrap().as_ref() {
        Some(p) => LspStatus {
            state: LspLifecycle::Running,
            language: Some(p.language.clone()),
            generation: Some(p.generation),
            root_path: Some(p.root.clone()),
        },
        None => LspStatus {
            state: LspLifecycle::Stopped,
            language: None,
            generation: None,
            root_path: None,
        },
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn cleanup_on_eof(app: &AppHandle, generation: u32) {
    let state = app.state::<AppState>();
    let mut g = state.lsp.lock().unwrap();
    if g.as_ref().map(|p| p.generation) == Some(generation) {
        *g = None;
    }
}

/// Kill + wait on a detached thread so the async command never blocks.
fn tear_down(mut proc: LspProcess) {
    std::thread::spawn(move || {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    });
}

/// Probe PATH then common install locations for the pyright-langserver binary.
/// Mirrors `which_node` in agent.rs.
fn which_pyright() -> Result<std::path::PathBuf, CommandError> {
    for candidate in &[
        "pyright-langserver",
        "/usr/local/bin/pyright-langserver",
        "/opt/homebrew/bin/pyright-langserver",
        "/usr/bin/pyright-langserver",
    ] {
        let path = std::path::Path::new(candidate);
        if path.is_absolute() {
            if path.exists() {
                return Ok(path.to_path_buf());
            }
        } else if let Ok(out) = Command::new("which").arg(candidate).output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_owned();
                if !s.is_empty() {
                    return Ok(std::path::PathBuf::from(s));
                }
            }
        }
    }
    Err(CommandError::Lsp(
        "pyright-langserver not found; install pyright via npm or pip".into(),
    ))
}
