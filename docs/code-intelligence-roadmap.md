# dxtutor — Code Intelligence: grounded map & roadmap

Scope: add three integrated IDE capabilities — **offline Code Review**, a **navigable
CodeMap**, and **interruptible AI-assisted editing** — reusing the existing
architecture. This doc is the §1 investigation output: what exists (with real
references), what each host tool makes possible, reuse-vs-build, and a phased plan.

## 1. What exists today (grounded)

### Editor / buffers / edit lifecycle
- **Four Monaco editors**, one shared singleton (`desktop/src/monaco.ts`), one theme
  `dxtutor-dark`: learning `editor` (`main.ts:677`), workspace `wsEditor`
  (`workspace.ts:625`), debug `dbgEditor` (`debug.ts:92`), visualize `vizEditor`
  (`main.ts:2513`).
- Explorer opens a real file via `openFile` → `createModel(langForFile)` →
  `setActiveTab` (`workspace.ts:358-394`); one reusable model per tab.
- **Dirty is computed**: `model.getValue() !== tab.saved` (`workspace.ts:341`). Save
  = `cmdWriteFile` (blind `fs::write`, `fsops.rs:111`, no mtime/version).
- **Gaps**: zero `executeEdits`/`applyEdits`/`pushStackElement` (every write is
  whole-buffer `setValue`); no diff editor; no `getVersionId` usage; **no streaming
  transport** (all commands are single-shot `invoke`).
- **Reusable primitives**: view-zone "ghost cards" (`showDrillGhost`/`ghostNode`
  `main.ts:1426`), injected `after` decorations (`setDrillLineComments`), the Debug
  session state machine (Stop/Step-Back, `debug.ts:295-452`), and the
  "active buffer + language" seam (`currentDebugTarget` `main.ts:3168`,
  `workspaceActions.debugTarget` `workspace.ts:710`).

### Diagnostics
- `LanguageRunner::diagnostics` (`tutor-eval/src/lang.rs:83`) dispatched by
  `diagnostics_for` (`lang.rs:126`). Rust = `cargo check --message-format=json`
  (`runner.rs:467`, **not clippy**); Go = `go build` + `go vet` (`go_runner.rs:162`,
  **not gopls**); JS = QuickJS eval; C plugin = `cc -fsyntax-only`; **Python = none**
  (falls through to the Rust runner — useless).
- `Diagnostic` carries only `line/col/severity/message` (`lang.rs:61`) — **no
  rule-id, file, end-span, evidence, consequence, or verification**.
- UI: `get_diagnostics` (`main.rs:589`, **synchronous** → main-thread risk) →
  `DiagnosticDto` (+ offline `advise` suggestion) → `setModelMarkers` (`main.ts:2027`).
- **Per-snippet, Learning-mode only.** Explorer/workspace files get **no** diagnostics
  (`workspace.ts` never calls it). No file/changes/project scope. No document-version
  association (only a client-side `diagGen` staleness guard).
- `advisor.rs` = offline rule-based fix-hints (rustc/JS pattern → suggestion), used to
  fill `DiagnosticDto.suggestion` — **but the UI ignores it** (`main.ts:2012`). Ready
  "local evidence / verification hint" seam.
- **Reusable harness**: `run_guarded` + `configure_cargo_env` (process-group,
  `setrlimit`, wall-clock kill, `runner.rs:598-691`), Go host-env harness, and the
  `SandboxEngine` container abstraction (`container.rs`).

### AI / providers
- Entire AI layer = one file `tutor-llm/src/lib.rs`. Three **single-shot** traits
  (`HintProvider`/`PlanProvider`/`FixProvider`), blocking `ureq`, **no streaming, no
  cancel**. `ClaudeProvider` (Anthropic Messages, `claude-haiku-4-5`, `max_tokens:400`,
  `ANTHROPIC_API_KEY`) + `OfflineProvider`. Selector is **binary** (key or offline),
  no registry, no capability advertising.
- Frontend invokes only `request_hint` + `get_diagnostics`; `request_plan`/
  `request_fix` are registered but **never called** (latent hooks). No chat UI.
- Context sent = current buffer + static phase metadata only (no cross-file, no tests).
- **Streaming model to copy**: `pty.rs` (reader thread → `app.emit("pty://data")` →
  `listen` in `main.ts:3108`). Mirror as `llm://token`/`llm://done` + `cancel_llm`
  with a keyed in-flight request registry.

### CodeMap
- **Does not exist.** No go-to-def / references / call-graph / symbol index (the
  `saveCodeMap()` at `main.ts:367` is just localStorage of per-step text). Monaco's
  definition/reference providers are present but unwired. Only precedent: the `syn`
  AST parsing in `rust_tracer.rs` (for trace instrumentation).

## 2. Host analyzer & provider availability (this machine)

| Area | Live now | Absent |
|---|---|---|
| Rust | `cargo check`, **clippy**, **rust-analyzer** | — |
| Go | `go build`/`go vet` | `gopls`, `staticcheck` |
| Python | `python3`, **ruff 0.15** | `pyright`, `mypy` |
| AI | **Ollama / Qwen3** (local, no key) | `ANTHROPIC/OPENAI/GEMINI` keys, Copilot auth |

Consequences: offline review has a **live** path in all three languages; CodeMap
*resolved* relations are live for **Rust** (rust-analyzer) and *inferred-only* for Go
until gopls is installed; the only **live-validatable** AI provider is **Qwen3/Ollama**
(the rest are "simulated" until credentials exist) — this directly shapes the §7 matrix.

## 3. Reuse vs build

| Need | Reuse | Build |
|---|---|---|
| Review engine | `run_guarded`/env harness, cargo/go JSON parsers, container engine | rich `Finding` model, analyzer adapters (clippy/ruff/gopls), scope, async + version, availability/coverage report |
| Review panel | `DiagnosticDto`→marker path, `advise` suggestion seam | grouped-by-file panel, filters, related-locations nav, actions |
| CodeMap | `syn` precedent, process harness, Monaco provider hooks, workspace tabs | symbol/graph engine (rust-analyzer LSP resolved + tree-sitter inferred), graph model, viz, rename/move updates |
| AI providers | trait + `name()` provenance, `*Request`/`user_prompt` split | `Provider` trait w/ `capabilities()`, registry + config, OpenAI/Gemini/Ollama/Copilot adapters |
| Streaming/cancel | `pty.rs` event pattern | `llm://` events, `cancel_llm`, request registry, SSE reader |
| Assisted edit | view zones, decorations, Debug transport FSM, active-buffer seam | `executeEdits`+undo-stops, proposal/diff buffer, base-version guard, pause/take-over/continue, cross-file scope surfacing |

## 4. Phased plan (follows prompt §2→§7; each phase validated through the IDE)

- **P1 — Offline Code Review foundation (AI-independent).** New `Finding` model
  (origin, rule, file, range, severity, class = bug|risk|opportunity, evidence,
  consequence, verification). Review engine over **real project files** with scope
  (file / working changes / whole project), **off the UI thread** (`async` +
  `spawn_blocking`), result tied to a content hash/version. Adapters: Rust
  (cargo check + **clippy**), Go (**go vet**; gopls when present), Python (syntax +
  **ruff**). Detect availability; report which ran / failed / coverage. Works with the
  network and all models off.
- **P2 — Review panel (§3).** Grouped by file; filter by severity/category/origin;
  consolidate equivalent findings keeping sources; click → open + highlight exact
  range + related locations (incl. cross-file); actions *Ver no CodeMap / Pedir
  explicação / Pré-visualizar correcção / Voltar a analisar*; coverage+failures report;
  "por analisar" vs "sem ocorrências". Surface the ignored `advise` hint as
  verification.
- **P3 — CodeMap (§4).** Hybrid engine: **rust-analyzer / gopls** (resolved
  definition/references/callers/deps/tests) + **tree-sitter** (inferred fallback;
  mark resolved-vs-inferred; flag unresolved dynamic calls). Monaco def/ref providers +
  a CodeMap panel centered on a symbol with expandable relations; update on
  rename/move/delete. "Ver no CodeMap" links from the review.
- **P4 — AI as architect/assistant (§5).** Refactor `tutor-llm` into a `Provider`
  adapter layer with `capabilities()`; registry + `DXTUTOR_PROVIDER` config; adapters
  for Claude (exists), Codex/OpenAI, Gemini, Copilot, **Qwen3/Ollama** (confirm each
  real mechanism; mark simulated vs live). Streaming + cancel via `pty.rs`-style
  `llm://` events. Second opinion: send diagnostic + relevant code + CodeMap relations
  + tests; UI shows "what was sent" and separates local evidence from model opinion; a
  model answer never promotes a hypothesis to a confirmed bug.
- **P5 — Interruptible assisted editing (§6).** Chat with **Ask** vs **Edit-with-me**.
  Stream a proposal **into the editor** (proposal model + diff + view-zone cards);
  **Pause** stops incorporating (in-flight tokens never touch a paused proposal);
  **Take over** (edit by hand, keep prior accepted + unsaved work); **Continue from
  here** (re-read buffer, fold in the human change, continue); **Finish/Cancel**.
  Guard each apply on the base `getVersionId`; conflict → flag the span. Make cross-file
  scope expansion visible. No fake slow-replay of a finished answer.
- **P6 — Demonstration (§7).** The six scenarios + a per-language/-provider matrix
  tagged **live / simulated / unvalidated**, with time-to-first-diagnostic and
  time-to-first-block.

## 5. First slice (P1)
A new review engine (likely a `tutor-review` module/crate reusing `tutor-eval`'s
harness) + the `Finding` model + the **Rust adapter** (cargo check + clippy over a real
file) + availability detection, behind one async Tauri command, validated on this
repo's own Rust files before the panel and the other languages are added.

## 6. Honesty notes
- "Review every line" = locate evidence at the exact expression/line/range, including
  cross-file cause/effect; inline notes only when there is something concrete.
- Classify **demonstrated bug** vs **conditional risk** vs **optional improvement**; an
  `unwrap()` is only a bug if a reachable `None`/`Err` path exists.
- A delayed result must never paint over already-fixed code (version association).
- Provider availability affects only the actions that depend on it; the primary review
  and local navigation must work with AI off and the network down.

## 7. Trust contracts (P0) — done

The three confidence-affecting regressions from the audit are closed and guarded by named
regression tests. Each test fails on the pre-fix behaviour and passes with the fix.

| P0 | Fix | Named regression test | Revert to see it fail |
|----|-----|-----------------------|-----------------------|
| Solution leak in a failed assessment | `reveal_gabarito(passed, …)` gates the gabarito; failed → `gabarito: null` | `dxtutor-desktop` `tests::failed_attempt_hides_gabarito` | make `reveal_gabarito` always `Some` |
| Generic chat bypasses the study contract | `tutor-llm::policy` is the backend authority; study-mode chat is tutor-routed, mode fails closed | `tutor-llm` `policy::tests::study_mode_forbids_solution_and_buffer_writes` | make `policy_for(Study, …)` return `OPEN` |
| Stale fix hits other lines | `content_version` + `verify_fix`; frontend verifies identity before paint and apply | `tutor-eval` `review::tests::stale_buffer_without_snippet_relies_on_hash` (hash gate) and `stale_revision_fix_is_refused` (snippet gate) | remove the hash gate in `verify_fix` |

**Revert recipe (prove a regression):** commit first, then revert the single fix, run the
named test (it fails), restore with `git checkout`. An uncommitted change is discarded by
the checkout — always commit before a destructive proof.

## Harness

`scripts/verify.sh` is the reproducible verification entry — same command, no mutation of
the example project, no dependence on a prior run.

| Lane | Runs | Evidence |
|------|------|----------|
| `contracts` | the three P0 regression suites (tutor-eval, tutor-llm, dxtutor-desktop) | tests at the real serialization / apply boundaries |
| `editor` | `tsc --noEmit` + `vite build` | the concurrency/apply logic compiles |
| `workspace` | `cargo test --workspace` | all crate tests |
| `integration` (`--all`) | analyzer-backed e2e (clippy/go/ruff) | real diagnostics, or **not executed (missing tool)** |

A mandatory failure fails the process; an absent tool/credential is reported *not executed*,
never a silent pass. Distinguish **simulated** (offline/fake), **validated with a real
tool**, and **demonstrated through the IDE** when reporting.

## Still to validate (conditions)

- **P0-2 live**: exercise the Dev Assistant chat in study mode against a real provider
  (Ollama/Qwen3 first) — needs `npm run tauri dev` + a display + a pulled model.
- **P0-3 through the IDE**: drive review→insert→apply-refused live — needs a display.
- Per-language semantic navigation (rust-analyzer / gopls) and DAP debug: see §4 phases
  P2–P3; gopls and provider keys were absent on the audited host.
