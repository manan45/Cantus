use crate::error::CommandError;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Serialize)]
pub struct Orchestration {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub tasks: Vec<String>,
    pub updated_at: u64,
}

#[derive(Deserialize)]
pub struct OrchestrationInput {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub tasks: Vec<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[tauri::command]
pub async fn list_orchestrations(
    state: State<'_, AppState>,
) -> Result<Vec<Orchestration>, CommandError> {
    let project_id = {
        let guard = state.open.lock().unwrap();
        match guard.as_ref() {
            Some(p) => p.id,
            None => return Ok(vec![]),
        }
    };

    let rows = sqlx::query(
        "SELECT sid, title, goal, tasks, updated_at
         FROM orchestrations
         WHERE project_id = ?1
         ORDER BY updated_at DESC",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await?;

    let result = rows
        .into_iter()
        .map(|row| {
            use sqlx::Row;
            let tasks_json: String = row.get("tasks");
            let tasks: Vec<String> = serde_json::from_str(&tasks_json).unwrap_or_default();
            Orchestration {
                id: row.get("sid"),
                title: row.get("title"),
                goal: row.get("goal"),
                tasks,
                updated_at: row.get::<i64, _>("updated_at") as u64,
            }
        })
        .collect();

    Ok(result)
}

#[tauri::command]
pub async fn save_orchestration(
    state: State<'_, AppState>,
    o: OrchestrationInput,
) -> Result<(), CommandError> {
    let project_id = state
        .open
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.id)
        .ok_or(CommandError::NoProject)?;

    let tasks_json =
        serde_json::to_string(&o.tasks).map_err(|e| CommandError::Db(e.to_string()))?;
    let updated_at = now_ms() as i64;

    sqlx::query(
        "INSERT INTO orchestrations (project_id, sid, title, goal, tasks, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(project_id, sid) DO UPDATE SET
             title      = excluded.title,
             goal       = excluded.goal,
             tasks      = excluded.tasks,
             updated_at = excluded.updated_at",
    )
    .bind(project_id)
    .bind(&o.id)
    .bind(&o.title)
    .bind(&o.goal)
    .bind(&tasks_json)
    .bind(updated_at)
    .execute(&state.db)
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn delete_orchestration(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), CommandError> {
    let project_id = state
        .open
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.id)
        .ok_or(CommandError::NoProject)?;

    sqlx::query("DELETE FROM orchestrations WHERE project_id = ?1 AND sid = ?2")
        .bind(project_id)
        .bind(&id)
        .execute(&state.db)
        .await?;

    Ok(())
}
