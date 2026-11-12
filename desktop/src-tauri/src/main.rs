// Prevent an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! dxtutor desktop — Tauri backend.
//!
//! Exposes the dxtutor "brain" (the `tutor-*` crates) to the webview through a
//! handful of Tauri commands, and bridges an embedded xterm terminal to a real
//! PTY. Every command serializes with serde_json and handles errors without
//! panicking (results come back as `Result<_, String>`).
//!
//! Honesty principle: `submit` reports correctness strictly from the hidden
//! tests (`tutor_eval::assess`), exposes the empirical complexity estimate with
//! its R²/confidence, and only ships the curated gabarito. `request_hint` uses
//! the offline-safe provider when no API key is present.

mod fsops;
mod pty;

use serde::Serialize;
use tutor_core::{Level, Phase, StepKind};
use tutor_eval::{
    Assessment, Confidence, Estimate, ExecutionTrace, MemSample, Pipeline, Severity, Telemetry,
};
use tutor_llm::{
    default_fix_provider, default_plan_provider, default_provider, FixRequest, HintRequest,
    PlanRequest,
};

/// The project the editor loads. Kept in one place so a future selector is easy.
const PROJECT_ID: &str = "rust-word-frequency";

// ── Serializable DTOs (camelCase to match the TypeScript frontend) ───────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseDto {
    id: String,
    title: String,
    level: String,
    instructions: String,
    starter: String,
    entry: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDto {
    project_id: String,
    project_title: String,
    language: String,
    summary: String,
    phases: Vec<PhaseDto>,
}

#[derive(Serialize)]
struct CorrectnessDto {
    passed: bool,
    summary: String,
    raw: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComplexityDto {
    big_o: String,
    r_squared: f64,
    exponent: f64,
    confidence: String,
    ranking: Vec<(String, f64)>,
}

#[derive(Serialize)]
struct GabaritoDto {
    solution: String,
    time: String,
    space: String,
    justification: String,
}

#[derive(Serialize)]
struct AssessmentDto {
    correctness: CorrectnessDto,
    complexity: Option<ComplexityDto>,
    expected: Option<String>,
    /// The curated reference solution — **only present after the hidden tests pass**.
    /// On a failed attempt this is `None`, so no application path can leak the answer
    /// (P0 honesty contract). See [`reveal_gabarito`].
    gabarito: Option<GabaritoDto>,
}

#[derive(Serialize)]
struct HintDto {
    text: String,
    provider: String,
    level: u8,
}

#[derive(Serialize)]
struct DiagnosticDto {
    line: u32,
    col: u32,
    severity: String,
    message: String,
    /// Internal, offline, rule-based fix suggestion (no AI). `None` when no rule
    /// matched — the frontend may then fall back to the optional LLM provider.
    suggestion: Option<String>,
}

#[derive(Serialize)]
struct PlanDto {
    steps: Vec<String>,
}

// ── Guided-learning DTOs (camelCase) ─────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StepDto {
    /// "concept" | "drill" | "challenge".
    kind: String,
    id: String,
    title: String,
    points: u32,
    /// Pedagogical briefing shown BEFORE the exercise: how the computation solves
    /// this problem (markdown). Populated for every step kind.
    intro: String,
    /// Increasing difficulty marker (0 = none). Presentation only.
    difficulty: u8,
    /// concept: markdown body.
    body: String,
    /// drill: what/why (markdown).
    prompt: String,
    /// drill: the exact complete Rust program to retype.
    target: String,
    /// drill: shown after the program runs.
    explanation: String,
    /// drill: one explanation per line of `target`, aligned by index
    /// (`lineComments[i]` explains line `i` of `target.split('\n')`). Empty when
    /// the step carries no per-line comments.
    line_comments: Vec<String>,
    /// "shown" (basic units: the placeholder/target appears at once) or
    /// "on_demand" (advanced units: hidden until the student clicks Show
    /// placeholder). Defaults to "shown".
    placeholder_policy: String,
    /// Package-manager commands to SHOW the student to install this exercise's
    /// external packages (e.g. `["go get github.com/google/uuid"]`). Empty when the
    /// exercise needs only the standard library. Display/teaching only.
    install_commands: Vec<String>,
    /// Command to SHOW the student to run this exercise on the CLI (e.g.
    /// `"go run ."` or `"go test ./..."`). Empty when not applicable. Display only.
    run_command: String,
    /// Extra Cargo `[dependencies]` lines this step needs (Rust). Unlike
    /// `install_commands` (display only), these are actually sent to `run_drill`
    /// and written into the scaffolded crate so it compiles. Empty for std-only.
    dependencies: Vec<String>,
    /// challenge: markdown instructions.
    instructions: String,
    /// challenge: the function name to implement.
    entry: String,
    /// challenge: starter code.
    starter: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnitDto {
    id: String,
    title: String,
    intro: String,
    /// Increasing difficulty marker (0 = none). Presentation only.
    difficulty: u8,
    /// Pedagogical level: "basic" | "intermediate" | "advanced". Lets the
    /// frontend organize and filter the track by level.
    level: String,
    steps: Vec<StepDto>,
}

// ── Scaffolding DTOs (glossary + study guide) ────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GlossaryEntryDto {
    keyword: String,
    summary: String,
    when_to_use: String,
    example: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GlossaryDto {
    entries: Vec<GlossaryEntryDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StudyGuideDto {
    title: String,
    /// Markdown body re-explaining the unit's concepts calmly.
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CourseDto {
    id: String,
    language: String,
    title: String,
    level: String,
    summary: String,
    units: Vec<UnitDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunDto {
    ok: bool,
    stdout: String,
    stderr: String,
}

// ── Honest observability DTOs (measured run + compiler pipeline) ──────────────

/// One point of the memory time-series sampled DURING the measured run: elapsed
/// time (ms) and resident set size (KB), read from `/proc/<pid>/statm`. Serialized
/// as `tMs`/`rssKb`. Nothing fabricated — it's what the kernel reported.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleDto {
    t_ms: f64,
    rss_kb: u64,
}

/// Real, kernel-measured telemetry of the student's binary (nothing fabricated):
/// wall clock, user/sys CPU, peak RSS, I/O blocks (all from `wait4`/`rusage`), plus
/// a memory time-series (`samples`) sampled live from `/proc` during the run.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryDto {
    wall_ms: f64,
    cpu_user_ms: f64,
    cpu_sys_ms: f64,
    peak_rss_kb: u64,
    io_read_blocks: u64,
    io_write_blocks: u64,
    exit_code: i32,
    /// Memory time-series sampled during execution (empty if unavailable).
    samples: Vec<SampleDto>,
}

/// A run plus its telemetry. `run` has the same shape as `run_drill`'s output.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MeasuredRunDto {
    run: RunDto,
    telemetry: TelemetryDto,
}

/// The compiler's intermediate representations for the student's code, produced
/// by the real toolchain. Anything the toolchain cannot emit stays empty, with
/// the honest reason in `notes`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineDto {
    mir: String,
    llvm_ir: String,
    asm: String,
    binary_bytes: u64,
    disasm: String,
    notes: String,
}

// ── Step-through execution trace DTOs (camelCase) ─────────────────────────────

/// One observed variable in a trace step: name, truncated `repr()`, and its
/// Python `type(...).__name__`. Read from the student's real frame — nothing
/// fabricated.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VarDto {
    name: String,
    value: String,
    ty: String,
}

/// One step of the execution trace: the line about to run (or the call/return),
/// the function, the stack depth, the locals, and the accumulated stdout length.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TraceStepDto {
    line: u32,
    /// "line" | "call" | "return".
    event: String,
    func: String,
    depth: u32,
    locals: Vec<VarDto>,
    stdout_len: u32,
}

/// A full step-through trace of a program's REAL execution (Python-Tutor style).
/// `supported = false` for languages without tracing here, with an honest reason
/// in `notes`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionTraceDto {
    supported: bool,
    notes: String,
    steps: Vec<TraceStepDto>,
    stdout: String,
}

// ── Conversions ───────────────────────────────────────────────────────────────

fn level_str(level: Level) -> &'static str {
    match level {
        Level::Basico => "basico",
        Level::Intermedio => "intermedio",
        Level::Avancado => "avancado",
    }
}

fn confidence_str(c: Confidence) -> &'static str {
    match c {
        Confidence::Low => "low",
        Confidence::Medium => "medium",
        Confidence::High => "high",
    }
}

/// `serde_json` turns non-finite floats (`NaN`, `±∞`) into JSON `null`, which then
/// crashes `.toFixed()` in the webview. Some complexity classes (e.g. exponential
/// at these sizes) legitimately fit to a non-finite R², so sanitize before sending.
fn finite(x: f64) -> f64 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

fn complexity_dto(est: &Estimate) -> ComplexityDto {
    ComplexityDto {
        big_o: est.big_o().to_string(),
        r_squared: finite(est.r_squared),
        exponent: finite(est.loglog_exponent),
        confidence: confidence_str(est.confidence).to_string(),
        ranking: est
            .ranking
            .iter()
            .map(|(class, r2)| (class.big_o().to_string(), finite(*r2)))
            .collect(),
    }
}

fn phase_dto(p: &Phase) -> PhaseDto {
    PhaseDto {
        id: p.id.clone(),
        title: p.title.clone(),
        level: level_str(p.level).to_string(),
        instructions: p.instructions.clone(),
        starter: p.starter.clone(),
        entry: p.entry.clone(),
    }
}

fn step_kind_str(kind: StepKind) -> &'static str {
    match kind {
        StepKind::Concept => "concept",
        StepKind::Drill => "drill",
        StepKind::Challenge => "challenge",
    }
}

fn step_dto(s: &tutor_core::Step) -> StepDto {
    // Note: the hidden `tests` and `gabarito` are deliberately NOT exposed — the
    // honesty principle keeps the source of truth out of the webview.
    StepDto {
        kind: step_kind_str(s.kind).to_string(),
        id: s.id.clone(),
        title: s.title.clone(),
        points: s.points,
        intro: s.intro.clone(),
        difficulty: s.difficulty,
        body: s.body.clone(),
        prompt: s.prompt.clone(),
        target: s.target.clone(),
        explanation: s.explanation.clone(),
        line_comments: s.line_comments.clone(),
        placeholder_policy: s.placeholder_policy.clone(),
        install_commands: s.install_commands.clone(),
        run_command: s.run_command.clone(),
        dependencies: s.dependencies.clone(),
        instructions: s.instructions.clone(),
        entry: s.entry.clone(),
        starter: s.starter.clone(),
    }
}

fn course_dto(c: &tutor_core::Course) -> CourseDto {
    CourseDto {
        id: c.id.clone(),
        language: c.language.clone(),
        title: c.title.clone(),
        level: c.level.clone(),
        summary: c.summary.clone(),
        units: c
            .units
            .iter()
            .map(|u| UnitDto {
                id: u.id.clone(),
                title: u.title.clone(),
                intro: u.intro.clone(),
                difficulty: u.difficulty,
                level: u.level.clone(),
                steps: u.steps.iter().map(step_dto).collect(),
            })
            .collect(),
    }
}

/// Reveal the curated gabarito **only when the submission passed the hidden tests**.
///
/// This is the single decision that gates the reference solution: a failed attempt
/// gets `None`, so the DTO that reaches the webview never carries the answer (nor its
/// revealing justification). Pure and deterministic, so the harness can prove the
/// contract at the real serialization boundary without building a `Phase`.
fn reveal_gabarito(passed: bool, g: &tutor_core::Gabarito) -> Option<GabaritoDto> {
    if !passed {
        return None;
    }
    Some(GabaritoDto {
        solution: g.solution.clone(),
        time: g.time.clone(),
        space: g.space.clone(),
        justification: g.justification.clone(),
    })
}

/// Build the assessment DTO from an evaluation plus the phase that was graded
/// (the gabarito travels with the phase). Shared by `submit` and `submit_step`.
fn assessment_dto(a: &Assessment, phase: &Phase) -> AssessmentDto {
    AssessmentDto {
        correctness: CorrectnessDto {
            passed: a.correctness.passed,
            summary: a.correctness.summary.clone(),
            raw: a.correctness.raw.clone(),
        },
        complexity: a.complexity.as_ref().map(complexity_dto),
        expected: a.expected.as_ref().map(|c| c.big_o().to_string()),
        // Honesty contract: no solution in the payload unless the tests passed.
        gabarito: reveal_gabarito(a.correctness.passed, &phase.gabarito),
    }
}

fn sample_dto(s: &MemSample) -> SampleDto {
    SampleDto {
        t_ms: finite(s.t_ms),
        rss_kb: s.rss_kb,
    }
}

fn telemetry_dto(t: &Telemetry) -> TelemetryDto {
    TelemetryDto {
        wall_ms: finite(t.wall_ms),
        cpu_user_ms: finite(t.cpu_user_ms),
        cpu_sys_ms: finite(t.cpu_sys_ms),
        peak_rss_kb: t.peak_rss_kb,
        io_read_blocks: t.io_read_blocks,
        io_write_blocks: t.io_write_blocks,
        exit_code: t.exit_code,
        samples: t.samples.iter().map(sample_dto).collect(),
    }
}

fn pipeline_dto(p: Pipeline) -> PipelineDto {
    PipelineDto {
        mir: p.mir,
        llvm_ir: p.llvm_ir,
        asm: p.asm,
        binary_bytes: p.binary_bytes,
        disasm: p.disasm,
        notes: p.notes,
    }
}

fn execution_trace_dto(t: ExecutionTrace) -> ExecutionTraceDto {
    ExecutionTraceDto {
        supported: t.supported,
        notes: t.notes,
        steps: t
            .steps
            .into_iter()
            .map(|s| TraceStepDto {
                line: s.line,
                event: s.event,
                func: s.func,
                depth: s.depth,
                locals: s
                    .locals
                    .into_iter()
                    .map(|v| VarDto {
                        name: v.name,
                        value: v.value,
                        ty: v.ty,
                    })
                    .collect(),
                stdout_len: s.stdout_len,
            })
            .collect(),
        stdout: t.stdout,
    }
}

// ── Brain commands ──────────────────────────────────────────────────────────────

/// List the project title and its phases (shown in the sidebar as "files").
#[tauri::command]
fn list_phases() -> Result<ProjectDto, String> {
    let project = tutor_core::load_project(PROJECT_ID)
        .ok_or_else(|| format!("project `{PROJECT_ID}` not found"))?;
    Ok(ProjectDto {
        project_id: project.id.clone(),
        project_title: project.title.clone(),
        language: project.language.clone(),
        summary: project.summary.clone(),
        phases: project.phases.iter().map(phase_dto).collect(),
    })
}

/// Evaluate the student's code for a phase: run the hidden tests (source of
/// truth) and, on pass, measure complexity. Reveal the curated gabarito.
#[tauri::command]
fn submit(phase_id: String, code: String) -> Result<AssessmentDto, String> {
    let project = tutor_core::load_project(PROJECT_ID)
        .ok_or_else(|| format!("project `{PROJECT_ID}` not found"))?;
    let phase = project
        .phase(&phase_id)
        .ok_or_else(|| format!("phase `{phase_id}` not found"))?;

    let assessment =
        tutor_eval::assess(phase, &code).map_err(|e| format!("evaluation failed: {e}"))?;

    Ok(assessment_dto(&assessment, phase))
}

/// Find a guided-course step by id across every built-in course; returns the
/// course language alongside the step. The frontend addresses hints/diagnostics
/// by step id (passed as `phaseId`/`stepId`).
fn course_step(step_id: &str) -> Option<(String, tutor_core::Step)> {
    for course in tutor_core::builtin_courses() {
        if let Some(step) = course.step(step_id) {
            return Some((course.language.clone(), step.clone()));
        }
    }
    None
}

/// Language of the step's course (defaults to Rust when the id is unknown).
fn step_language(step_id: &str) -> String {
    course_step(step_id)
        .map(|(lang, _)| lang)
        .unwrap_or_else(|| "rust".to_string())
}

/// Produce a progressive hint (level 1..3) for a guided-course step. Offline-safe:
/// without `ANTHROPIC_API_KEY` the OfflineProvider returns a useful generic message.
#[tauri::command]
fn request_hint(phase_id: String, code: String, level: u8) -> Result<HintDto, String> {
    let (instructions, entry) = match course_step(&phase_id) {
        Some((_, step)) => (step.instructions.clone(), step.entry.clone()),
        None => (String::new(), String::new()),
    };

    let req = HintRequest {
        instructions,
        entry,
        student_code: code,
        test_output: None,
        level,
    };
    let provider = default_provider();
    let text = provider
        .hint(&req)
        .map_err(|e| format!("hint provider failed: {e}"))?;

    Ok(HintDto {
        text,
        provider: provider.name().to_string(),
        level: req.level(),
    })
}

/// Load a phase (owned) by id, or a readable error.
fn load_phase(phase_id: &str) -> Result<Phase, String> {
    let project = tutor_core::load_project(PROJECT_ID)
        .ok_or_else(|| format!("project `{PROJECT_ID}` not found"))?;
    project
        .phase(phase_id)
        .cloned()
        .ok_or_else(|| format!("phase `{phase_id}` not found"))
}

/// Compiler/syntax diagnostics for the current code — the raw material for the
/// red underline. The runner is chosen by the phase's language (Rust via
/// `cargo check`, JS via the embedded engine). Never judges the exercise.
#[tauri::command]
fn get_diagnostics(step_id: String, code: String) -> Result<Vec<DiagnosticDto>, String> {
    let language = step_language(&step_id);
    let diags = tutor_eval::diagnostics_for(&language, &code)
        .map_err(|e| format!("diagnostics failed: {e}"))?;
    Ok(diags
        .into_iter()
        .map(|d| DiagnosticDto {
            line: d.line,
            col: d.col,
            severity: match d.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
            }
            .to_string(),
            // Internal rule-based suggestion — works offline, no AI needed.
            suggestion: tutor_eval::advise(&language, &d),
            message: d.message,
        })
        .collect())
}

/// Turn a "what I want to solve" comment into a high-level PLAN (steps, no code)
/// so the student types the solution themselves. Offline-safe.
#[tauri::command]
fn request_plan(phase_id: String, comment: String, code: String) -> Result<PlanDto, String> {
    let phase = load_phase(&phase_id)?;
    let req = PlanRequest {
        language: phase.language.clone(),
        comment,
        context_code: code,
    };
    let plan = default_plan_provider()
        .plan(&req)
        .map_err(|e| format!("plan provider failed: {e}"))?;
    Ok(PlanDto { steps: plan.steps })
}

/// Explain a single diagnostic and how to fix THAT line — never rewrites the
/// whole function or solves the exercise. Offline-safe.
#[tauri::command]
fn request_fix(
    phase_id: String,
    code: String,
    line: u32,
    message: String,
) -> Result<String, String> {
    let phase = load_phase(&phase_id)?;
    let req = FixRequest {
        language: phase.language.clone(),
        code,
        line,
        message,
    };
    default_fix_provider()
        .fix_suggestion(&req)
        .map_err(|e| format!("fix provider failed: {e}"))
}

// ── Guided-learning commands ─────────────────────────────────────────────────

/// Load the guided course for a language (e.g. `"rust"`). Returns the course
/// tree (units → steps) the beginner mode renders.
#[tauri::command]
fn get_course(language: String) -> Result<CourseDto, String> {
    let course = tutor_core::builtin_courses()
        .into_iter()
        .find(|c| c.language.eq_ignore_ascii_case(language.trim()))
        .ok_or_else(|| format!("no course for language `{language}`"))?;
    Ok(course_dto(&course))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CourseSummaryDto {
    id: String,
    language: String,
    title: String,
    level: String,
    summary: String,
}

/// List every built-in course (one per language curriculum) so the onboarding can
/// build its language picker dynamically, instead of hard-coding which languages
/// are available. Adding a course (or a plugin language with a course) makes it
/// appear without any frontend change.
#[tauri::command]
fn list_courses() -> Vec<CourseSummaryDto> {
    tutor_core::builtin_courses()
        .into_iter()
        .map(|c| CourseSummaryDto {
            id: c.id,
            language: c.language,
            title: c.title,
            level: c.level,
            summary: c.summary,
        })
        .collect()
}

/// Offline Code Review over a REAL project folder. Runs on a blocking worker (NOT
/// the UI thread), so a multi-second analyzer never stalls the window. `scope` is
/// "file" | "changes" | "project"; `path` names the file for "file" scope. `version`
/// is echoed back untouched so the frontend can discard a result that is stale for
/// the current buffer. Works with the network down and no model configured.
#[tauri::command]
async fn review_code(
    root: String,
    scope: String,
    path: Option<String>,
    version: Option<String>,
) -> Result<tutor_eval::review::ReviewReport, String> {
    use tutor_eval::review::{review, ReviewScope};
    let scope = match scope.as_str() {
        "file" => ReviewScope::File(path.ok_or_else(|| "file scope needs a path".to_string())?),
        "changes" => ReviewScope::WorkingChanges,
        _ => ReviewScope::Project,
    };
    tauri::async_runtime::spawn_blocking(move || {
        review(std::path::Path::new(&root), &scope, version)
    })
    .await
    .map_err(|e| format!("review task failed: {e}"))?
    .map_err(|e| format!("review failed: {e}"))
}

/// The local analyzers installed on this host, so the review UI can advertise what
/// it can really do and show which tools are missing.
#[tauri::command]
fn list_review_analyzers() -> Vec<tutor_eval::review::AnalyzerInfo> {
    tutor_eval::review::detect_analyzers()
}

/// P0-3: verify a review fix is still safe to apply to the CURRENT buffer. `currentSource`
/// is the live editor content; `analyzedVersion` is the file's `content_version` captured
/// when the review ran (from `ReviewReport.fileVersions`). Refuses — preserving the
/// developer's edits — if the buffer drifted or the target snippet no longer matches.
#[tauri::command]
fn verify_review_fix(
    current_source: String,
    analyzed_version: String,
    fix: tutor_eval::review::SuggestedFix,
) -> tutor_eval::review::FixVerification {
    tutor_eval::review::verify_fix(&current_source, &analyzed_version, &fix)
}

/// Dev Assistant: the locally-available Ollama models (empty if none/offline).
#[tauri::command]
fn assistant_models() -> Vec<String> {
    tutor_llm::chat::ollama_models()
}

/// Dev Assistant: send a chat turn to the local model (Ollama) and return the reply.
/// Non-streaming for now; P4 adds streaming + a multi-provider picker. Runs off the
/// UI thread because the HTTP call is blocking.
#[tauri::command]
async fn assistant_chat(
    messages: Vec<tutor_llm::chat::ChatMsg>,
    model: Option<String>,
) -> Result<tutor_llm::chat::ChatReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tutor_llm::chat::ollama_chat(&messages, model.as_deref())
    })
    .await
    .map_err(|e| format!("assistant task failed: {e}"))?
    .map_err(|e| format!("{e}"))
}

/// Cancellation flags for in-flight streaming LLM requests, keyed by request id.
static LLM_CANCELS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
> = std::sync::OnceLock::new();
fn llm_cancels(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>
{
    LLM_CANCELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Stream a Dev-Assistant chat turn. Emits `llm://token` {requestId, delta} per token
/// chunk, then `llm://done` {requestId, model} or `llm://error` {requestId, error}.
/// Returns immediately; the stream runs on a thread (the pty.rs pattern). Cancel it
/// mid-flight with `assistant_cancel(requestId)` — the Stop button.
/// The AI providers and what each can do right now (Ollama live; others gated).
#[tauri::command]
fn list_providers() -> Vec<tutor_llm::chat::ProviderInfo> {
    tutor_llm::chat::list_providers()
}

/// The saved AI/provider settings (keys + Ollama config), for the settings form.
#[tauri::command]
fn get_providers_config() -> tutor_llm::chat::ProvidersConfig {
    tutor_llm::chat::load_config()
}

/// Persist AI/provider settings to `~/.config/dxtutor/providers.json` (mode 0600).
#[tauri::command]
fn save_providers_config(config: tutor_llm::chat::ProvidersConfig) -> Result<(), String> {
    tutor_llm::chat::save_config(&config).map_err(|e| format!("{e}"))
}

/// Is `step_id` an autonomous-application exercise (a challenge the student must
/// implement), as opposed to a transcription drill or concept? Unknown ids are treated
/// as autonomous (fail closed toward the stricter contract).
fn step_is_autonomous(step_id: Option<&str>) -> bool {
    match step_id {
        Some(id) => course_step(id)
            .map(|(_, s)| matches!(s.kind, StepKind::Challenge))
            .unwrap_or(true),
        None => true,
    }
}

/// The active study policy for the given mode + step. The frontend uses it to hide
/// solution/buffer-writing surfaces while an exercise is open (defence in depth); the
/// backend commands enforce the same policy regardless of what the UI shows.
#[tauri::command]
fn study_policy(mode: String, step_id: Option<String>) -> tutor_llm::policy::StudyPolicy {
    use tutor_llm::policy::{policy_for, Mode};
    policy_for(Mode::parse(&mode), step_is_autonomous(step_id.as_deref()))
}

#[tauri::command]
fn assistant_chat_stream(
    app: tauri::AppHandle,
    messages: Vec<tutor_llm::chat::ChatMsg>,
    provider: Option<String>,
    model: Option<String>,
    request_id: String,
    mode: Option<String>,
    step_id: Option<String>,
) {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;
    use tutor_llm::chat::ChatMsg;
    use tutor_llm::policy::{policy_for, tutor_directive, Mode};

    // P0-2: the backend — not the webview — decides the policy from the active mode and
    // step. In study mode the chat is tutor-constrained: prepend the authoritative tutor
    // directive so every provider (local or remote) is steered away from handing over the
    // solution. This is the soft layer; the hard layer is that no command writes the
    // student's buffer and solution/edit surfaces are gated off in study mode.
    let policy = policy_for(
        Mode::parse(mode.as_deref().unwrap_or("study")),
        step_is_autonomous(step_id.as_deref()),
    );
    let messages: Vec<ChatMsg> = if policy.chat_is_tutor {
        let mut m = Vec::with_capacity(messages.len() + 1);
        m.push(ChatMsg {
            role: "system".into(),
            content: tutor_directive().into(),
        });
        m.extend(messages);
        m
    } else {
        messages
    };

    // ollama (local), claude, openai and gemini all have SSE streaming adapters. Any
    // other id fails honestly rather than silently doing nothing.
    let prov = provider.as_deref().unwrap_or("ollama").to_string();
    if !matches!(prov.as_str(), "ollama" | "claude" | "openai" | "gemini") {
        let _ = app.emit(
            "llm://error",
            serde_json::json!({
                "requestId": request_id,
                "error": format!("The “{prov}” provider has no streaming adapter yet. Use Ollama, Claude, OpenAI or Gemini."),
            }),
        );
        return;
    }

    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    llm_cancels().lock().unwrap().insert(request_id.clone(), flag.clone());
    std::thread::spawn(move || {
        let emit_app = app.clone();
        let rid = request_id.clone();
        // One cancel-aware token sink shared by every provider branch.
        let emit = |delta: &str| -> bool {
            if flag.load(Ordering::Relaxed) {
                return false; // cancelled via the Stop button
            }
            let _ = emit_app.emit("llm://token", serde_json::json!({ "requestId": rid, "delta": delta }));
            true
        };
        let res = match prov.as_str() {
            "claude" => tutor_llm::chat::claude_chat_stream_env(&messages, emit),
            "openai" => tutor_llm::chat::openai_chat_stream_env(&messages, model.as_deref(), emit),
            "gemini" => tutor_llm::chat::gemini_chat_stream_env(&messages, model.as_deref(), emit),
            _ => tutor_llm::chat::ollama_chat_stream(&messages, model.as_deref(), emit),
        };
        llm_cancels().lock().unwrap().remove(&request_id);
        match res {
            Ok(reply) => {
                let _ = app.emit(
                    "llm://done",
                    serde_json::json!({ "requestId": request_id, "model": reply.model }),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "llm://error",
                    serde_json::json!({ "requestId": request_id, "error": format!("{e}") }),
                );
            }
        }
    });
}

/// Cancel an in-flight streaming request (the Stop button / interrupt).
#[tauri::command]
fn assistant_cancel(request_id: String) {
    use std::sync::atomic::Ordering;
    if let Some(f) = llm_cancels().lock().unwrap().get(&request_id) {
        f.store(true, Ordering::Relaxed);
    }
}

/// CodeMap: the definitions, references and (inferred) callers of `symbol` across
/// the project at `root`. Runs off the UI thread. This slice is Rust + syntactic
/// (`resolution: "inferred"`); a rust-analyzer-backed resolved path lands later.
#[tauri::command]
async fn symbol_relations(
    root: String,
    symbol: String,
) -> Result<tutor_eval::codemap::Relations, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tutor_eval::codemap::symbol_relations(std::path::Path::new(&root), &symbol)
    })
    .await
    .map_err(|e| format!("codemap task failed: {e}"))?
    .map_err(|e| format!("codemap failed: {e}"))
}

/// Compile and run a COMPLETE Rust program (a drill's target the student retyped)
/// and return its output. Never judges an exercise — it just executes.
#[tauri::command]
fn run_drill(code: String, language: String, dependencies: Vec<String>) -> Result<RunDto, String> {
    // Compile + run a complete program in the drill's language. Go uses `go run`
    // (with `go mod tidy` to fetch any imports); everything else uses the Rust path.
    // `dependencies` are extra Cargo `[dependencies]` lines the drill needs (e.g.
    // rusqlite for the database track); empty for std-only drills. Go resolves its
    // imports via `go mod tidy`, so it ignores this list.
    let out = match language.trim().to_ascii_lowercase().as_str() {
        "go" | "golang" => tutor_eval::run_go_program_with_deps(&code, &dependencies),
        _ => tutor_eval::run_rust_snippet_with_deps(&code, &dependencies),
    }
    .map_err(|e| format!("run failed: {e}"))?;
    Ok(RunDto {
        ok: out.ok,
        stdout: out.stdout,
        stderr: out.stderr,
    })
}

/// Compile and run a COMPLETE Rust program and return its output PLUS real,
/// kernel-measured telemetry (wall clock, user/sys CPU, peak RSS, I/O blocks).
/// Honest observability: every number is measured from the student's own
/// process via `wait4`/`rusage` — no fabricated GPU/NPU figures.
#[tauri::command]
fn run_measured(code: String) -> Result<MeasuredRunDto, String> {
    let (out, telemetry) =
        tutor_eval::run_rust_snippet_measured(&code).map_err(|e| format!("measured run failed: {e}"))?;
    Ok(MeasuredRunDto {
        run: RunDto {
            ok: out.ok,
            stdout: out.stdout,
            stderr: out.stderr,
        },
        telemetry: telemetry_dto(&telemetry),
    })
}

/// Run the real compiler pipeline over the student's code: MIR, LLVM-IR, assembly,
/// binary size, and (if `objdump` exists) a disassembly. Shows honestly what the
/// toolchain actually produces; missing stages are reported in `notes`.
#[tauri::command]
fn compile_pipeline(code: String) -> Result<PipelineDto, String> {
    let pipeline =
        tutor_eval::compile_pipeline(&code).map_err(|e| format!("compile pipeline failed: {e}"))?;
    Ok(pipeline_dto(pipeline))
}

/// Produce a step-through execution TRACE of the student's program (Python-Tutor
/// style): run it under `sys.settrace` and return every executed line/call/return
/// with the frame's locals, stack depth, and accumulated stdout length. Honest:
/// the trace is the REAL execution; runtime errors land in `notes`, nothing is
/// fabricated. Only Python is supported here; other languages come back with
/// `supported = false` and an honest reason.
#[tauri::command]
fn trace_execution(language: String, code: String) -> Result<ExecutionTraceDto, String> {
    let trace = tutor_eval::trace_execution(&language, &code)
        .map_err(|e| format!("trace failed: {e}"))?;
    Ok(execution_trace_dto(trace))
}

/// Grade a `challenge` step: find it across the courses' units, build a `Phase`
/// from it and reuse the honest evaluator (`tutor_eval::assess`).
#[tauri::command]
fn submit_step(step_id: String, code: String) -> Result<AssessmentDto, String> {
    for course in tutor_core::builtin_courses() {
        if let Some(step) = course.step(&step_id) {
            let phase = step
                .as_phase(&course.language, Level::Basico)
                .ok_or_else(|| format!("step `{step_id}` is not a challenge"))?;
            let assessment =
                tutor_eval::assess(&phase, &code).map_err(|e| format!("evaluation failed: {e}"))?;
            return Ok(assessment_dto(&assessment, &phase));
        }
    }
    Err(format!("step `{step_id}` not found"))
}

// ── Scaffolding commands (glossary + study guide) ────────────────────────────

/// Load the curated glossary for a language (e.g. `"rust"`). Each entry explains
/// a reserved word or core item: what it does, when to use it, and an example.
#[tauri::command]
fn get_glossary(language: String) -> Result<GlossaryDto, String> {
    let glossary = tutor_core::load_glossary(&language)
        .ok_or_else(|| format!("no glossary for language `{language}`"))?;
    Ok(GlossaryDto {
        entries: glossary
            .entries
            .into_iter()
            .map(|e| GlossaryEntryDto {
                keyword: e.keyword,
                summary: e.summary,
                when_to_use: e.when_to_use,
                example: e.example,
            })
            .collect(),
    })
}

/// Load the remediation study guide for a unit (e.g. `"u1-hello"`) in a language.
/// Shown to a struggling learner so they can re-read the unit's concepts calmly.
#[tauri::command]
fn get_study_guide(language: String, unit_id: String) -> Result<StudyGuideDto, String> {
    let guide = tutor_core::load_study_guide(&language, &unit_id).ok_or_else(|| {
        format!("no study guide for language `{language}` unit `{unit_id}`")
    })?;
    Ok(StudyGuideDto {
        title: guide.title,
        body: guide.body,
    })
}

// ── IDE/Workspace runner command ─────────────────────────────────────────────

/// Run a real file/project from the Explorer and return its captured output.
/// Reuses `RunDto { ok, stdout, stderr }`. Runner selection and the wall-clock
/// timeout + kill live in `fsops::run_file`.
#[tauri::command]
fn run_path(path: String) -> Result<RunDto, String> {
    let r = fsops::run_file(&path)?;
    Ok(RunDto {
        ok: r.ok,
        stdout: r.stdout,
        stderr: r.stderr,
    })
}

// ── Sandbox engine selection ──────────────────────────────────────────────────

/// Current sandbox engine as a short string: `"host" | "delonix" | "docker" |
/// "podman"`. Reflects the runtime override (set via `set_sandbox_engine`), else
/// the `DXTUTOR_SANDBOX_ENGINE` env var, else `"host"`.
#[tauri::command]
fn get_sandbox_engine() -> String {
    tutor_eval::engine_name(tutor_eval::current_engine()).to_string()
}

/// Switch the sandbox engine at runtime. Accepts `"delonix" | "docker" | "podman" |
/// "host"` (case-insensitive). Everything that executes student/user code
/// afterwards (drills, measured runs, traces, the Explorer runner) honors it.
#[tauri::command]
fn set_sandbox_engine(engine: String) -> Result<String, String> {
    let parsed = tutor_eval::parse_engine(&engine)
        .ok_or_else(|| format!("unknown engine `{engine}` (use host|delonix|docker|podman)"))?;
    tutor_eval::set_engine(parsed);
    Ok(tutor_eval::engine_name(parsed).to_string())
}

fn main() {
    // Default the desktop to running student/user code inside Delonix containers
    // (real isolation + package caches). The user can switch at runtime via
    // `set_sandbox_engine`. The env var still wins if it was set explicitly first:
    // only default to Delonix when nothing was requested through the environment.
    if std::env::var(tutor_eval::container::ENGINE_ENV).is_err() {
        tutor_eval::set_engine(tutor_eval::SandboxEngine::Delonix);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            list_phases,
            submit,
            request_hint,
            get_diagnostics,
            review_code,
            list_review_analyzers,
            verify_review_fix,
            study_policy,
            symbol_relations,
            assistant_models,
            assistant_chat,
            assistant_chat_stream,
            assistant_cancel,
            list_providers,
            get_providers_config,
            save_providers_config,
            request_plan,
            request_fix,
            get_course,
            list_courses,
            run_drill,
            run_measured,
            compile_pipeline,
            trace_execution,
            submit_step,
            get_glossary,
            get_study_guide,
            fsops::pick_folder,
            fsops::list_dir,
            fsops::read_text_file,
            fsops::write_text_file,
            fsops::create_path,
            fsops::delete_path,
            fsops::rename_path,
            run_path,
            get_sandbox_engine,
            set_sandbox_engine,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running dxtutor desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_gabarito() -> tutor_core::Gabarito {
        tutor_core::Gabarito {
            solution: "fn answer() -> u32 { 42 }".into(),
            time: "O(1)".into(),
            space: "O(1)".into(),
            justification: "constant work".into(),
        }
    }

    /// P0-1 regression: a FAILED attempt must never carry the reference solution.
    /// Serialize the DTO (the exact payload the webview receives) and assert the
    /// gabarito field is `null` and the solution text appears nowhere in the JSON.
    #[test]
    fn failed_attempt_hides_gabarito() {
        let g = sample_gabarito();
        assert!(reveal_gabarito(false, &g).is_none());

        let dto = AssessmentDto {
            correctness: CorrectnessDto {
                passed: false,
                summary: "1 test failed".into(),
                raw: "assertion failed".into(),
            },
            complexity: None,
            expected: None,
            gabarito: reveal_gabarito(false, &g),
        };
        let json = serde_json::to_string(&dto).expect("serialize");
        assert!(json.contains("\"gabarito\":null"), "gabarito must be null: {json}");
        assert!(
            !json.contains("fn answer") && !json.contains("constant work"),
            "failed payload leaked the solution/justification: {json}"
        );
    }

    /// A PASSED attempt unlocks the gabarito (the reward is real on success).
    #[test]
    fn passed_attempt_reveals_gabarito() {
        let g = sample_gabarito();
        let revealed = reveal_gabarito(true, &g).expect("passed → Some");
        assert_eq!(revealed.solution, "fn answer() -> u32 { 42 }");

        let dto = AssessmentDto {
            correctness: CorrectnessDto {
                passed: true,
                summary: "ok".into(),
                raw: String::new(),
            },
            complexity: None,
            expected: None,
            gabarito: reveal_gabarito(true, &g),
        };
        let json = serde_json::to_string(&dto).expect("serialize");
        assert!(json.contains("fn answer"), "passed payload should include the solution: {json}");
    }
}
