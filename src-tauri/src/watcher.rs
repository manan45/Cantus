use crate::commands::hash_hex;
use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct FsChange {
    pub path: String,
    pub kind: &'static str,
    /// Hash of the file's current on-disk content; `None` for removals.
    /// The frontend compares it against the open buffer's known hash to
    /// suppress events caused by its own writes.
    pub content_hash: Option<String>,
}

pub fn start(root: PathBuf, app: AppHandle) -> notify::Result<RecommendedWatcher> {
    // Clone so the closure owns one copy and the watch() call below keeps the other.
    let closure_root = root.clone();
    let mut watcher = recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        let kind = match event.kind {
            EventKind::Create(_) => "created",
            EventKind::Modify(_) => "modified",
            EventKind::Remove(_) => "removed",
            _ => return,
        };
        for abs in event.paths {
            let Ok(rel) = abs.strip_prefix(&closure_root) else {
                continue;
            };
            let path = rel.to_string_lossy().into_owned();
            let content_hash = std::fs::read(&abs).ok().map(|b| hash_hex(&b));
            let _ = app.emit(
                "fs://changed",
                FsChange {
                    path,
                    kind,
                    content_hash,
                },
            );
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    Ok(watcher)
}
