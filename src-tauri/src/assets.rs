use crate::error::CommandError;
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize)]
pub struct AssetItem {
    pub name: String,
    pub description: String,
    pub scope: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct ClaudeAssets {
    pub skills: Vec<AssetItem>,
    pub agents: Vec<AssetItem>,
    pub workflows: Vec<AssetItem>,
}

#[tauri::command]
pub fn list_claude_assets(state: State<'_, AppState>) -> Result<ClaudeAssets, CommandError> {
    let project_root: Option<PathBuf> = state.open.lock().unwrap().as_ref().map(|p| p.root.clone());

    let home = std::env::var("HOME").unwrap_or_default();
    let user_claude = PathBuf::from(&home).join(".claude");

    let mut skills = Vec::new();
    let mut agents = Vec::new();
    let mut workflows = Vec::new();

    // User-scoped assets first, then project-scoped.
    let mut scan = |base: &Path, scope: &str| {
        collect_skills(base, scope, &mut skills);
        collect_flat(base, "agents", "md", scope, parse_frontmatter, &mut agents);
        collect_flat(
            base,
            "workflows",
            "js",
            scope,
            parse_workflow_meta,
            &mut workflows,
        );
    };
    scan(&user_claude, "user");
    if let Some(ref root) = project_root {
        scan(&root.join(".claude"), "project");
    }

    Ok(ClaudeAssets {
        skills,
        agents,
        workflows,
    })
}

/// Scan `<base>/skills/*/SKILL.md` and push one `AssetItem` per skill dir.
fn collect_skills(base: &Path, scope: &str, out: &mut Vec<AssetItem>) {
    let skills_dir = base.join("skills");
    let rd = match std::fs::read_dir(&skills_dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.filter_map(|e| e.ok()) {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let skill_file = dir.join("SKILL.md");
        if !skill_file.exists() {
            continue;
        }
        let dir_name = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_owned();
        let text = std::fs::read_to_string(&skill_file).unwrap_or_default();
        let (name, description) = parse_frontmatter(&text, &dir_name);
        out.push(AssetItem {
            name,
            description,
            scope: scope.to_owned(),
            path: skill_file.to_string_lossy().into_owned(),
        });
    }
}

/// Scan `<base>/<subdir>/*.<ext>` (flat) and push one `AssetItem` per file,
/// parsing name/description via `parse`.
fn collect_flat(
    base: &Path,
    subdir: &str,
    ext: &str,
    scope: &str,
    parse: fn(&str, &str) -> (String, String),
    out: &mut Vec<AssetItem>,
) {
    let rd = match std::fs::read_dir(base.join(subdir)) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(ext) {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_owned();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let (name, description) = parse(&text, &stem);
        out.push(AssetItem {
            name,
            description,
            scope: scope.to_owned(),
            path: path.to_string_lossy().into_owned(),
        });
    }
}

/// Parse YAML frontmatter (between leading `---` fences) for `name:` and
/// `description:`. Falls back to `fallback_name` when the `name` key is absent.
fn parse_frontmatter(text: &str, fallback_name: &str) -> (String, String) {
    let mut lines = text.lines();

    // Must start with `---`.
    if lines.next().map(str::trim) != Some("---") {
        return (fallback_name.to_owned(), String::new());
    }

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("name:") {
            name = Some(rest.trim().to_owned());
        } else if let Some(rest) = trimmed.strip_prefix("description:") {
            description = Some(rest.trim().to_owned());
        }
    }

    (
        name.filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback_name.to_owned()),
        description.unwrap_or_default(),
    )
}

/// Extract `name` and `description` from the `export const meta = { ... }` block
/// at the head of a workflow JS file using simple string scanning.
fn parse_workflow_meta(text: &str, fallback_name: &str) -> (String, String) {
    // Look for `export const meta = {` and scan up to the first `}`.
    let start = match text.find("export const meta") {
        Some(i) => i,
        None => return (fallback_name.to_owned(), String::new()),
    };
    let block_start = match text[start..].find('{') {
        Some(i) => start + i,
        None => return (fallback_name.to_owned(), String::new()),
    };
    let block_end = match text[block_start..].find('}') {
        Some(i) => block_start + i,
        None => return (fallback_name.to_owned(), String::new()),
    };
    let block = &text[block_start..=block_end];

    let name = extract_js_string(block, "name");
    let description = extract_js_string(block, "description");

    (
        name.filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback_name.to_owned()),
        description.unwrap_or_default(),
    )
}

/// Extract the string literal value for a given key from a JS object literal
/// fragment, e.g. `name: 'Foo'` or `name: "Foo"`.
fn extract_js_string(block: &str, key: &str) -> Option<String> {
    // Match `key:` followed by optional whitespace and a quoted string.
    let needle = format!("{}:", key);
    let pos = block.find(&needle)?;
    let after_colon = block[pos + needle.len()..].trim_start();
    let quote = after_colon.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let rest = &after_colon[1..];
    let end = rest.find(quote)?;
    let value = &rest[..end];
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}
