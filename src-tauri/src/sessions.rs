use crate::error::CommandError;
use crate::state::AppState;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::State;

#[derive(Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub updated_at: u64, // file mtime, epoch milliseconds
    pub git_branch: Option<String>,
    pub message_count: u32,
}

/// Claude Code sessions for the open project, newest first.
#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionMeta>, CommandError> {
    let root_str = {
        let guard = state.open.lock().unwrap();
        match guard.as_ref() {
            Some(p) => p.root.to_string_lossy().into_owned(),
            None => return Ok(vec![]),
        }
    };

    // Claude Code stores a project's sessions under ~/.claude/projects/<cwd with / and . as ->.
    let home = std::env::var("HOME").unwrap_or_default();
    let encoded = root_str.replace(['/', '.'], "-");
    let session_dir = PathBuf::from(&home)
        .join(".claude")
        .join("projects")
        .join(&encoded);
    if !session_dir.is_dir() {
        return Ok(vec![]);
    }

    let mut sessions = collect_sessions(&session_dir)?;
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(sessions)
}

fn collect_sessions(dir: &Path) -> Result<Vec<SessionMeta>, CommandError> {
    let rd = std::fs::read_dir(dir).map_err(|e| CommandError::Io(e.to_string()))?;
    let mut result = Vec::new();

    for entry in rd.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_owned(),
            None => continue,
        };
        let updated_at = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        result.push(parse_session_file(&path, id, updated_at));
    }

    Ok(result)
}

fn parse_session_file(path: &Path, id: String, updated_at: u64) -> SessionMeta {
    let f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            return SessionMeta {
                id,
                title: "Untitled session".to_owned(),
                updated_at,
                git_branch: None,
                message_count: 0,
            }
        }
    };

    let reader = BufReader::new(f);
    let mut title: Option<String> = None;
    let mut first_user_snippet: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut message_count: u32 = 0;

    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        if git_branch.is_none() && line.contains("\"gitBranch\"") {
            git_branch = extract_string_field(&line, "gitBranch");
        }
        let is_user = line.contains("\"type\":\"user\"") || line.contains("\"role\":\"user\"");
        let is_assistant =
            line.contains("\"type\":\"assistant\"") || line.contains("\"role\":\"assistant\"");
        if is_user || is_assistant {
            message_count += 1;
        }
        if title.is_none() && line.contains("\"type\":\"aiTitle\"") {
            title = extract_string_field(&line, "aiTitle");
        }
        if first_user_snippet.is_none() && is_user {
            first_user_snippet = extract_user_snippet(&line);
        }
    }

    SessionMeta {
        id,
        title: title
            .or(first_user_snippet)
            .unwrap_or_else(|| "Untitled session".to_owned()),
        updated_at,
        git_branch,
        message_count,
    }
}

/// Pull a JSON string value for `key` from a raw line, handling simple escapes.
fn extract_string_field(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\":\"", key);
    let start = line.find(&needle)? + needle.len();
    let mut value = String::new();
    let mut chars = line[start..].chars();
    loop {
        match chars.next()? {
            '"' => break,
            '\\' => match chars.next()? {
                'n' => value.push('\n'),
                't' => value.push('\t'),
                'r' => value.push('\r'),
                c => value.push(c),
            },
            c => value.push(c),
        }
    }
    (!value.is_empty()).then_some(value)
}

/// First user message text, flattened to one line and capped at 80 chars.
fn extract_user_snippet(line: &str) -> Option<String> {
    let text = extract_string_field(line, "text")
        .or_else(|| extract_string_field(line, "content"))
        .unwrap_or_default();
    let flat: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .take(80)
        .collect();
    (!flat.trim().is_empty()).then_some(flat)
}
