use crate::error::CommandError;
use git2::{ApplyLocation, BranchType, Diff, DiffOptions, Repository, StatusOptions};
use serde::Serialize;
use std::path::Path;

// ── Serializable types ────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Branch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum GitChange {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Serialize)]
pub struct GitFileStatus {
    pub path: String,
    pub staged: Option<GitChange>,
    pub unstaged: Option<GitChange>,
}

#[derive(Serialize)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub entries: Vec<GitFileStatus>,
}

#[derive(Serialize)]
pub struct GitDiffLine {
    pub origin: &'static str,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Serialize)]
pub struct GitHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<GitDiffLine>,
}

#[derive(Serialize)]
pub struct GitDiff {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    pub binary: bool,
    pub hunks: Vec<GitHunk>,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn open(root: &Path) -> Result<Repository, CommandError> {
    Repository::open(root).map_err(Into::into)
}

fn to_forward_slash(p: &str) -> String {
    p.replace('\\', "/")
}

fn staged_change(s: git2::Status) -> Option<GitChange> {
    if s.contains(git2::Status::INDEX_NEW) {
        Some(GitChange::Added)
    } else if s.contains(git2::Status::INDEX_MODIFIED) {
        Some(GitChange::Modified)
    } else if s.contains(git2::Status::INDEX_DELETED) {
        Some(GitChange::Deleted)
    } else if s.contains(git2::Status::INDEX_RENAMED) {
        Some(GitChange::Renamed)
    } else {
        None
    }
}

fn unstaged_change(s: git2::Status) -> Option<GitChange> {
    if s.contains(git2::Status::CONFLICTED) {
        Some(GitChange::Conflicted)
    } else if s.contains(git2::Status::WT_NEW) {
        Some(GitChange::Untracked)
    } else if s.contains(git2::Status::WT_MODIFIED) {
        Some(GitChange::Modified)
    } else if s.contains(git2::Status::WT_DELETED) {
        Some(GitChange::Deleted)
    } else if s.contains(git2::Status::WT_RENAMED) {
        Some(GitChange::Renamed)
    } else {
        None
    }
}

fn compute_status(repo: &Repository) -> Result<GitStatus, CommandError> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let statuses = repo.statuses(Some(&mut opts))?;

    let entries = statuses
        .iter()
        .filter_map(|e| {
            let path = to_forward_slash(e.path()?);
            let s = e.status();
            let staged = staged_change(s);
            let unstaged = unstaged_change(s);
            if staged.is_none() && unstaged.is_none() {
                return None;
            }
            Some(GitFileStatus {
                path,
                staged,
                unstaged,
            })
        })
        .collect();

    let (branch, upstream, ahead, behind) = head_info(repo);

    Ok(GitStatus {
        branch,
        upstream,
        ahead,
        behind,
        entries,
    })
}

fn head_info(repo: &Repository) -> (Option<String>, Option<String>, usize, usize) {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return (None, None, 0, 0),
    };

    let branch = if head.is_branch() {
        head.shorthand().map(str::to_owned)
    } else {
        None
    };

    let upstream_name = branch.as_deref().and_then(|b| {
        repo.find_branch(b, git2::BranchType::Local)
            .ok()
            .and_then(|br| br.upstream().ok())
            .and_then(|up| up.name().ok().flatten().map(str::to_owned))
    });

    let (ahead, behind) = upstream_name
        .as_deref()
        .and_then(|up| {
            let local_oid = head.target()?;
            let upstream_ref = repo.find_reference(up).ok()?;
            let upstream_oid = upstream_ref.target()?;
            repo.graph_ahead_behind(local_oid, upstream_oid).ok()
        })
        .unwrap_or((0, 0));

    (branch, upstream_name, ahead, behind)
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn status(root: &Path) -> Result<GitStatus, CommandError> {
    compute_status(&open(root)?)
}

pub fn stage(root: &Path, paths: &[String]) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    if !paths.is_empty() {
        let mut index = repo.index()?;
        for rel in paths {
            let abs = root.join(rel);
            // Use a plain relative path for libgit2 index operations.
            let index_path = Path::new(rel);
            if abs.exists() {
                index.add_path(index_path)?;
            } else {
                // Stage the deletion.
                index.remove_path(index_path)?;
            }
        }
        index.write()?;
    }
    compute_status(&repo)
}

pub fn unstage(root: &Path, paths: &[String]) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    if !paths.is_empty() {
        match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
            Some(commit) => {
                let obj = commit.as_object();
                let index_paths: Vec<&Path> = paths.iter().map(|p| Path::new(p.as_str())).collect();
                repo.reset_default(Some(obj), index_paths)?;
            }
            None => {
                // Unborn branch — remove from index.
                let mut index = repo.index()?;
                for rel in paths {
                    let _ = index.remove_path(Path::new(rel));
                }
                index.write()?;
            }
        }
    }
    compute_status(&repo)
}

pub fn commit(root: &Path, message: &str) -> Result<GitStatus, CommandError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(CommandError::Git("commit message is empty".into()));
    }

    let repo = open(root)?;
    let mut index = repo.index()?;
    index.read(false)?;

    // Verify something is staged.
    let has_staged = {
        let head_tree = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.tree())
            .transpose()?;
        let diff = match &head_tree {
            Some(tree) => repo.diff_tree_to_index(Some(tree), Some(&index), None)?,
            None => repo.diff_tree_to_index(None, Some(&index), None)?,
        };
        diff.deltas().len() > 0
    };

    if !has_staged {
        return Err(CommandError::Git("nothing staged to commit".into()));
    }

    let sig = repo.signature()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    let parent_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit<'_>> = parent_commit.iter().collect();

    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;

    compute_status(&repo)
}

pub fn branches(root: &Path) -> Result<Vec<Branch>, CommandError> {
    let repo = open(root)?;
    let head_name = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(str::to_owned));

    let mut out: Vec<Branch> = Vec::new();

    for b in repo.branches(None)? {
        let (branch, btype) = b?;
        let name = match branch.name()? {
            Some(n) => n.to_owned(),
            None => continue,
        };
        let is_remote = btype == BranchType::Remote;
        let is_current = !is_remote && head_name.as_deref() == Some(&name);
        out.push(Branch {
            name,
            is_current,
            is_remote,
        });
    }

    Ok(out)
}

pub fn checkout(root: &Path, name: &str) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    let branch = repo.find_branch(name, BranchType::Local)?;
    let commit = branch.get().peel_to_commit()?;
    let tree = commit.tree()?;
    repo.checkout_tree(tree.as_object(), None)?;
    repo.set_head(&format!("refs/heads/{name}"))?;
    compute_status(&repo)
}

pub fn create_branch(root: &Path, name: &str) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    let head_commit = repo
        .head()?
        .peel_to_commit()
        .map_err(|_| CommandError::Git("HEAD has no commit".into()))?;
    let branch = repo.branch(name, &head_commit, false)?;
    let tree = head_commit.tree()?;
    repo.checkout_tree(tree.as_object(), None)?;
    repo.set_head(
        branch
            .get()
            .name()
            .ok_or_else(|| CommandError::Git("invalid branch ref".into()))?,
    )?;
    compute_status(&repo)
}

pub fn discard(root: &Path, paths: &[String]) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    if !paths.is_empty() {
        let head_commit = repo
            .head()?
            .peel_to_commit()
            .map_err(|_| CommandError::Git("HEAD has no commit".into()))?;
        let head_tree = head_commit.tree()?;
        let mut checkout_opts = git2::build::CheckoutBuilder::new();
        for p in paths {
            checkout_opts.path(p);
        }
        checkout_opts.force();
        repo.checkout_tree(head_tree.as_object(), Some(&mut checkout_opts))?;
    }
    compute_status(&repo)
}

// ── Partial staging ───────────────────────────────────────────────────────────

struct HunkData {
    old_start: u32,
    new_start: u32,
    lines: Vec<(char, String)>,
}

fn collect_hunks(diff: &Diff<'_>) -> Result<Vec<HunkData>, CommandError> {
    // `foreach` borrows every closure at once, so they can't share a `&mut Vec`.
    // Record line origins keyed by hunk index, then assemble after the walk.
    use std::cell::Cell;

    let cur = Cell::new(usize::MAX);
    let mut starts: Vec<(u32, u32)> = Vec::new();
    let mut flat_lines: Vec<(usize, char, String)> = Vec::new();

    diff.foreach(
        &mut |_, _| true,
        None,
        Some(&mut |_, hunk| {
            cur.set(starts.len());
            starts.push((hunk.old_start(), hunk.new_start()));
            true
        }),
        Some(&mut |_, _, line| {
            let idx = cur.get();
            // Only real body lines — skip file/hunk headers ('F'/'H') and binary
            // markers, which git2 also emits here and would corrupt the patch body.
            if idx != usize::MAX && matches!(line.origin(), ' ' | '+' | '-') {
                flat_lines.push((
                    idx,
                    line.origin(),
                    String::from_utf8_lossy(line.content()).into_owned(),
                ));
            }
            true
        }),
    )?;

    let mut hunks: Vec<HunkData> = starts
        .into_iter()
        .map(|(old_start, new_start)| HunkData {
            old_start,
            new_start,
            lines: Vec::new(),
        })
        .collect();

    for (idx, origin, content) in flat_lines {
        hunks[idx].lines.push((origin, content));
    }

    Ok(hunks)
}

fn extract_hunk(diff: &Diff<'_>, hunk_index: usize) -> Result<HunkData, CommandError> {
    collect_hunks(diff)?
        .into_iter()
        .nth(hunk_index)
        .ok_or_else(|| CommandError::Git(format!("hunk index {hunk_index} out of range")))
}

/// Build a minimal unified-diff patch string.
/// `selected` restricts which line indices are staged; unselected diff lines
/// are demoted to context so the surrounding file state is preserved.
/// `reverse` swaps +/- to produce an undo patch (for unstaging).
fn build_patch(path: &str, hunk: &HunkData, selected: Option<&[usize]>, reverse: bool) -> String {
    let mut adds: u32 = 0;
    let mut dels: u32 = 0;
    let mut body = String::new();

    for (i, (origin, content)) in hunk.lines.iter().enumerate() {
        let effective =
            if selected.is_some_and(|sel| !sel.contains(&i) && matches!(origin, '+' | '-')) {
                ' '
            } else {
                *origin
            };

        match effective {
            '+' => {
                if reverse {
                    body.push('-');
                    dels += 1;
                } else {
                    body.push('+');
                    adds += 1;
                }
            }
            '-' => {
                if reverse {
                    body.push('+');
                    adds += 1;
                } else {
                    body.push('-');
                    dels += 1;
                }
            }
            _ => {
                body.push(' ');
                adds += 1;
                dels += 1;
            }
        }
        body.push_str(content);
    }

    // old_count = context + deletions; new_count = context + additions.
    // Reverse swaps the sides so libgit2 applies the undo to the index.
    let (old_start, old_count, new_start, new_count) = if reverse {
        (hunk.new_start, adds, hunk.old_start, dels)
    } else {
        (hunk.old_start, dels, hunk.new_start, adds)
    };

    if !body.ends_with('\n') {
        body.push('\n');
    }

    // libgit2's patch parser needs the `diff --git` line to establish the file
    // header; without it the `@@` line is rejected as "outside patch".
    format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -{old_start},{old_count} +{new_start},{new_count} @@\n{body}")
}

fn apply_patch(
    repo: &Repository,
    patch: &str,
    location: ApplyLocation,
) -> Result<(), CommandError> {
    let d = Diff::from_buffer(patch.as_bytes())
        .map_err(|e| CommandError::Git(e.message().to_owned()))?;
    repo.apply(&d, location, None)?;
    Ok(())
}

fn unstaged_diff_for_path<'repo>(
    repo: &'repo Repository,
    path: &str,
) -> Result<Diff<'repo>, CommandError> {
    let mut opts = DiffOptions::new();
    opts.pathspec(path);
    Ok(repo.diff_index_to_workdir(None, Some(&mut opts))?)
}

fn staged_diff_for_path<'repo>(
    repo: &'repo Repository,
    path: &str,
) -> Result<Diff<'repo>, CommandError> {
    let mut opts = DiffOptions::new();
    opts.pathspec(path);
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.tree())
        .transpose()?;
    Ok(match head_tree.as_ref() {
        Some(tree) => repo.diff_tree_to_index(Some(tree), None, Some(&mut opts))?,
        None => repo.diff_tree_to_index(None, None, Some(&mut opts))?,
    })
}

pub fn stage_hunk(root: &Path, path: &str, hunk_index: usize) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    let hunk = extract_hunk(&unstaged_diff_for_path(&repo, path)?, hunk_index)?;
    apply_patch(
        &repo,
        &build_patch(path, &hunk, None, false),
        ApplyLocation::Index,
    )?;
    compute_status(&repo)
}

pub fn unstage_hunk(root: &Path, path: &str, hunk_index: usize) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    let hunk = extract_hunk(&staged_diff_for_path(&repo, path)?, hunk_index)?;
    apply_patch(
        &repo,
        &build_patch(path, &hunk, None, true),
        ApplyLocation::Index,
    )?;
    compute_status(&repo)
}

pub fn stage_lines(
    root: &Path,
    path: &str,
    hunk_index: usize,
    line_indices: &[usize],
) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    let hunk = extract_hunk(&unstaged_diff_for_path(&repo, path)?, hunk_index)?;
    apply_patch(
        &repo,
        &build_patch(path, &hunk, Some(line_indices), false),
        ApplyLocation::Index,
    )?;
    compute_status(&repo)
}

pub fn unstage_lines(
    root: &Path,
    path: &str,
    hunk_index: usize,
    line_indices: &[usize],
) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    let hunk = extract_hunk(&staged_diff_for_path(&repo, path)?, hunk_index)?;
    apply_patch(
        &repo,
        &build_patch(path, &hunk, Some(line_indices), true),
        ApplyLocation::Index,
    )?;
    compute_status(&repo)
}

pub fn discard_hunk(root: &Path, path: &str, hunk_index: usize) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    let hunk = extract_hunk(&unstaged_diff_for_path(&repo, path)?, hunk_index)?;
    apply_patch(
        &repo,
        &build_patch(path, &hunk, None, true),
        ApplyLocation::WorkDir,
    )?;
    compute_status(&repo)
}

pub fn discard_lines(
    root: &Path,
    path: &str,
    hunk_index: usize,
    line_indices: &[usize],
) -> Result<GitStatus, CommandError> {
    let repo = open(root)?;
    let hunk = extract_hunk(&unstaged_diff_for_path(&repo, path)?, hunk_index)?;
    apply_patch(
        &repo,
        &build_patch(path, &hunk, Some(line_indices), true),
        ApplyLocation::WorkDir,
    )?;
    compute_status(&repo)
}

pub fn diff(root: &Path, path: &str) -> Result<GitDiff, CommandError> {
    let repo = open(root)?;
    let abs_path = root.join(path);
    let index_path = Path::new(path);

    let mut diff_opts = DiffOptions::new();
    diff_opts.pathspec(path);
    // Diff files Claude/agents newly create (untracked) as an all-added diff;
    // show_untracked_content makes libgit2 emit the line callbacks, not just the delta.
    diff_opts.include_untracked(true);
    diff_opts.show_untracked_content(true);

    let diff = repo.diff_index_to_workdir(None, Some(&mut diff_opts))?;

    // Detect binary.
    let mut is_binary = false;
    for delta in diff.deltas() {
        if delta.new_file().is_binary() || delta.old_file().is_binary() {
            is_binary = true;
            break;
        }
    }

    if is_binary {
        return Ok(GitDiff {
            path: path.to_owned(),
            old_text: String::new(),
            new_text: String::new(),
            binary: true,
            hunks: vec![],
        });
    }

    // old_text: blob at index/HEAD.
    let old_text = {
        let mut index = repo.index()?;
        index.read(false)?;
        match index.get_path(index_path, 0) {
            Some(entry) => {
                let blob = repo.find_blob(entry.id)?;
                String::from_utf8_lossy(blob.content()).into_owned()
            }
            None => String::new(),
        }
    };

    // new_text: current worktree content.
    let new_text = if abs_path.exists() {
        std::fs::read_to_string(&abs_path).map_err(CommandError::from)?
    } else {
        String::new()
    };

    // `foreach` takes all closures simultaneously so they cannot share &mut state.
    // Use Cell for the hunk index (interior mutability, no aliased &mut).
    use std::cell::Cell;

    let hunk_idx = Cell::new(usize::MAX);

    struct RawHunk {
        old_start: u32,
        old_lines: u32,
        new_start: u32,
        new_lines: u32,
    }
    let mut raw_hunks: Vec<RawHunk> = Vec::new();
    let mut flat_lines: Vec<(usize, GitDiffLine)> = Vec::new();

    diff.foreach(
        &mut |_, _| true,
        None,
        Some(&mut |_, hunk| {
            let idx = raw_hunks.len();
            raw_hunks.push(RawHunk {
                old_start: hunk.old_start(),
                old_lines: hunk.old_lines(),
                new_start: hunk.new_start(),
                new_lines: hunk.new_lines(),
            });
            hunk_idx.set(idx);
            true
        }),
        Some(&mut |_, _, line| {
            let origin = match line.origin() {
                ' ' => "context",
                '+' => "addition",
                '-' => "deletion",
                _ => return true,
            };
            let idx = hunk_idx.get();
            if idx != usize::MAX {
                flat_lines.push((
                    idx,
                    GitDiffLine {
                        origin,
                        content: String::from_utf8_lossy(line.content()).into_owned(),
                        old_lineno: line.old_lineno(),
                        new_lineno: line.new_lineno(),
                    },
                ));
            }
            true
        }),
    )?;

    let mut hunks: Vec<GitHunk> = raw_hunks
        .into_iter()
        .map(|h| GitHunk {
            old_start: h.old_start,
            old_lines: h.old_lines,
            new_start: h.new_start,
            new_lines: h.new_lines,
            lines: Vec::new(),
        })
        .collect();

    for (idx, line) in flat_lines {
        hunks[idx].lines.push(line);
    }

    Ok(GitDiff {
        path: path.to_owned(),
        old_text,
        new_text,
        binary: false,
        hunks,
    })
}
