//! Git integration for the IDE (section 5 — daily work).
//!
//! Read-only: list the working-tree changes and produce a unified diff, so the editor can
//! show a Git diff view. Never mutates the repository. Degrades honestly (empty) when the
//! folder is not a git repo or git is absent.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

/// One changed path with its porcelain status. `status` keeps the trimmed code for
/// back-compat; `index` / `work` are the raw X (staged) and Y (worktree) columns so the
/// SCM view can group Staged vs Changes like VSCode / GitLens.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub status: String,
    pub index: String,
    pub work: String,
}

/// Run `git -C root <args>` and capture stdout, or `None` if git failed / isn't a repo.
fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Is `root` inside a git work tree?
pub fn is_repo(root: &Path) -> bool {
    git(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// The current branch name (or a short commit when detached), for a status-bar indicator.
/// `None` when `root` is not a git repo.
pub fn current_branch(root: &Path) -> Option<String> {
    let name = git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    if name == "HEAD" {
        // Detached: fall back to the short commit hash.
        return git(root, &["rev-parse", "--short", "HEAD"]).map(|s| format!("@{}", s.trim()));
    }
    Some(name.to_string())
}

/// The working-tree changes (`git status --porcelain`): modified, added, deleted and
/// untracked paths. Empty when clean or not a repo.
pub fn changed_files(root: &Path) -> Vec<GitChange> {
    // `--untracked-files=all` expands untracked DIRECTORIES into their individual files, so
    // every entry is a real file the UI can open/diff (a bare `dir/` entry would otherwise
    // fail `read_text_file`/`git diff` with "Is a directory").
    let out = match git(root, &["status", "--porcelain", "--untracked-files=all"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    out.lines()
        .filter(|l| l.len() > 3)
        .map(|l| {
            let (code, path) = l.split_at(2);
            let chars: Vec<char> = code.chars().collect();
            let index = chars.first().copied().unwrap_or(' ');
            let work = chars.get(1).copied().unwrap_or(' ');
            // Porcelain may quote paths with spaces/unicode and show "old -> new" on rename.
            let path = path.trim();
            let path = path.rsplit(" -> ").next().unwrap_or(path).trim_matches('"');
            GitChange {
                status: code.trim().to_string(),
                index: index.to_string(),
                work: work.to_string(),
                path: path.to_string(),
            }
        })
        .collect()
}

/// Stage a path (`git add -- <path>`). Returns `Err` with git's stderr on failure.
pub fn stage(root: &Path, path: &str) -> Result<(), String> {
    git_mutate(root, &["add", "--", path])
}

/// Unstage a path (`git reset -q HEAD -- <path>`).
pub fn unstage(root: &Path, path: &str) -> Result<(), String> {
    git_mutate(root, &["reset", "-q", "HEAD", "--", path])
}

/// Stage every change (`git add -A`).
pub fn stage_all(root: &Path) -> Result<(), String> {
    git_mutate(root, &["add", "-A"])
}

/// Commit the staged changes with `message`. Uses `-c` identity flags so a commit still
/// succeeds in a repo without a configured user, without mutating global git config.
pub fn commit(root: &Path, message: &str) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("empty commit message".into());
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "-c",
            "user.name=dxtutor",
            "-c",
            "user.email=dxtutor@localhost",
            "commit",
            "-m",
            message,
        ])
        .output()
        .map_err(|e| format!("could not start git: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Run a mutating `git -C root <args>`, surfacing stderr on failure.
fn git_mutate(root: &Path, args: &[&str]) -> Result<(), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("could not start git: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Like [`git`] but returns stdout even on a non-zero exit — needed for `git diff
/// --no-index`, which exits 1 precisely when the files differ.
fn git_allow_fail(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// A unified diff (optionally scoped to `file`). When `staged`, shows the index vs HEAD
/// (`git diff --cached`); otherwise the working tree vs HEAD. For an untracked file (no
/// diff vs HEAD) it shows the whole file as additions, so the view isn't blank for a new
/// file. Empty when there's nothing to show or it's not a repo.
pub fn diff(root: &Path, file: Option<&str>, staged: bool) -> String {
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("HEAD");
    if let Some(f) = file {
        args.push("--");
        args.push(f);
    }
    let tracked = git(root, &args).unwrap_or_default();
    if !tracked.is_empty() {
        return tracked;
    }
    // Untracked file (only meaningful for the worktree view): show its content as additions.
    if !staged {
        if let Some(f) = file {
            return git_allow_fail(root, &["diff", "--no-index", "--", "/dev/null", f])
                .unwrap_or_default();
        }
    }
    tracked
}

/// Clone `url` into `parent_dir`, returning the path of the freshly created repository
/// directory on success (so the caller can mount it). The destination name is derived by
/// `git` from the URL; we discover it by reading the parent dir before/after the clone.
/// Returns `Err` with git's stderr when the clone fails.
pub fn clone_repo(url: &str, parent_dir: &Path) -> Result<std::path::PathBuf, String> {
    let before: std::collections::HashSet<std::path::PathBuf> = std::fs::read_dir(parent_dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default();
    let out = Command::new("git")
        .arg("-C")
        .arg(parent_dir)
        .args(["clone", url])
        .output()
        .map_err(|e| format!("could not start git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    // The new directory is the one that appeared.
    std::fs::read_dir(parent_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.is_dir() && !before.contains(p))
        .ok_or_else(|| "clone succeeded but the new folder was not found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(root: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(root).args(args).status().unwrap();
        assert!(ok.success(), "git {args:?} failed");
    }

    #[test]
    fn status_and_diff_on_a_temp_repo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q"]);
        run(root, &["config", "user.email", "t@t"]);
        run(root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        run(root, &["add", "a.txt"]);
        run(root, &["commit", "-q", "-m", "init"]);
        assert!(is_repo(root));
        assert!(changed_files(root).is_empty(), "clean after commit");

        // Modify tracked + add untracked.
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("b.txt"), "new\n").unwrap();
        // An untracked DIRECTORY must be expanded into its files (not a bare `dir/` entry),
        // so the UI can open/diff each one.
        std::fs::create_dir_all(root.join("newdir")).unwrap();
        std::fs::write(root.join("newdir/inside.txt"), "x\n").unwrap();

        let changes = changed_files(root);
        assert!(changes.iter().any(|c| c.path == "a.txt" && c.status == "M"), "{changes:?}");
        assert!(changes.iter().any(|c| c.path == "b.txt" && c.status == "??"), "{changes:?}");
        assert!(changes.iter().any(|c| c.path == "newdir/inside.txt"), "untracked dir expanded: {changes:?}");
        assert!(!changes.iter().any(|c| c.path.ends_with('/')), "no bare directory entries: {changes:?}");

        let d = diff(root, Some("a.txt"), false);
        assert!(d.contains("+two"), "diff should show the added line:\n{d}");

        // Branch name (git's default may be master or main depending on config).
        let branch = current_branch(root).expect("a branch");
        assert!(branch == "main" || branch == "master", "unexpected branch: {branch}");

        // An untracked file shows its whole content as additions (not blank).
        let du = diff(root, Some("b.txt"), false);
        assert!(du.contains("+new"), "untracked diff should show the content:\n{du}");
    }

    #[test]
    fn stage_commit_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();

        // Untracked: index blank, work "?".
        let before = changed_files(root);
        let a = before.iter().find(|c| c.path == "a.txt").expect("a.txt listed");
        assert_eq!(a.work, "?");

        // Stage it → it moves to the index column ("A").
        stage(root, "a.txt").unwrap();
        let staged = changed_files(root);
        assert!(staged.iter().any(|c| c.path == "a.txt" && c.index == "A"), "{staged:?}");

        // Commit the staged change → tree is clean.
        commit(root, "add a").unwrap();
        assert!(changed_files(root).is_empty(), "clean after commit");

        // Unstage after a new staged change returns it to the worktree.
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        stage(root, "a.txt").unwrap();
        unstage(root, "a.txt").unwrap();
        let un = changed_files(root);
        assert!(un.iter().any(|c| c.path == "a.txt" && c.work == "M"), "{un:?}");
    }

    #[test]
    fn non_repo_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_repo(dir.path()));
        assert!(changed_files(dir.path()).is_empty());
        assert!(diff(dir.path(), None, false).is_empty());
        assert!(current_branch(dir.path()).is_none());
    }
}
