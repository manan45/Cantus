use crate::error::CommandError;
use crate::state::{AppState, TerminalHandle};
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: u32,
}

pub fn spawn(
    state: &State<'_, AppState>,
    app: AppHandle,
    cols: u16,
    rows: u16,
    program: Option<String>,
    args: Option<Vec<String>>,
) -> Result<u32, CommandError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| CommandError::Pty(e.to_string()))?;

    let cwd = {
        let guard = state.open.lock().unwrap();
        guard.as_ref().map(|p| p.root.clone()).or_else(dirs_cwd)
    };

    let mut cmd = match program {
        // A named program (e.g. "claude") runs with the parent environment so it
        // resolves on PATH, plus a usable TERM since it never sources a profile.
        Some(prog) => {
            let mut c = CommandBuilder::new(&prog);
            if let Some(ref argv) = args {
                for a in argv {
                    c.arg(a);
                }
            }
            for (k, v) in std::env::vars() {
                c.env(k, v);
            }
            c.env("TERM", "xterm-256color");
            c
        }
        None => CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())),
    };
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| CommandError::Pty(e.to_string()))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| CommandError::Pty(e.to_string()))?;

    let id = state.next_terminal_id.fetch_add(1, Ordering::Relaxed);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| CommandError::Pty(e.to_string()))?;

    state.terminals.lock().unwrap().insert(
        id,
        TerminalHandle {
            master: pair.master,
            writer,
            child,
        },
    );

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = STANDARD.encode(&buf[..n]);
                    let _ = app.emit("pty://output", PtyOutput { id, data });
                }
            }
        }
        // Shell exited: drop its handle so the registry doesn't leak. The frontend
        // sees pty://exit and skips pty_kill, so this is the only cleanup path.
        app.state::<AppState>()
            .terminals
            .lock()
            .unwrap()
            .remove(&id);
        let _ = app.emit("pty://exit", PtyExit { id });
    });

    Ok(id)
}

pub fn write(state: &State<'_, AppState>, id: u32, data: String) -> Result<(), CommandError> {
    let mut guard = state.terminals.lock().unwrap();
    let handle = guard
        .get_mut(&id)
        .ok_or_else(|| CommandError::NotFound(format!("terminal {id}")))?;
    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| CommandError::Pty(e.to_string()))
}

pub fn resize(
    state: &State<'_, AppState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    let guard = state.terminals.lock().unwrap();
    let handle = guard
        .get(&id)
        .ok_or_else(|| CommandError::NotFound(format!("terminal {id}")))?;
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| CommandError::Pty(e.to_string()))
}

pub fn kill(state: &State<'_, AppState>, id: u32) -> Result<(), CommandError> {
    let mut guard = state.terminals.lock().unwrap();
    let mut handle = guard
        .remove(&id)
        .ok_or_else(|| CommandError::NotFound(format!("terminal {id}")))?;
    handle
        .child
        .kill()
        .map_err(|e| CommandError::Pty(e.to_string()))
}

// Returns the user's home directory as a fallback cwd.
fn dirs_cwd() -> Option<std::path::PathBuf> {
    std::env::var("HOME").ok().map(std::path::PathBuf::from)
}

// Bring Read into scope for the reader thread.
use std::io::Read;
