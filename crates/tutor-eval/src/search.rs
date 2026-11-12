//! Global text search across a real project (section 5 — daily work).
//!
//! A dependency-free, offline "find in files": literal, case-sensitive substring match
//! over the project's text files, skipping heavy/VCS dirs and binary files. Bounded by a
//! result cap so a huge repo or a common term can't flood the UI.

use std::path::Path;

use serde::Serialize;

/// One match: the file (project-relative), 1-based line/column, and the (trimmed) line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub text: String,
}

const SKIP_DIRS: &[&str] = &["target", ".git", "node_modules", "vendor", "dist", "__pycache__"];
const MAX_FILE_BYTES: u64 = 1_048_576; // 1 MiB — skip anything bigger (likely generated/binary)
const MAX_LINE: usize = 240; // trim very long lines in the result

/// Search `root` for literal `query`, returning up to `max` hits (file-relative paths).
/// `ignore_case` folds case on both sides. An empty query returns nothing. Never panics.
pub fn search_project(root: &Path, query: &str, max: usize, ignore_case: bool) -> Vec<SearchHit> {
    let mut out = Vec::new();
    if query.is_empty() {
        return out;
    }
    let needle = if ignore_case { query.to_lowercase() } else { query.to_string() };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            if out.len() >= max {
                return out;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            // Skip oversized/binary files cheaply.
            if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
                continue;
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c, // non-UTF-8 (binary) fails read_to_string → skipped
                Err(_) => continue,
            };
            let rel = relative(root, &path);
            for (i, line) in content.lines().enumerate() {
                // Case-insensitive: match on a lowered copy; the reported column is a byte
                // offset into it, which equals the original's since lowercasing ASCII (and
                // the common BMP cases) is length-stable for our display purposes.
                let haystack = if ignore_case { line.to_lowercase() } else { line.to_string() };
                if let Some(col) = haystack.find(&needle) {
                    out.push(SearchHit {
                        file: rel.clone(),
                        line: (i + 1) as u32,
                        col: (col + 1) as u32,
                        text: trim_line(line),
                    });
                    if out.len() >= max {
                        return out;
                    }
                }
            }
        }
    }
    out
}

/// List the project's files (relative paths, sorted) for quick-open, skipping heavy/VCS
/// dirs and dotfiles/dirs. Capped by `max`. Includes all file types (quick-open opens any).
pub fn list_files(root: &Path, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            if out.len() >= max {
                out.sort();
                return out;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(entry.path());
            } else if !name.starts_with('.') {
                out.push(relative(root, &entry.path()));
            }
        }
    }
    out.sort();
    out
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn trim_line(line: &str) -> String {
    let t = line.trim_end();
    if t.chars().count() > MAX_LINE {
        let s: String = t.chars().take(MAX_LINE).collect();
        format!("{s}…")
    } else {
        t.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_literal_matches_with_location() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "fn main() {\n    let needle = 1;\n}\n").unwrap();
        std::fs::write(root.join("b.txt"), "no match here\nanother needle line\n").unwrap();
        // A skipped dir must be ignored.
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join("target/x.rs"), "needle in build output\n").unwrap();

        let hits = search_project(root, "needle", 100, false);
        assert_eq!(hits.len(), 2, "hits: {hits:?}");
        assert!(hits.iter().any(|h| h.file.ends_with("a.rs") && h.line == 2 && h.col == 9));
        assert!(hits.iter().any(|h| h.file.ends_with("b.txt") && h.line == 2));
        assert!(!hits.iter().any(|h| h.file.contains("target")), "build dir must be skipped");
    }

    #[test]
    fn case_insensitive_matches_fold_case() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("a.rs"), "let Needle = 1;\nTODO: fix\n").unwrap();
        // Case-sensitive: lower "needle" misses "Needle".
        assert!(search_project(root, "needle", 100, false).is_empty());
        // Case-insensitive: it matches.
        let hits = search_project(root, "needle", 100, true);
        assert!(hits.iter().any(|h| h.line == 1), "hits: {hits:?}");
        assert_eq!(search_project(root, "todo", 100, true).len(), 1);
    }

    #[test]
    fn list_files_enumerates_and_skips() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        std::fs::write(root.join("README.md"), "").unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join("target/junk"), "").unwrap();
        std::fs::write(root.join(".hidden"), "").unwrap();

        let files = list_files(root, 100);
        assert!(files.iter().any(|f| f == "src/main.rs"));
        assert!(files.iter().any(|f| f == "README.md"));
        assert!(!files.iter().any(|f| f.contains("target")), "build dir skipped");
        assert!(!files.iter().any(|f| f.contains(".hidden")), "dotfiles skipped");
        // Sorted for a stable quick-open list.
        let mut sorted = files.clone();
        sorted.sort();
        assert_eq!(files, sorted);
    }

    #[test]
    fn respects_the_cap_and_empty_query() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("f.txt"), "x\nx\nx\nx\nx\n").unwrap();
        assert_eq!(search_project(root, "x", 3, false).len(), 3);
        assert!(search_project(root, "", 100, false).is_empty());
    }
}
