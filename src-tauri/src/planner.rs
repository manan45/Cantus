use crate::error::CommandError;
use crate::state::AppState;
use std::path::PathBuf;
use std::process::Command;
use tauri::State;

const SCHEMA: &str = r#"{"type":"object","properties":{"tasks":{"type":"array","items":{"type":"string"}}},"required":["tasks"],"additionalProperties":false}"#;

fn project_cwd(state: &State<'_, AppState>) -> PathBuf {
    let guard = state.open.lock().unwrap();
    guard
        .as_ref()
        .map(|p| p.root.clone())
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn build_prompt(goal: &str) -> String {
    format!(
        "Decompose the following goal into 2–6 concrete, independently-executable sub-tasks \
suitable for parallel agents working in this repository. \
Return ONLY a JSON object matching the provided schema — no prose, no markdown fences. \
Goal: {goal}"
    )
}

#[tauri::command]
pub async fn plan_tasks(
    state: State<'_, AppState>,
    goal: String,
) -> Result<Vec<String>, CommandError> {
    let goal = goal.trim().to_owned();
    if goal.is_empty() {
        return Err(CommandError::Agent("goal is empty".into()));
    }
    let cwd = project_cwd(&state);
    // The headless `claude` call can run for tens of seconds — keep it off the
    // async runtime so other IPC commands stay responsive.
    tauri::async_runtime::spawn_blocking(move || run_plan(cwd, goal))
        .await
        .map_err(|e| CommandError::Agent(format!("planning task failed: {e}")))?
}

fn run_plan(cwd: PathBuf, goal: String) -> Result<Vec<String>, CommandError> {
    let output = Command::new("claude")
        .args([
            "-p",
            &build_prompt(&goal),
            "--output-format",
            "json",
            "--json-schema",
            SCHEMA,
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| CommandError::Agent(format!("failed to run claude: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim().chars().take(400).collect::<String>();
        return Err(CommandError::Agent(if msg.is_empty() {
            "claude planning failed".into()
        } else {
            msg
        }));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_tasks(stdout.trim()).ok_or_else(|| {
        CommandError::Agent("could not parse a task list from Claude's response".into())
    })
}

/// `claude -p --output-format json` returns an envelope `{"result": …}`; the
/// model's reply lands in `result` as either a JSON-encoded string or an
/// embedded object/array. Accept all shapes, and fall back to a bare reply.
fn extract_tasks(stdout: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(stdout).ok()?;
    if let Some(result) = value.get("result") {
        if let Some(s) = result.as_str() {
            if let Some(tasks) = serde_json::from_str(s)
                .ok()
                .as_ref()
                .and_then(tasks_from_value)
            {
                return Some(tasks);
            }
        } else if let Some(tasks) = tasks_from_value(result) {
            return Some(tasks);
        }
    }
    tasks_from_value(&value)
}

fn tasks_from_value(v: &serde_json::Value) -> Option<Vec<String>> {
    let arr = match v {
        serde_json::Value::Array(a) => a.as_slice(),
        serde_json::Value::Object(_) => v.get("tasks")?.as_array()?.as_slice(),
        _ => return None,
    };
    let tasks: Vec<String> = arr
        .iter()
        .filter_map(|item| item.as_str())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .take(8)
        .collect();
    (!tasks.is_empty()).then_some(tasks)
}
