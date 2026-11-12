//! Git integration for the IDE (section 5 — daily work).
//!
//! Read-only: list the working-tree changes and produce a unified diff, so the editor can
//! show a Git diff view. Never mutates the repository. Degrades honestly (empty) when the
//! folder is not a git repo or git is absent.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

/// One changed path with its porcelain status code (e.g. `M`, `A`, `??` for untracked).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub status: String,
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
            GitChange {
                status: code.trim().to_string(),
                path: path.trim().to_string(),
            }
        })
        .collect()
}

/// Like [`git`] but returns stdout even on a non-zero exit — needed for `git diff
/// --no-index`, which exits 1 precisely when the files differ.
fn git_allow_fail(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// A unified diff of the working tree against HEAD (optionally scoped to `file`). For an
/// untracked file (no diff vs HEAD) it shows the whole file as additions, so the Git view
/// isn't blank for a brand-new file. Empty when there's nothing to show or it's not a repo.
pub fn diff(root: &Path, file: Option<&str>) -> String {
    let mut args = vec!["diff", "HEAD"];
    if let Some(f) = file {
        args.push("--");
        args.push(f);
    }
    let tracked = git(root, &args).unwrap_or_default();
    if !tracked.is_empty() {
        return tracked;
    }
    // Untracked file: diff against /dev/null to render its content as additions.
    if let Some(f) = file {
        return git_allow_fail(root, &["diff", "--no-index", "--", "/dev/null", f])
            .unwrap_or_default();
    }
    tracked
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

        let d = diff(root, Some("a.txt"));
        assert!(d.contains("+two"), "diff should show the added line:\n{d}");

        // Branch name (git's default may be master or main depending on config).
        let branch = current_branch(root).expect("a branch");
        assert!(branch == "main" || branch == "master", "unexpected branch: {branch}");

        // An untracked file shows its whole content as additions (not blank).
        let du = diff(root, Some("b.txt"));
        assert!(du.contains("+new"), "untracked diff should show the content:\n{du}");
    }

    #[test]
    fn non_repo_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_repo(dir.path()));
        assert!(changed_files(dir.path()).is_empty());
        assert!(diff(dir.path(), None).is_empty());
        assert!(current_branch(dir.path()).is_none());
    }
}
