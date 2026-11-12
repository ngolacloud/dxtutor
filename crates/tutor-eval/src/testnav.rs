//! Test discovery (section 5 — "run and test").
//!
//! Finds the `#[test]` functions across a real Rust project so the IDE can list them
//! and run one individually (instead of the whole suite). Purely **syntactic** (`syn`),
//! like the CodeMap: reliable for locating the test functions, and it notes `#[ignore]`.
//! Running a chosen test reuses the project runner (`cargo test <name>`), wired separately.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

use crate::codemap::{display_path, rust_files};
use crate::runner::{configure_cargo_env, run_guarded};

/// Wall-clock cap for running one test (the first build can be slow).
const TEST_TIMEOUT: Duration = Duration::from_secs(180);

/// One discovered test function.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestItem {
    /// The leaf function name (for display).
    pub name: String,
    /// The module-qualified path cargo addresses it by, e.g. `tests::falha`. This is what
    /// `run_test` passes with `--exact` so exactly this test runs.
    pub path: String,
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
        collect_tests(&ast.items, &file, "", &mut out);
    }
    out.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    out
}

/// The outcome of running one test.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRun {
    /// False when the run could not complete (timed out or failed to spawn).
    pub ran: bool,
    pub passed: bool,
    /// Combined stdout+stderr, shown in the test panel.
    pub output: String,
}

/// Run a single test in the project at `root`
/// (`cargo test <path> -- --exact --nocapture`), with a wall-clock timeout and the
/// hardened cargo environment. `path` is the module-qualified path from discovery
/// (e.g. `tests::falha`), so `--exact` runs exactly that test. A bare leaf name still
/// works, falling back to a substring match. Never panics.
pub fn run_test(root: &Path, path: &str) -> TestRun {
    let mut cmd = Command::new("cargo");
    cmd.args(["test", path, "--", "--exact", "--nocapture"]);
    cmd.current_dir(root);
    configure_cargo_env(&mut cmd);

    let scratch = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => return TestRun { ran: false, passed: false, output: format!("scratch: {e}") },
    };
    match run_guarded(cmd, scratch.path(), "test", TEST_TIMEOUT, None) {
        Ok(o) if o.timed_out => TestRun {
            ran: false,
            passed: false,
            output: format!("timed out after {}s", TEST_TIMEOUT.as_secs()),
        },
        Ok(o) => {
            let combined = format!("{}{}", o.stdout, o.stderr);
            TestRun { ran: true, passed: test_passed(&combined), output: combined }
        }
        Err(e) => TestRun { ran: false, passed: false, output: format!("spawn: {e}") },
    }
}

/// Decide pass/fail from cargo's output: a `test result: ok.` line with no
/// `test result: FAILED` and no compile error. Keeps the judgement explicit and testable
/// without compiling anything.
pub(crate) fn test_passed(output: &str) -> bool {
    output.contains("test result: ok.")
        && !output.contains("test result: FAILED")
        && !output.contains("error[")
}

/// Does this attribute mark a test? Matches `#[test]` and the common async variants
/// whose LAST path segment is `test` — `#[tokio::test]`, `#[async_std::test]` — which
/// cargo runs and lists just like a plain test. Custom macros like `#[rstest]` (last
/// segment `rstest`) are intentionally not matched here.
fn attr_is_test(a: &syn::Attribute) -> bool {
    a.path()
        .segments
        .last()
        .map(|s| s.ident == "test")
        .unwrap_or(false)
}

fn collect_tests(items: &[syn::Item], file: &str, module: &str, out: &mut Vec<TestItem>) {
    for item in items {
        match item {
            syn::Item::Fn(f) => {
                let is_test = f.attrs.iter().any(attr_is_test);
                if is_test {
                    let ignored = f.attrs.iter().any(|a| a.path().is_ident("ignore"));
                    let name = f.sig.ident.to_string();
                    let path = if module.is_empty() {
                        name.clone()
                    } else {
                        format!("{module}::{name}")
                    };
                    out.push(TestItem {
                        name,
                        path,
                        file: file.to_string(),
                        line: f.sig.ident.span().start().line as u32,
                        ignored,
                    });
                }
            }
            syn::Item::Mod(m) => {
                if let Some((_, items)) = &m.content {
                    let inner = if module.is_empty() {
                        m.ident.to_string()
                    } else {
                        format!("{module}::{}", m.ident)
                    };
                    collect_tests(items, file, &inner, out);
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
        // The path is module-qualified so --exact addresses exactly this test.
        assert_eq!(simples.path, "tests::soma_simples");
    }

    #[test]
    fn descobre_variantes_async_de_test() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/lib.rs"),
            "#[cfg(test)]\nmod tests {\n\
             #[tokio::test]\nasync fn async_tokio() {}\n\
             #[async_std::test]\nasync fn async_std_t() {}\n\
             #[rstest]\nfn nao_e_test() {}\n\
             }\n",
        )
        .unwrap();

        let found = discover_tests(root);
        let names: Vec<&str> = found.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"async_tokio"), "tokio::test deve contar: {names:?}");
        assert!(names.contains(&"async_std_t"), "async_std::test deve contar: {names:?}");
        assert!(!names.contains(&"nao_e_test"), "#[rstest] não é #[test]: {names:?}");
    }

    #[test]
    fn parser_do_resultado_do_cargo() {
        assert!(test_passed("running 1 test\ntest soma ... ok\ntest result: ok. 1 passed; 0 failed"));
        assert!(!test_passed("test soma ... FAILED\ntest result: FAILED. 0 passed; 1 failed"));
        assert!(!test_passed("error[E0308]: mismatched types")); // não compila
        assert!(!test_passed("sem linha de resultado nenhuma"));
    }

    fn write_project(root: &Path) {
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[workspace]\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/lib.rs"),
            "#[cfg(test)]\nmod tests {\n#[test]\nfn passa() { assert_eq!(2 + 2, 4); }\n#[test]\nfn falha() { assert_eq!(2 + 2, 5); }\n}\n",
        )
        .unwrap();
    }

    #[test]
    #[ignore = "compila e corre cargo aninhado; corre com --ignored"]
    fn corre_um_teste_passa_e_falha() {
        let dir = tempfile::tempdir().unwrap();
        write_project(dir.path());

        let ok = run_test(dir.path(), "tests::passa");
        assert!(ok.ran && ok.passed, "o teste 'passa' devia passar:\n{}", ok.output);

        let bad = run_test(dir.path(), "tests::falha");
        assert!(bad.ran && !bad.passed, "o teste 'falha' devia falhar:\n{}", bad.output);
    }
}
