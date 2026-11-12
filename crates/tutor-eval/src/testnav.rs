//! Test discovery (section 5 — "run and test").
//!
//! Finds the `#[test]` functions across a real Rust project so the IDE can list them
//! and run one individually (instead of the whole suite). Purely **syntactic** (`syn`),
//! like the CodeMap: reliable for locating the test functions, and it notes `#[ignore]`.
//! Running a chosen test reuses the project runner (`cargo test <name>`), wired separately.

use std::path::Path;

use serde::Serialize;
use syn::spanned::Spanned;

use crate::codemap::{display_path, rust_files};

/// One discovered test function.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestItem {
    /// The function name — what `cargo test <name>` filters on.
    pub name: String,
    pub file: String,
    pub line: u32,
    /// Carries `#[ignore]` (won't run without `--ignored`).
    pub ignored: bool,
}

/// Discover every `#[test]` function under `root`, including those inside `mod`
/// blocks (e.g. the conventional `mod tests`). Unparseable files are skipped, never
/// aborting the whole scan. Results are sorted by file then line for a stable listing.
pub fn discover_tests(root: &Path) -> Vec<TestItem> {
    let mut out = Vec::new();
    for path in rust_files(root) {
        let code = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let ast = match syn::parse_file(&code) {
            Ok(a) => a,
            Err(_) => continue,
        };
        let file = display_path(&path, root);
        collect_tests(&ast.items, &file, &mut out);
    }
    out.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    out
}

fn collect_tests(items: &[syn::Item], file: &str, out: &mut Vec<TestItem>) {
    for item in items {
        match item {
            syn::Item::Fn(f) => {
                let is_test = f.attrs.iter().any(|a| a.path().is_ident("test"));
                if is_test {
                    let ignored = f.attrs.iter().any(|a| a.path().is_ident("ignore"));
                    out.push(TestItem {
                        name: f.sig.ident.to_string(),
                        file: file.to_string(),
                        line: f.sig.ident.span().start().line as u32,
                        ignored,
                    });
                }
            }
            syn::Item::Mod(m) => {
                if let Some((_, items)) = &m.content {
                    collect_tests(items, file, out);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_tests_across_modules_and_notes_ignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/lib.rs"),
            "pub fn add(a: i32, b: i32) -> i32 { a + b }\n\
             #[cfg(test)]\n\
             mod tests {\n\
             use super::*;\n\
             #[test]\n\
             fn soma_simples() { assert_eq!(add(2, 2), 4); }\n\
             #[test]\n\
             #[ignore = \"lento\"]\n\
             fn caro() { assert!(true); }\n\
             }\n",
        )
        .unwrap();

        let found = discover_tests(root);
        let names: Vec<&str> = found.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"soma_simples"), "found: {names:?}");
        let caro = found.iter().find(|t| t.name == "caro").expect("caro discovered");
        assert!(caro.ignored, "#[ignore] must be noted");
        let simples = found.iter().find(|t| t.name == "soma_simples").unwrap();
        assert!(!simples.ignored);
        assert!(simples.file.ends_with("lib.rs"));
    }
}
