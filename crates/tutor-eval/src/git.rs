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

/// The working-tree changes (`git status --porcelain`): modified, added, deleted and
/// untracked paths. Empty when clean or not a repo.
pub fn changed_files(root: &Path) -> Vec<GitChange> {
    let out = match git(root, &["status", "--porcelain"]) {
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

/// A unified diff of the working tree against HEAD (optionally scoped to `file`). Empty
/// when there is nothing to show or it is not a repo.
pub fn diff(root: &Path, file: Option<&str>) -> String {
    let mut args = vec!["diff", "HEAD"];
    if let Some(f) = file {
        args.push("--");
        args.push(f);
    }
    git(root, &args).unwrap_or_default()
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
        let changes = changed_files(root);
        assert!(changes.iter().any(|c| c.path == "a.txt" && c.status == "M"), "{changes:?}");
        assert!(changes.iter().any(|c| c.path == "b.txt" && c.status == "??"), "{changes:?}");

        let d = diff(root, Some("a.txt"));
        assert!(d.contains("+two"), "diff should show the added line:\n{d}");
    }

    #[test]
    fn non_repo_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_repo(dir.path()));
        assert!(changed_files(dir.path()).is_empty());
        assert!(diff(dir.path(), None).is_empty());
    }
}
