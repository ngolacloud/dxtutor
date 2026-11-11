//! Offline code review over REAL project files (not the guided snippets).
//!
//! This is the AI-independent primary review layer: it runs whatever local
//! analyzers are available (Rust `cargo`/Clippy, Go `go vet`, Python Ruff) over a
//! real project and turns their output into a rich [`Finding`] model — origin,
//! rule, location (with cross-file related spans), severity, class, evidence,
//! consequence and how to verify a fix. It must work with the network down and no
//! model configured; it reports which analyzers ran, which failed and what was
//! covered, so a missing tool degrades honestly instead of pretending "no issues".
//!
//! Reuses the `tutor-eval` sandbox harness ([`run_guarded`]) so a runaway analyzer
//! is killed by wall-clock with its whole process group.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;

use crate::runner::{configure_cargo_env, run_guarded};

/// Wall-clock cap for a single analyzer invocation over a real project.
const REVIEW_TIMEOUT: Duration = Duration::from_secs(180);

// ── The finding model ───────────────────────────────────────────────────────────

/// How strong a finding's claim is. The distinction is the honesty contract of the
/// review: we never call a style lint a bug, nor a compile error a mere suggestion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FindingClass {
    /// Demonstrated defect — e.g. the code does not compile, or a provably wrong use.
    Bug,
    /// Conditional risk — a latent problem that bites under some reachable condition.
    Risk,
    /// Optional improvement — correct today, but clearer/faster/simpler if changed.
    Opportunity,
}

/// Severity as surfaced to the editor (maps onto Monaco marker severities).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewSeverity {
    Error,
    Warning,
    Info,
}

/// A location in the project. Lines/columns are 1-based; `file` is whatever path the
/// analyzer reported (usually project-relative), echoed verbatim so the UI can open it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub file: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    /// An analyzer-provided label for this span (e.g. "value moved here"), if any.
    pub label: Option<String>,
}

/// One review finding, carrying every field the panel needs: origin, rule,
/// location + related locations (cross-file evidence), severity, class, and the
/// honest "what is the evidence / what breaks / how do I verify the fix" triple.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Where it came from: "clippy", "rustc", "go vet", "ruff", …
    pub analyzer: String,
    /// Rule / lint / error code when the analyzer gives one (e.g. "clippy::needless_return", "E0382", "F821").
    pub rule: Option<String>,
    pub class: FindingClass,
    pub severity: ReviewSeverity,
    pub message: String,
    /// Primary location — the expression/line the finding anchors to.
    pub primary: Span,
    /// Related locations (notes/help, the other side of a move, a cross-file cause).
    pub related: Vec<Span>,
    /// The concrete evidence (a span label or snippet), when the analyzer supplies it.
    pub evidence: Option<String>,
    /// What goes wrong if left unaddressed.
    pub consequence: Option<String>,
    /// How to confirm a fix.
    pub verification: Option<String>,
    /// A machine-applicable fix the analyzer itself proposes (Clippy/Ruff), ready to
    /// drop into the editor as a placeholder. `None` when the tool offers no auto-fix.
    pub fix: Option<SuggestedFix>,
}

/// An analyzer-proposed edit: replace the given span with `replacement`
/// (empty `replacement` means "delete this span").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedFix {
    /// Human title, e.g. "replace with `x`" or "remove this".
    pub title: String,
    pub replacement: String,
    pub file: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

// ── Analyzer availability & run report ──────────────────────────────────────────

/// A locally-installed analyzer the review can use, with its probed version.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerInfo {
    pub id: String,
    pub language: String,
    pub available: bool,
    pub version: Option<String>,
    /// Why it is unavailable, or any caveat.
    pub note: Option<String>,
}

/// What happened to one analyzer during a review pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnalyzerStatus {
    /// Ran and produced results (possibly zero findings).
    Ran,
    /// Started but failed (timeout, offline deps missing, crash).
    Failed,
    /// Not installed on this host.
    Unavailable,
    /// Not applicable to the selected scope (no files of its language).
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerRun {
    pub id: String,
    pub language: String,
    pub status: AnalyzerStatus,
    /// Human-readable detail (failure reason, coverage note).
    pub detail: Option<String>,
    pub files_covered: usize,
}

/// The scope the developer chose to review.
#[derive(Debug, Clone)]
pub enum ReviewScope {
    /// Just this one file (findings from other files are filtered out).
    File(String),
    /// Files with uncommitted changes (via `git`), falling back to the whole project.
    WorkingChanges,
    /// The whole project.
    Project,
}

/// The full result of a review pass: the findings plus an honest coverage report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReport {
    pub findings: Vec<Finding>,
    pub analyzers: Vec<AnalyzerRun>,
    /// Echoed document/content version so a late result never paints over new code.
    pub version: Option<String>,
}

// ── Availability detection ──────────────────────────────────────────────────────

/// Probes a tool's version by running `prog args…` and capturing the first output
/// line. Returns `None` if the program is absent or errors.
fn probe_version(prog: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(prog).args(args).output().ok()?;
    if !out.status.success() && out.stdout.is_empty() {
        return None;
    }
    let text = if out.stdout.is_empty() {
        String::from_utf8_lossy(&out.stderr)
    } else {
        String::from_utf8_lossy(&out.stdout)
    };
    text.lines().next().map(|l| l.trim().to_string())
}

/// The `go` binary: prefer the standard install path, fall back to PATH.
fn go_bin() -> String {
    let p = "/usr/local/go/bin/go";
    if Path::new(p).exists() {
        p.to_string()
    } else {
        "go".to_string()
    }
}

/// Detect which review analyzers are installed on this host. Drives the honest
/// "which analyzers worked" report and lets the UI advertise real capability.
pub fn detect_analyzers() -> Vec<AnalyzerInfo> {
    let info = |id: &str, language: &str, version: Option<String>, note: Option<String>| AnalyzerInfo {
        id: id.to_string(),
        language: language.to_string(),
        available: version.is_some(),
        version,
        note,
    };

    vec![
        info("cargo", "rust", probe_version("cargo", &["--version"]), None),
        info(
            "clippy",
            "rust",
            probe_version("cargo", &["clippy", "--version"]),
            Some("Lints beyond the compiler.".into()),
        ),
        info(
            "rust-analyzer",
            "rust",
            probe_version("rust-analyzer", &["--version"]),
            Some("Semantic engine for the CodeMap.".into()),
        ),
        info("go", "go", probe_version(&go_bin(), &["version"]), None),
        info(
            "gopls",
            "go",
            probe_version("gopls", &["version"]),
            Some("Semantic engine for Go review and the CodeMap.".into()),
        ),
        info("ruff", "python", probe_version("ruff", &["--version"]), None),
        info("python", "python", probe_version("python3", &["--version"]), None),
    ]
}

// ── Public entry point ──────────────────────────────────────────────────────────

/// Review `root` at the given `scope`. Runs every applicable, available analyzer,
/// returning the findings plus a per-analyzer coverage report. `version` is echoed
/// back untouched so the caller can drop a result that is stale for the buffer.
///
/// Analyzers are additive: today Rust (Clippy/cargo) is wired; Go and Python slot in
/// behind the same `AnalyzerRun`/`Finding` contract without changing this signature.
pub fn review(root: &Path, scope: &ReviewScope, version: Option<String>) -> Result<ReviewReport> {
    let mut findings = Vec::new();
    let mut analyzers = Vec::new();

    // ── Rust ────────────────────────────────────────────────────────────────────
    if root.join("Cargo.toml").exists() {
        let (run, mut rust_findings) = review_rust(root, scope);
        analyzers.push(run);
        findings.append(&mut rust_findings);
    }

    // ── Go ──────────────────────────────────────────────────────────────────────
    if root.join("go.mod").exists() {
        let (run, mut go_findings) = review_go(root, scope);
        analyzers.push(run);
        findings.append(&mut go_findings);
    }

    // ── Python ──────────────────────────────────────────────────────────────────
    if scope_has_python(root, scope) {
        let (run, mut py_findings) = review_python(root, scope);
        analyzers.push(run);
        findings.append(&mut py_findings);
    }

    Ok(ReviewReport {
        findings,
        analyzers,
        version,
    })
}

// ── Rust adapter ────────────────────────────────────────────────────────────────

/// Runs Clippy (or `cargo check` when Clippy is absent) over the Rust project and
/// parses the compiler JSON stream into findings, filtered to `scope`.
fn review_rust(root: &Path, scope: &ReviewScope) -> (AnalyzerRun, Vec<Finding>) {
    let clippy = probe_version("cargo", &["clippy", "--version"]).is_some();
    let (tool, subcmd) = if clippy { ("clippy", "clippy") } else { ("rustc", "check") };

    let mut cmd = Command::new("cargo");
    cmd.args([subcmd, "--quiet", "--message-format=json", "--all-targets"]);
    cmd.current_dir(root);
    configure_cargo_env(&mut cmd);

    // The guard writes stdout/stderr to files in a scratch dir, not the project.
    let scratch = match tempfile::Builder::new().prefix("dxtutor-review-").tempdir() {
        Ok(d) => d,
        Err(e) => {
            return (
                failed_run(tool, "rust", format!("scratch dir: {e}")),
                Vec::new(),
            )
        }
    };

    let outcome = match run_guarded(cmd, scratch.path(), "review", REVIEW_TIMEOUT, None) {
        Ok(o) => o,
        Err(e) => return (failed_run(tool, "rust", format!("spawn: {e}")), Vec::new()),
    };

    if outcome.timed_out {
        return (
            failed_run(tool, "rust", format!("timed out after {}s", REVIEW_TIMEOUT.as_secs())),
            Vec::new(),
        );
    }

    let mut findings = parse_cargo_json(&outcome.stdout, tool);

    // Offline builds with uncached deps fail before linting: surface that honestly
    // instead of reporting a misleading "no issues".
    if findings.is_empty() && outcome.status.map(|s| !s.success()).unwrap_or(true) {
        let reason = first_nonempty_line(&outcome.stderr)
            .unwrap_or_else(|| "cargo exited non-zero with no diagnostics".into());
        return (failed_run(tool, "rust", reason), Vec::new());
    }

    findings.retain(|f| !is_noise_path(&f.primary.file)); // drop target/ generated code
    let covered = count_scope_files(&findings, scope);
    filter_scope(&mut findings, scope, root);

    (
        AnalyzerRun {
            id: tool.to_string(),
            language: "rust".into(),
            status: AnalyzerStatus::Ran,
            detail: if clippy {
                None
            } else {
                Some("Clippy not installed — compiler checks only.".into())
            },
            files_covered: covered,
        },
        findings,
    )
}

fn failed_run(tool: &str, language: &str, detail: impl Into<String>) -> AnalyzerRun {
    AnalyzerRun {
        id: tool.to_string(),
        language: language.to_string(),
        status: AnalyzerStatus::Failed,
        detail: Some(detail.into()),
        files_covered: 0,
    }
}

/// Parse `cargo --message-format=json` output (one JSON object per line) into
/// findings. Only `compiler-message` records with a primary span become findings;
/// child notes/help turn into related spans.
fn parse_cargo_json(stdout: &str, tool: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("reason").and_then(|r| r.as_str()) != Some("compiler-message") {
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        let level = msg.get("level").and_then(|l| l.as_str()).unwrap_or("");
        // Skip pure note/help top-level records; they appear as children of a real one.
        let severity = match level {
            "error" | "error: internal compiler error" => ReviewSeverity::Error,
            "warning" => ReviewSeverity::Warning,
            _ => continue,
        };

        let text = msg
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        // "aborting due to N previous errors" etc. carry no span — skip summaries.
        let rule = msg
            .get("code")
            .and_then(|c| c.get("code"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        let spans = msg.get("spans").and_then(|s| s.as_array());
        let (primary, related) = match split_spans(spans) {
            Some(pair) => pair,
            None => continue, // no location → not an actionable finding
        };

        // Children (notes/help) contribute related spans and evidence.
        let mut related = related;
        if let Some(children) = msg.get("children").and_then(|c| c.as_array()) {
            for child in children {
                if let Some(cspans) = child.get("spans").and_then(|s| s.as_array()) {
                    for s in cspans {
                        if let Some(span) = span_from_json(s) {
                            related.push(span);
                        }
                    }
                }
            }
        }

        let evidence = primary.label.clone();
        let analyzer = finding_analyzer(tool, rule.as_deref());
        let class = classify(severity, rule.as_deref());
        let fix = cargo_fix(msg);

        out.push(Finding {
            analyzer,
            rule,
            class,
            severity,
            message: text,
            consequence: consequence_for(class),
            verification: Some(
                "Apply the change and re-run Code Review; the finding clears when the analyzer no longer reports it.".into(),
            ),
            evidence,
            primary,
            related,
            fix,
        });
    }
    out
}

/// Pick the primary span and collect the rest as related. Returns `None` when there
/// is no span at all.
fn split_spans(spans: Option<&Vec<serde_json::Value>>) -> Option<(Span, Vec<Span>)> {
    let spans = spans?;
    let mut primary = None;
    let mut related = Vec::new();
    for s in spans {
        let is_primary = s.get("is_primary").and_then(|b| b.as_bool()).unwrap_or(false);
        if let Some(span) = span_from_json(s) {
            if is_primary && primary.is_none() {
                primary = Some(span);
            } else {
                related.push(span);
            }
        }
    }
    // If nothing was flagged primary, promote the first span.
    let primary = primary.or_else(|| {
        if related.is_empty() {
            None
        } else {
            Some(related.remove(0))
        }
    })?;
    Some((primary, related))
}

fn span_from_json(s: &serde_json::Value) -> Option<Span> {
    let file = s.get("file_name")?.as_str()?.to_string();
    let start_line = s.get("line_start")?.as_u64()? as u32;
    let end_line = s.get("line_end").and_then(|l| l.as_u64()).unwrap_or(start_line as u64) as u32;
    let start_col = s.get("column_start").and_then(|c| c.as_u64()).unwrap_or(1) as u32;
    let end_col = s.get("column_end").and_then(|c| c.as_u64()).unwrap_or(start_col as u64) as u32;
    let label = s
        .get("label")
        .and_then(|l| l.as_str())
        .map(|l| l.to_string());
    Some(Span {
        file,
        start_line,
        start_col,
        end_line,
        end_col,
        label,
    })
}

/// The reporting origin: a `clippy::` code means Clippy even when invoked via cargo.
fn finding_analyzer(tool: &str, rule: Option<&str>) -> String {
    match rule {
        Some(r) if r.starts_with("clippy::") => "clippy".into(),
        _ if tool == "clippy" => "rustc".into(), // clippy run, but this one is a compiler diagnostic
        _ => "rustc".into(),
    }
}

/// Honest class mapping. A compile error is a demonstrated bug; a plain rustc
/// warning is a conditional risk; a Clippy lint is an optional improvement. (This is
/// deliberately conservative; a Clippy-correctness allowlist can refine it later.)
fn classify(severity: ReviewSeverity, rule: Option<&str>) -> FindingClass {
    match severity {
        ReviewSeverity::Error => FindingClass::Bug,
        _ => match rule {
            Some(r) if r.starts_with("clippy::") => FindingClass::Opportunity,
            _ => FindingClass::Risk,
        },
    }
}

fn consequence_for(class: FindingClass) -> Option<String> {
    match class {
        FindingClass::Bug => Some("The code does not compile as written.".into()),
        FindingClass::Risk => Some("May misbehave under some reachable condition.".into()),
        FindingClass::Opportunity => None,
    }
}

fn unavailable_run(tool: &str, language: &str, detail: impl Into<String>) -> AnalyzerRun {
    AnalyzerRun {
        id: tool.to_string(),
        language: language.to_string(),
        status: AnalyzerStatus::Unavailable,
        detail: Some(detail.into()),
        files_covered: 0,
    }
}

// ── Go adapter (`go vet`) ───────────────────────────────────────────────────────

/// Runs `go vet ./...` over the module and turns each `file:line:col: message` into a
/// conditional-risk finding (vet flags suspicious-but-compiling constructs — a
/// `Printf` format/arg mismatch is the canonical example).
fn review_go(root: &Path, scope: &ReviewScope) -> (AnalyzerRun, Vec<Finding>) {
    let go = go_bin();
    if probe_version(&go, &["version"]).is_none() {
        return (unavailable_run("go vet", "go", "Go toolchain not installed."), Vec::new());
    }
    let scratch = match tempfile::Builder::new().prefix("dxtutor-review-go-").tempdir() {
        Ok(d) => d,
        Err(e) => return (failed_run("go vet", "go", format!("scratch dir: {e}")), Vec::new()),
    };
    let mut cmd = Command::new(&go);
    cmd.args(["vet", "./..."]);
    cmd.current_dir(root);
    cmd.env("GOTOOLCHAIN", "local"); // never pull a toolchain mid-review
    let outcome = match run_guarded(cmd, scratch.path(), "review-go", REVIEW_TIMEOUT, None) {
        Ok(o) => o,
        Err(e) => return (failed_run("go vet", "go", format!("spawn: {e}")), Vec::new()),
    };
    if outcome.timed_out {
        return (
            failed_run("go vet", "go", format!("timed out after {}s", REVIEW_TIMEOUT.as_secs())),
            Vec::new(),
        );
    }
    // `go vet` writes diagnostics to stderr.
    let mut findings = parse_go_vet(&outcome.stderr);
    findings.retain(|f| !is_noise_path(&f.primary.file));
    let covered = count_scope_files(&findings, scope);
    filter_scope(&mut findings, scope, root);
    (
        AnalyzerRun {
            id: "go vet".into(),
            language: "go".into(),
            status: AnalyzerStatus::Ran,
            detail: None,
            files_covered: covered,
        },
        findings,
    )
}

/// Parse `go vet` stderr: lines are either `# package` headers (skipped) or
/// `file:line[:col]: message`.
fn parse_go_vet(stderr: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.splitn(4, ':').collect();
        if parts.len() < 3 {
            continue;
        }
        let file = parts[0].to_string();
        let lineno: u32 = match parts[1].trim().parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let (col, msg) = match parts[2].trim().parse::<u32>() {
            Ok(c) => (c, parts.get(3).map(|s| s.trim()).unwrap_or("").to_string()),
            Err(_) => {
                // No column: the message starts at parts[2].
                let m = if parts.len() > 3 {
                    format!("{}:{}", parts[2], parts[3])
                } else {
                    parts[2].to_string()
                };
                (1, m.trim().to_string())
            }
        };
        if msg.is_empty() {
            continue;
        }
        out.push(Finding {
            analyzer: "go vet".into(),
            rule: None,
            class: FindingClass::Risk,
            severity: ReviewSeverity::Warning,
            message: msg,
            primary: Span {
                file,
                start_line: lineno,
                start_col: col,
                end_line: lineno,
                end_col: col,
                label: None,
            },
            related: Vec::new(),
            evidence: None,
            consequence: Some("A suspicious construct that can misbehave at runtime.".into()),
            verification: Some("Fix it and re-run Code Review; `go vet` should no longer flag it.".into()),
            fix: None,
        });
    }
    out
}

/// Extract a machine-applicable fix from a cargo/clippy message: the first span (in
/// the message or a child help/suggestion) that carries a `suggested_replacement`.
fn cargo_fix(msg: &serde_json::Value) -> Option<SuggestedFix> {
    let scan = |spans: Option<&Vec<serde_json::Value>>| -> Option<SuggestedFix> {
        for s in spans? {
            if let Some(rep) = s.get("suggested_replacement").and_then(|r| r.as_str()) {
                let span = span_from_json(s)?;
                return Some(make_fix(rep, &span));
            }
        }
        None
    };
    if let Some(f) = scan(msg.get("spans").and_then(|s| s.as_array())) {
        return Some(f);
    }
    if let Some(children) = msg.get("children").and_then(|c| c.as_array()) {
        for child in children {
            if let Some(f) = scan(child.get("spans").and_then(|s| s.as_array())) {
                return Some(f);
            }
        }
    }
    None
}

/// Build a `SuggestedFix` for a span, titling it by whether it deletes or replaces.
fn make_fix(replacement: &str, span: &Span) -> SuggestedFix {
    let title = if replacement.trim().is_empty() {
        "remove this".to_string()
    } else {
        let one = replacement.replace('\n', " ");
        let short: String = one.chars().take(60).collect();
        let ell = if one.chars().count() > 60 { "…" } else { "" };
        format!("replace with `{short}{ell}`")
    };
    SuggestedFix {
        title,
        replacement: replacement.to_string(),
        file: span.file.clone(),
        start_line: span.start_line,
        start_col: span.start_col,
        end_line: span.end_line,
        end_col: span.end_col,
    }
}

/// Extract Ruff's first auto-fix edit for a finding, if any.
fn ruff_fix(item: &serde_json::Value) -> Option<SuggestedFix> {
    let fix = item.get("fix")?;
    let edit = fix.get("edits")?.as_array()?.first()?;
    let content = edit.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let file = item.get("filename").and_then(|f| f.as_str()).unwrap_or("").to_string();
    let n = |v: &serde_json::Value, a: &str, b: &str, d: u64| {
        v.get(a).and_then(|l| l.get(b)).and_then(|x| x.as_u64()).unwrap_or(d) as u32
    };
    let sr = n(edit, "location", "row", 1);
    let sc = n(edit, "location", "column", 1);
    let er = n(edit, "end_location", "row", sr as u64);
    let ec = n(edit, "end_location", "column", sc as u64);
    let span = Span { file, start_line: sr, start_col: sc, end_line: er, end_col: ec, label: None };
    let mut f = make_fix(&content, &span);
    if let Some(m) = fix.get("message").and_then(|m| m.as_str()) {
        if !m.is_empty() {
            f.title = m.to_string();
        }
    }
    Some(f)
}

// ── Python adapter (Ruff) ───────────────────────────────────────────────────────

/// Reviews Python with Ruff (`--output-format=json`), which covers both syntax
/// errors (E999) and lints. When Ruff is absent the run is reported Unavailable so
/// the coverage report stays honest.
fn review_python(root: &Path, scope: &ReviewScope) -> (AnalyzerRun, Vec<Finding>) {
    if probe_version("ruff", &["--version"]).is_none() {
        return (
            unavailable_run("ruff", "python", "Ruff not installed — Python review degraded."),
            Vec::new(),
        );
    }
    let target = match scope {
        ReviewScope::File(p) => normalize(p, root),
        _ => root.to_string_lossy().to_string(),
    };
    let scratch = match tempfile::Builder::new().prefix("dxtutor-review-py-").tempdir() {
        Ok(d) => d,
        Err(e) => return (failed_run("ruff", "python", format!("scratch dir: {e}")), Vec::new()),
    };
    let mut cmd = Command::new("ruff");
    cmd.args([
        "check",
        "--output-format=json",
        "--quiet",
        "--exclude",
        ".ruff_cache,target,node_modules,.git,dist,build,.venv,venv,__pycache__,vendor",
        &target,
    ]);
    cmd.current_dir(root);
    let outcome = match run_guarded(cmd, scratch.path(), "review-py", REVIEW_TIMEOUT, None) {
        Ok(o) => o,
        Err(e) => return (failed_run("ruff", "python", format!("spawn: {e}")), Vec::new()),
    };
    if outcome.timed_out {
        return (
            failed_run("ruff", "python", format!("timed out after {}s", REVIEW_TIMEOUT.as_secs())),
            Vec::new(),
        );
    }
    // Ruff exits non-zero when it finds issues — that is success, not failure. A true
    // failure prints to stderr and leaves stdout empty.
    if outcome.stdout.trim().is_empty() && !outcome.stderr.trim().is_empty() {
        return (
            failed_run("ruff", "python", first_nonempty_line(&outcome.stderr).unwrap_or_default()),
            Vec::new(),
        );
    }
    let mut findings = parse_ruff_json(&outcome.stdout);
    findings.retain(|f| !is_noise_path(&f.primary.file));
    let covered = count_scope_files(&findings, scope);
    filter_scope(&mut findings, scope, root);
    (
        AnalyzerRun {
            id: "ruff".into(),
            language: "python".into(),
            status: AnalyzerStatus::Ran,
            detail: None,
            files_covered: covered,
        },
        findings,
    )
}

/// Parse Ruff's JSON array. Each item carries `code`, `message`, `filename`,
/// `location`/`end_location` (1-based row/column). `code == null`/`E999` is a syntax
/// error (a demonstrated bug); `F…` is pyflakes (undefined/unused → conditional
/// risk); everything else is a style opportunity.
fn parse_ruff_json(stdout: &str) -> Vec<Finding> {
    let arr: Vec<serde_json::Value> = serde_json::from_str(stdout.trim()).unwrap_or_default();
    let mut out = Vec::new();
    for item in arr {
        let code = item.get("code").and_then(|c| c.as_str()).map(|s| s.to_string());
        let message = item
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let file = item
            .get("filename")
            .and_then(|f| f.as_str())
            .unwrap_or("")
            .to_string();
        let row = item
            .get("location")
            .and_then(|l| l.get("row"))
            .and_then(|r| r.as_u64())
            .unwrap_or(1) as u32;
        let col = item
            .get("location")
            .and_then(|l| l.get("column"))
            .and_then(|c| c.as_u64())
            .unwrap_or(1) as u32;
        let end_row = item
            .get("end_location")
            .and_then(|l| l.get("row"))
            .and_then(|r| r.as_u64())
            .unwrap_or(row as u64) as u32;
        let end_col = item
            .get("end_location")
            .and_then(|l| l.get("column"))
            .and_then(|c| c.as_u64())
            .unwrap_or(col as u64) as u32;
        let (class, severity) = classify_ruff(code.as_deref());
        let fix = ruff_fix(&item);
        out.push(Finding {
            analyzer: "ruff".into(),
            rule: code,
            class,
            severity,
            message,
            primary: Span {
                file,
                start_line: row,
                start_col: col,
                end_line: end_row,
                end_col: end_col,
                label: None,
            },
            related: Vec::new(),
            evidence: None,
            consequence: consequence_for(class),
            verification: Some("Fix it and re-run Code Review; Ruff should no longer report it.".into()),
            fix,
        });
    }
    out
}

fn classify_ruff(code: Option<&str>) -> (FindingClass, ReviewSeverity) {
    match code {
        None => (FindingClass::Bug, ReviewSeverity::Error), // a syntax error with no rule code
        Some("E999") => (FindingClass::Bug, ReviewSeverity::Error),
        Some(c) if c.starts_with('F') => (FindingClass::Risk, ReviewSeverity::Warning), // pyflakes
        _ => (FindingClass::Opportunity, ReviewSeverity::Info), // pycodestyle & friends
    }
}

/// True for generated/cache/vendor paths that are never the developer's source —
/// their contents (binary caches, generated code) produce garbage findings.
fn is_noise_path(file: &str) -> bool {
    file.split(['/', '\\']).any(|seg| {
        matches!(
            seg,
            "target"
                | ".ruff_cache"
                | ".git"
                | "node_modules"
                | "dist"
                | "build"
                | ".venv"
                | "venv"
                | "__pycache__"
                | ".mypy_cache"
                | ".pytest_cache"
                | ".cargo"
                | "vendor"
        )
    })
}

/// Does the scope contain Python? Avoids spawning Ruff on a pure Rust/Go project.
fn scope_has_python(root: &Path, scope: &ReviewScope) -> bool {
    match scope {
        ReviewScope::File(p) => p.ends_with(".py"),
        _ => has_file_with_ext(root, "py", 20_000),
    }
}

/// Bounded recursive scan for a file with the given extension. Skips the usual noise
/// dirs and caps the number of entries visited so a huge tree can't stall the probe.
fn has_file_with_ext(root: &Path, ext: &str, cap: usize) -> bool {
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            seen += 1;
            if seen > cap {
                return false;
            }
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if matches!(name.as_ref(), "target" | ".git" | "node_modules" | "__pycache__" | ".venv") {
                    continue;
                }
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some(ext) {
                return true;
            }
        }
    }
    false
}

// ── Scope handling ──────────────────────────────────────────────────────────────

/// Count distinct files the analyzer actually produced findings for (coverage proxy).
fn count_scope_files(findings: &[Finding], _scope: &ReviewScope) -> usize {
    let mut files: Vec<&str> = findings.iter().map(|f| f.primary.file.as_str()).collect();
    files.sort_unstable();
    files.dedup();
    files.len()
}

/// Keep only findings whose primary span belongs to the selected scope.
fn filter_scope(findings: &mut Vec<Finding>, scope: &ReviewScope, root: &Path) {
    match scope {
        ReviewScope::Project => {}
        ReviewScope::File(path) => {
            let want = normalize(path, root);
            findings.retain(|f| normalize(&f.primary.file, root) == want);
        }
        ReviewScope::WorkingChanges => {
            let changed = git_changed_files(root);
            if changed.is_empty() {
                return; // fall back to the whole project rather than hiding everything
            }
            let changed: Vec<String> = changed.iter().map(|p| normalize(p, root)).collect();
            findings.retain(|f| changed.contains(&normalize(&f.primary.file, root)));
        }
    }
}

/// Normalize a path to an absolute, lexically-cleaned string for comparison.
fn normalize(path: &str, root: &Path) -> String {
    let p = Path::new(path);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    };
    abs.to_string_lossy().replace("/./", "/")
}

/// Files with uncommitted changes, via `git`. Empty on any failure (caller falls back).
fn git_changed_files(root: &Path) -> Vec<String> {
    let out = Command::new("git")
        .args(["diff", "--name-only", "HEAD"])
        .current_dir(root)
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn first_nonempty_line(s: &str) -> Option<String> {
    s.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn detects_at_least_cargo() {
        let found = detect_analyzers();
        assert!(found.iter().any(|a| a.id == "cargo"));
        // The list always advertises every known analyzer, available or not.
        assert!(found.iter().any(|a| a.id == "ruff"));
    }

    /// End-to-end on a throwaway Rust crate with a known Clippy lint. Skips its
    /// assertion when Clippy is not installed (keeps CI honest on bare hosts).
    #[test]
    fn rust_review_finds_a_clippy_lint() {
        let clippy = probe_version("cargo", &["clippy", "--version"]).is_some();
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"rev\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[lib]\npath = \"src/lib.rs\"\n",
        )
        .unwrap();
        // `return x;` as the last expression trips clippy::needless_return.
        fs::write(
            root.join("src/lib.rs"),
            "pub fn f() -> i32 {\n    let x = 5;\n    return x;\n}\n",
        )
        .unwrap();

        let report = review(root, &ReviewScope::Project, Some("v1".into())).expect("review");
        assert_eq!(report.version.as_deref(), Some("v1"));
        assert!(report.analyzers.iter().any(|a| a.language == "rust"));

        if clippy {
            let rust = report
                .analyzers
                .iter()
                .find(|a| a.language == "rust")
                .unwrap();
            assert_eq!(rust.status, AnalyzerStatus::Ran, "detail: {:?}", rust.detail);
            assert!(
                report
                    .findings
                    .iter()
                    .any(|f| f.rule.as_deref() == Some("clippy::needless_return")),
                "expected a needless_return finding, got: {:?}",
                report.findings.iter().map(|f| &f.rule).collect::<Vec<_>>()
            );
            // That finding is an optional improvement, not a bug, and it is located.
            let nr = report
                .findings
                .iter()
                .find(|f| f.rule.as_deref() == Some("clippy::needless_return"))
                .unwrap();
            assert_eq!(nr.class, FindingClass::Opportunity);
            assert_eq!(nr.analyzer, "clippy");
            assert!(nr.primary.file.ends_with("lib.rs"));
            assert!(nr.primary.start_line >= 1);
        }
    }

    /// `go vet` over a module with a `Printf` format/arg mismatch — the prompt's own
    /// Go example. Skips when the Go toolchain is absent.
    #[test]
    fn go_review_finds_a_vet_issue() {
        if probe_version(&go_bin(), &["version"]).is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("go.mod"), "module rev\n\ngo 1.21\n").unwrap();
        fs::write(
            root.join("main.go"),
            "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Printf(\"%d\", \"hello\")\n}\n",
        )
        .unwrap();

        let report = review(root, &ReviewScope::Project, None).expect("review");
        let go = report.analyzers.iter().find(|a| a.language == "go").unwrap();
        assert_eq!(go.status, AnalyzerStatus::Ran, "detail: {:?}", go.detail);
        let f = report
            .findings
            .iter()
            .find(|f| f.analyzer == "go vet" && f.message.contains("Printf"))
            .expect("expected a Printf vet finding");
        assert_eq!(f.class, FindingClass::Risk);
        assert!(f.primary.file.ends_with("main.go"));
    }

    /// Ruff over a file that references an undefined name — the prompt's Python
    /// example (F821). Skips when Ruff is absent.
    #[test]
    fn python_review_finds_undefined_name() {
        if probe_version("ruff", &["--version"]).is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("mod.py"), "def f():\n    return undefined_name\n").unwrap();

        let report = review(root, &ReviewScope::Project, None).expect("review");
        let py = report.analyzers.iter().find(|a| a.language == "python").unwrap();
        assert_eq!(py.status, AnalyzerStatus::Ran, "detail: {:?}", py.detail);
        let f = report
            .findings
            .iter()
            .find(|f| f.rule.as_deref() == Some("F821"))
            .expect("expected an F821 undefined-name finding");
        assert_eq!(f.class, FindingClass::Risk);
        assert!(f.primary.file.ends_with("mod.py"));
        assert!(f.primary.start_line >= 1);
    }
}
