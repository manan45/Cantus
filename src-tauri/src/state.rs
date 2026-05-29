use crate::agent::AgentProcess;
use crate::lsp::LspProcess;
use notify::RecommendedWatcher;
use portable_pty::{Child, MasterPty};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::Mutex;

pub struct OpenProject {
    pub id: i64,
    pub root: PathBuf,
    pub _watcher: RecommendedWatcher,
}

pub struct TerminalHandle {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
}

pub struct AppState {
    pub db: SqlitePool,
    pub open: Mutex<Option<OpenProject>>,
    pub terminals: Mutex<HashMap<u32, TerminalHandle>>,
    pub next_terminal_id: AtomicU32,
    pub agent: Mutex<Option<AgentProcess>>,
    /// Monotonic across the whole app lifetime; never reset. Each spawn claims a
    /// fresh generation so a stale reader thread can never match a newer process.
    pub agent_generation: AtomicU32,
    pub lsp: Mutex<Option<LspProcess>>,
    pub lsp_generation: AtomicU32,
}
