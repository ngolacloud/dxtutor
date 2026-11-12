//! Test discovery (section 5 — "run and test").
//!
//! Finds the `#[test]` functions across a real Rust project so the IDE can list them
//! and run one individually (instead of the whole suite). Purely **syntactic** (`syn`),
//! like the CodeMap: reliable for locating the test functions, and it notes `#[ignore]`.
//! Running a chosen test reuses the project runner (`cargo test <name>`), wired separately.

use std::path::{Path, PathBuf};
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
    /// How the test runner addresses it: for Rust, the module-qualified path cargo runs
    /// with `--exact` (e.g. `tests::falha`); for Go, the test function name for
    /// `go test -run`.
    pub path: String,
    pub file: String,
    pub line: u32,
    /// Carries `#[ignore]` (Rust; won't run without `--ignored`).
    pub ignored: bool,
    /// `"rust"` or `"go"` — which toolchain runs it.
    pub lang: String,
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
    collect_go_tests(root, &mut out);
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
            match test_outcome(&combined, path) {
                Outcome::Passed => TestRun { ran: true, passed: true, output: combined },
                Outcome::Failed => TestRun { ran: true, passed: false, output: combined },
                Outcome::DidNotRun => TestRun { ran: false, passed: false, output: combined },
            }
        }
        Err(e) => TestRun { ran: false, passed: false, output: format!("spawn: {e}") },
    }
}

/// Run the WHOLE test suite (`cargo test -- --nocapture`) in the project at `root`,
/// returning the overall pass/fail and the captured output. Complements single-test runs.
pub fn run_suite(root: &Path) -> TestRun {
    let mut cmd = Command::new("cargo");
    cmd.args(["test", "--", "--nocapture"]);
    cmd.current_dir(root);
    configure_cargo_env(&mut cmd);

    let scratch = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => return TestRun { ran: false, passed: false, output: format!("scratch: {e}") },
    };
    match run_guarded(cmd, scratch.path(), "test-all", TEST_TIMEOUT, None) {
        Ok(o) if o.timed_out => TestRun {
            ran: false,
            passed: false,
            output: format!("timed out after {}s", TEST_TIMEOUT.as_secs()),
        },
        Ok(o) => {
            let combined = format!("{}{}", o.stdout, o.stderr);
            TestRun { ran: true, passed: suite_passed(&combined), output: combined }
        }
        Err(e) => TestRun { ran: false, passed: false, output: format!("spawn: {e}") },
    }
}

/// Whole-suite verdict: it passed iff cargo reported a result and nothing failed or failed
/// to compile. Any `FAILED` line (from any test binary) or `error[` fails the suite.
pub(crate) fn suite_passed(output: &str) -> bool {
    output.contains("test result:") && !output.contains("FAILED") && !output.contains("error[")
}

/// What running one test actually did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Passed,
    Failed,
    /// The named test did not run (not found after a rename, a compile error, or only
    /// doctests matched). Honest: this is NOT a pass.
    DidNotRun,
}

/// Decide the outcome from cargo's output by the EXACT per-test line
/// (`test <path> ... ok` / `... FAILED`). This avoids the trap where `test result: ok.`
/// from doctests (0 passed) would read as a pass when the target test never ran. Explicit
/// and testable without compiling anything.
pub(crate) fn test_outcome(output: &str, path: &str) -> Outcome {
    if output.contains(&format!("test {path} ... FAILED")) {
        return Outcome::Failed;
    }
    if output.contains(&format!("test {path} ... ok")) {
        return Outcome::Passed;
    }
    Outcome::DidNotRun
}

// ── Go test discovery (syntactic) ────────────────────────────────────────────────

/// Collect Go tests: `func TestXxx(...)` in `*_test.go` files. Addressed by function name
/// (`go test -run '^Name$'`). Honest and additive — Rust stays the default toolchain.
fn collect_go_tests(root: &Path, out: &mut Vec<TestItem>) {
    let mut files = Vec::new();
    walk_go(root, 0, &mut files);
    for path in files {
        let code = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let file = display_path(&path, root);
        for (name, line) in go_test_names(&code) {
            out.push(TestItem {
                path: name.clone(), // go test -run addresses by function name
                name,
                file: file.clone(),
                line,
                ignored: false,
                lang: "go".to_string(),
            });
        }
    }
}

fn walk_go(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 12 {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if name.starts_with('.') || matches!(name.as_str(), "vendor" | "node_modules" | "target") {
                continue;
            }
            walk_go(&e.path(), depth + 1, out);
        } else if name.ends_with("_test.go") {
            out.push(e.path());
        }
    }
}

/// Parse top-level `func TestXxx(` names (with their 1-based line). Excludes `TestMain`
/// (the special entry point) and non-test `Test`-prefixed names (next char must be
/// uppercase/digit/underscore, the Go test convention `go test` actually runs).
pub(crate) fn go_test_names(code: &str) -> Vec<(String, u32)> {
    let mut out = Vec::new();
    for (i, line) in code.lines().enumerate() {
        let rest = match line.trim_start().strip_prefix("func ") {
            Some(r) => r,
            None => continue,
        };
        let paren = match rest.find('(') {
            Some(p) => p,
            None => continue,
        };
        let name = rest[..paren].trim();
        if !name.starts_with("Test") || name == "TestMain" || name.len() <= 4 {
            continue;
        }
        let c = name.as_bytes()[4];
        if c == b'_' || c.is_ascii_uppercase() || c.is_ascii_digit() {
            out.push((name.to_string(), (i as u32) + 1));
        }
    }
    out
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
                        lang: "rust".to_string(),
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
    fn go_test_names_filtra_bem() {
        let code = "package demo\n\
            import \"testing\"\n\
            func TestSoma(t *testing.T) {}\n\
            func TestMain(m *testing.M) {}\n\
            func Testing() {}\n\
            func helper() {}\n\
            func Test_edge(t *testing.T) {}\n";
        let found = go_test_names(code);
        let names: Vec<&str> = found.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"TestSoma"));
        assert!(names.contains(&"Test_edge"));
        assert!(!names.contains(&"TestMain"), "TestMain é especial, não é teste");
        assert!(!names.contains(&"Testing"), "'Testing' não segue a convenção");
        assert!(!names.contains(&"helper"));
    }

    #[test]
    fn discover_tests_inclui_go() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("math_test.go"),
            "package demo\nimport \"testing\"\nfunc TestAdd(t *testing.T) {}\n",
        )
        .unwrap();
        let found = discover_tests(root);
        let go = found.iter().find(|t| t.name == "TestAdd").expect("TestAdd descoberto");
        assert_eq!(go.lang, "go");
        assert_eq!(go.path, "TestAdd");
        assert!(go.file.ends_with("math_test.go"));
    }

    #[test]
    fn parser_do_resultado_do_cargo() {
        let p = "tests::soma";
        assert_eq!(
            test_outcome("running 1 test\ntest tests::soma ... ok\ntest result: ok. 1 passed", p),
            Outcome::Passed
        );
        assert_eq!(
            test_outcome("test tests::soma ... FAILED\ntest result: FAILED. 0 passed; 1 failed", p),
            Outcome::Failed
        );
        // 0 tests ran (name not found) — doctests still print "test result: ok." but the
        // target never ran. Must NOT be a pass.
        assert_eq!(
            test_outcome("running 0 tests\ntest result: ok. 0 passed; 0 failed; 1 filtered out", p),
            Outcome::DidNotRun
        );
        assert_eq!(test_outcome("error[E0308]: mismatched types", p), Outcome::DidNotRun);
    }

    #[test]
    fn parser_da_suite_completa() {
        assert!(suite_passed("test result: ok. 3 passed; 0 failed"));
        assert!(!suite_passed("test foo ... FAILED\ntest result: FAILED. 2 passed; 1 failed"));
        assert!(!suite_passed("error[E0425]: cannot find value"));
        assert!(!suite_passed("sem resultado")); // nada correu
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
