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

/// One commit for the graph view: hash + parents (for lane drawing), subject, author,
/// relative date and any refs (branches/tags) pointing at it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub refs: Vec<String>,
}

/// The last `max` commits reachable from all refs (`git log --all`), newest first, for the
/// commit graph. Empty when not a repo. Uses an unambiguous unit-separator format so
/// subjects with any punctuation parse cleanly.
pub fn log(root: &Path, max: usize) -> Vec<GitCommit> {
    // %x1f = unit separator between fields, %x1e = record separator between commits.
    let fmt = "--pretty=format:%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%cr%x1f%D%x1e";
    let arg_max = format!("--max-count={max}");
    let out = match git(root, &["log", "--all", "--topo-order", &arg_max, fmt]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    out.split('\u{1e}')
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('\u{1f}').collect();
            if f.len() < 7 {
                return None;
            }
            let refs = f[6]
                .split(',')
                .map(|s| s.trim().trim_start_matches("HEAD -> ").to_string())
                .filter(|s| !s.is_empty())
                .collect();
            Some(GitCommit {
                hash: f[0].to_string(),
                short: f[1].to_string(),
                parents: f[2].split_whitespace().map(String::from).collect(),
                subject: f[3].to_string(),
                author: f[4].to_string(),
                date: f[5].to_string(),
                refs,
            })
        })
        .collect()
}

/// A unified diff for a single commit (`git show`), for the graph's detail pane.
pub fn show(root: &Path, hash: &str) -> String {
    git(root, &["show", "--no-color", "--stat", "--patch", hash]).unwrap_or_default()
}

/// Local branch names (`git branch`), current branch first. Empty when not a repo.
pub fn branches(root: &Path) -> Vec<String> {
    let out = match git(root, &["branch", "--format=%(refname:short)"]) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let current = current_branch(root);
    let mut names: Vec<String> = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    // Current branch to the front so the UI can mark it.
    if let Some(c) = current {
        names.sort_by_key(|n| if *n == c { 0 } else { 1 });
    }
    names
}

/// Switch to an existing branch (`git checkout <branch>`).
pub fn checkout(root: &Path, branch: &str) -> Result<(), String> {
    git_mutate(root, &["checkout", branch])
}

/// Create and switch to a new branch (`git checkout -b <branch>`).
pub fn create_branch(root: &Path, name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("empty branch name".into());
    }
    git_mutate(root, &["checkout", "-b", name])
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
    fn branch_list_create_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q"]);
        run(root, &["config", "user.email", "t@t"]);
        run(root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        run(root, &["add", "a.txt"]);
        run(root, &["commit", "-q", "-m", "init"]);

        let base = current_branch(root).unwrap();
        create_branch(root, "feature/x").unwrap();
        assert_eq!(current_branch(root).as_deref(), Some("feature/x"));
        let names = branches(root);
        assert!(names.contains(&"feature/x".to_string()) && names.contains(&base), "{names:?}");
        assert_eq!(names.first().unwrap(), "feature/x", "current branch first: {names:?}");

        checkout(root, &base).unwrap();
        assert_eq!(current_branch(root).as_deref(), Some(base.as_str()));
    }

    #[test]
    fn log_lists_commits_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q"]);
        run(root, &["config", "user.email", "t@t"]);
        run(root, &["config", "user.name", "Tester"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        run(root, &["add", "a.txt"]);
        run(root, &["commit", "-q", "-m", "first: with punctuation, commas"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        run(root, &["add", "a.txt"]);
        run(root, &["commit", "-q", "-m", "second"]);

        let commits = log(root, 10);
        assert_eq!(commits.len(), 2, "{commits:?}");
        assert_eq!(commits[0].subject, "second");
        assert_eq!(commits[1].subject, "first: with punctuation, commas");
        assert_eq!(commits[0].author, "Tester");
        assert_eq!(commits[0].parents, vec![commits[1].hash.clone()]);
        assert!(commits[1].parents.is_empty(), "root has no parent");
        // HEAD/branch ref is attached to the tip.
        assert!(commits[0].refs.iter().any(|r| r.contains("main") || r.contains("master")));

        let patch = show(root, &commits[0].hash);
        assert!(patch.contains("+two"), "{patch}");
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
