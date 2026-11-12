// dxtutor desktop — frontend controller (guided learning mode).
//
// Wires the VSCode-style shell to the dxtutor "brain" (the tutor-* Rust crates)
// through Tauri commands. The product is a GUIDED TRACK: the student picks a
// language + level (profile), then the tutor walks them through units made of
// steps. For each "muscle-building" drill a target program is shown as a
// placeholder; the student REWRITES it; when it matches exactly it runs, the
// placeholder vanishes, and they earn points. Each unit ends with an APPLY
// challenge graded by the hidden tests.
//
// Honesty principle: correctness is decided by the hidden TESTS, never by AI;
// the measured complexity is an empirical ESTIMATE shown with its R²/confidence;
// the gabarito is the curated reference. Nothing here invents a verdict.
//
// Profile / points / progress live in the FRONTEND via localStorage — there is
// no backend for them. Keys: dxtutor.profile, dxtutor.points, dxtutor.done.

// Monaco is bootstrapped from a single module that loads only the editor core
// plus the Monarch highlighting for the languages we use (see ./monaco). This
// also installs MonacoEnvironment, so importing it first wires the workers.
import { monaco } from "./monaco";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { initWorkspace, activateWorkspace, workspaceActions, setCodeMapHandler, setEditHandler, setLocalizedEditHandler, setMethodEditHandler, setEntrypointHandler, createLaunchJson, activeFilePath, currentFileContent, langForFile, allBreakpoints, setBreakpointEnabled, removeBreakpoint, removeAllBreakpoints, setBreakpointsChangeHandler, openFileAt, setExplainFolderHandler } from "./workspace";
import { initReview, openReview } from "./review";
import { initCodeMap, openCodeMap } from "./codemap";
import { initTests, openTests } from "./tests";
import { initSearch, openSearch } from "./search";
import { initQuickOpen } from "./quickopen";
import { initGit, openGit, refreshGitBranch } from "./git";
import { initRemote, openRemote, setSessionChangeHandler } from "./remote";
import { initExplain, explainFile, explainFolder } from "./explain";
import { initArch, openArch } from "./arch";
import { workspaceRoot, showTestOutput } from "./workspace";
import { initAssistant, openAssistant, startLocalizedEdit, startMethodEdit, addEntrypoint, setSettingsHandler, activeModelLabel, setPlanCompleteHandler } from "./assistant";
import { initEdit, startEdit } from "./edit";
import { initDebug, openDebug, type DebugTarget } from "./debug";
import { t, initI18n, getLocale, setLocale, onLocaleChange, type Locale } from "./i18n";

// ── Types mirroring the Tauri command payloads (the fixed contract) ──────────

type StepKind = "concept" | "drill" | "challenge";

interface StepDto {
  kind: StepKind;
  id: string;
  title: string;
  points: number;
  body: string; // concept prose (markdown)
  prompt: string; // short instruction shown above the work area
  target: string; // drill target program the student must reproduce
  explanation: string; // revealed after a drill runs
  instructions: string; // challenge brief (markdown)
  entry: string; // function the challenge must implement
  starter: string; // starter code loaded into the editor
  intro: string; // briefing (markdown) shown BEFORE the exercise ("nothing without a clear intro")
  difficulty?: number; // optional 1..5 difficulty; marked in the sidebar if present
  // Per-line explanations for a drill target, index-aligned with `target` lines:
  // as each line becomes correct we surface lineComments[i] as a dim ghost comment.
  lineComments?: string[];
  // How the drill target / briefing scaffolding is shown. "shown" (basic) reveals
  // it as today; "onDemand" (advanced) keeps it hidden behind a Show/Hide toggle.
  placeholderPolicy?: "shown" | "onDemand";
  // Package-manager teaching aids. When an exercise relies on a third-party
  // package, the backend ships the exact CLI it would take to install it (e.g.
  // ["go get github.com/google/uuid"]) and how to run the program (e.g. "go run .").
  // The briefing surfaces these so the student learns the language's official
  // package manager — the sandbox still does the real setup behind the scenes.
  installCommands?: string[];
  runCommand?: string;
  // Extra Cargo [dependencies] lines this step needs (Rust). Sent to run_drill so
  // the scaffolded crate compiles (e.g. rusqlite for the database track). Empty
  // for std-only steps; Go resolves its imports via `go mod tidy` instead.
  dependencies?: string[];
}
interface UnitDto {
  id: string;
  title: string;
  intro: string;
  steps: StepDto[];
  difficulty?: number; // optional unit-level difficulty
  // Curriculum level this unit belongs to. Added by the backend; may be absent
  // on older payloads, in which case the unit is treated as always-visible.
  level?: string; // "basic" | "intermediate" | "advanced"
}
interface CourseDto {
  id: string;
  title: string;
  language: string;
  level: string;
  summary: string;
  units: UnitDto[];
}
// Lightweight catalogue entry returned by the `list_courses` backend command —
// one per embedded curriculum. The onboarding picker is built from these, so a
// new embedded course surfaces as a language card with no frontend change.
interface CourseSummaryDto {
  id: string;
  language: string;
  title: string;
  level: string;
  summary: string;
}
interface RunDto {
  ok: boolean;
  stdout: string;
  stderr: string;
}
interface CorrectnessDto {
  passed: boolean;
  summary: string;
  raw: string;
}
interface ComplexityDto {
  bigO: string;
  rSquared: number;
  exponent: number;
  confidence: string; // "low" | "medium" | "high"
  ranking: [string, number][];
}
interface GabaritoDto {
  solution: string;
  time: string;
  space: string;
  justification: string;
}
interface AssessmentDto {
  correctness: CorrectnessDto;
  complexity: ComplexityDto | null;
  expected: string | null;
  // Present ONLY after the tests pass — the backend sends null on a failed attempt so
  // the solution can never leak into the webview (P0 honesty contract).
  gabarito: GabaritoDto | null;
}
interface HintDto {
  text: string;
  provider: string;
  level: number;
}
interface DiagnosticDto {
  line: number;
  col: number;
  severity: string; // "error" | "warning"
  message: string;
  suggestion: string | null;
}

// Pedagogical scaffolding contract (new commands).
interface GlossaryEntryDto {
  keyword: string;
  summary: string;
  whenToUse: string;
  example: string;
}
interface GlossaryDto {
  entries: GlossaryEntryDto[];
}
interface StudyGuideDto {
  title: string;
  body: string; // markdown
}

// "Visualize execution" contract — a REAL step-by-step trace produced by the
// backend running Python under sys.settrace. Nothing here is simulated: each
// step is one event emitted by the real interpreter.
interface VarDto {
  name: string;
  value: string;
  ty: string;
}
interface TraceStepDto {
  line: number;
  event: string; // "line" | "call" | "return"
  func: string;
  depth: number;
  locals: VarDto[];
  stdoutLen: number;
}
interface ExecutionTraceDto {
  supported: boolean;
  notes: string;
  steps: TraceStepDto[];
  stdout: string;
}

// "Under the hood" contract — REAL, measured resources + the compiler pipeline.
// Nothing here is simulated: the telemetry comes from actually running the code,
// the pipeline text from actually invoking the compiler.
// One memory sample taken while the program ran: `tMs` is the elapsed time from
// the start of the measured run, `rssKb` the resident set at that instant. The
// series is REAL (sampled during execution) and may be empty on fast programs.
interface MemSampleDto {
  tMs: number;
  rssKb: number;
}
interface TelemetryDto {
  wallMs: number;
  cpuUserMs: number;
  cpuSysMs: number;
  peakRssKb: number;
  ioReadBlocks: number;
  ioWriteBlocks: number;
  exitCode: number;
  samples: MemSampleDto[]; // memory-over-time series (may be empty)
}
interface MeasuredRunDto {
  run: RunDto;
  telemetry: TelemetryDto;
}
interface PipelineDto {
  mir: string;
  llvmIr: string;
  asm: string;
  binaryBytes: number;
  disasm: string;
  notes: string;
}

interface Profile {
  language: string;
  // The curriculum levels the student opted into (one or more). The track only
  // loads units whose level is in this list. Lower-case ids: "basic" |
  // "intermediate" | "advanced".
  levels: string[];
  // Legacy single-level field kept for migration of pre-multi-select profiles.
  level?: string;
}

// ── App state ────────────────────────────────────────────────────────────────

const hasTauri = "__TAURI_INTERNALS__" in window;

let editor: monaco.editor.IStandaloneCodeEditor;
let course: CourseDto | null = null;
let profile: Profile | null = null;
let activeStepId: string | null = null;

let points = 0;
const done = new Set<string>(); // completed step ids

// ── Pedagogical scaffolding state ────────────────────────────────────────────
const briefed = new Set<string>(); // steps whose briefing was acknowledged this session
let pendingStart: (() => void) | null = null; // the "Start" callback waiting behind a briefing gate
let glossary: GlossaryEntryDto[] = [];
const glossaryMap = new Map<string, GlossaryEntryDto>(); // keyword → entry, for the hover popover
type Stat = { attempts: number; passes: number };
let stats: Record<string, Stat> = {}; // per-step accuracy, persisted in localStorage
const studyOffered = new Set<string>(); // unit ids already invited to the study guide this session
const MIN_ATTEMPTS_FOR_GUIDE = 4; // don't nudge before the student has really tried
const STUDY_RATE_THRESHOLD = 0.25; // offer the study guide below 25% unit accuracy

// ── Under-the-hood state ─────────────────────────────────────────────────────
// Honour the OS "reduce motion" setting: all gauge/bar animations degrade to an
// instant final value when the user has asked for less motion.
const reduceMotion =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type PhaseKey = "source" | "mir" | "llvm" | "asm" | "machine";
interface PipelinePhase {
  key: PhaseKey;
  label: string;
  blurb: string;
}
// The honest story of how source becomes bytes the CPU runs.
const UH_PHASES: PipelinePhase[] = [
  { key: "source", label: "Source", blurb: "Source — the Rust you wrote, before the compiler touches it." },
  { key: "mir", label: "MIR", blurb: "MIR — Rust's mid-level IR, produced after borrow-checking." },
  { key: "llvm", label: "LLVM IR", blurb: "LLVM IR — the portable IR that LLVM optimizes." },
  { key: "asm", label: "Assembly", blurb: "Assembly — CPU instructions for this target." },
  { key: "machine", label: "Machine code", blurb: "Machine code — the final bytes the CPU runs." },
];
let uhPipeline: PipelineDto | null = null; // last compile_pipeline result
let uhSource = ""; // source measured in the last run (shown as the "Source" phase)

// ── Visualize-execution (step-by-step tracer) state ──────────────────────────
// A small Python program shipped by default so the student has something to run
// the moment they open the visualizer: a function, a loop and a few variables.
const VIZ_DEFAULT_CODE = `def sum_list(numbers):
    total = 0
    for n in numbers:
        total = total + n
    return total


values = [4, 8, 15, 16, 23]
result = sum_list(values)
print("sum =", result)
`;
// The Rust counterpart, shipped by default when the course language is Rust: a
// function, a loop and a few variables — enough for a meaningful step-by-step run.
const VIZ_DEFAULT_RUST = `fn sum_list(numbers: &[i64]) -> i64 {
    let mut total = 0;
    for n in numbers {
        total = total + n;
    }
    total
}

fn main() {
    let values = [4, 8, 15, 16, 23];
    let result = sum_list(&values);
    println!("sum = {}", result);
}
`;
let vizEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let vizSteps: TraceStepDto[] = [];
let vizStdout = ""; // full program stdout; each step shows a slice of it
let vizFrames: string[][] = []; // reconstructed call stack per step (names, inner-last)
let vizIdx = 0; // current step index
let vizPlaying = false;
let vizTimer: number | undefined; // auto-play interval
let vizDecorations: monaco.editor.IEditorDecorationsCollection | null = null;
let vizPrevVars = new Map<string, string>(); // name → value at the previously rendered step

// Per-step editor state so switching "files" preserves what the student typed.
const models = new Map<string, monaco.editor.ITextModel>();
const hintLevel = new Map<string, number>(); // next hint level, 1..3
const lastTestOutput = new Map<string, string>(); // failing output, fed to hints

// Tutor overlays — Monaco view zones + markers — rebuilt per step.
let drillZoneIds: string[] = []; // the dim "type this" ghost in the editor
let diagTimer: number | undefined; // debounce for live challenge diagnostics
let diagGen = 0; // generation guard: drop stale async results

// Auto line-comments: as each drill line becomes correct we surface its matching
// lineComments[i] as a dim ghost comment to the right of that editor line.
let drillCommentDecorations: monaco.editor.IEditorDecorationsCollection | null = null;
// Placeholder (onDemand) policy: which drills have their target revealed this session.
const placeholderRevealed = new Set<string>();

// ── localStorage (profile / points / progress live only here) ────────────────

const LS = {
  profile: "dxtutor.profile",
  points: "dxtutor.points",
  done: "dxtutor.done",
  stats: "dxtutor.stats",
  code: "dxtutor.code",
  openUnits: "dxtutor.openUnits", // per-unit sidebar open/closed state (collapsible tree)
  sandbox: "dxtutor.sandbox", // which engine runs student code: delonix|docker|podman|host
} as const;

// Sidebar collapse state: unit.id → open?. A unit WITHOUT an entry here uses the
// smart default (open only the unit holding the current step). An explicit entry
// (set when the student clicks a unit header) always wins and persists.
let openUnits: Record<string, boolean> = loadOpenUnits();

function loadOpenUnits(): Record<string, boolean> {
  try {
    const o = JSON.parse(localStorage.getItem(LS.openUnits) ?? "{}") as Record<string, boolean>;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
function saveOpenUnits() {
  localStorage.setItem(LS.openUnits, JSON.stringify(openUnits));
}

// Per-step editor text, persisted so NOTHING the student typed is lost on a
// restart. Keyed by step id. Restored into each step's Monaco model on open.
let codeByStep: Record<string, string> = {};
let codeSaveTimer: number | undefined;

function loadCode(): Record<string, string> {
  try {
    const o = JSON.parse(localStorage.getItem(LS.code) ?? "{}") as Record<string, string>;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
function saveCodeMap() {
  localStorage.setItem(LS.code, JSON.stringify(codeByStep));
}
// Flush the ACTIVE step's current editor text into the persisted map (immediate).
function persistActiveCode() {
  if (!activeStepId || !editor) return;
  const m = editor.getModel();
  if (!m) return;
  codeByStep[activeStepId] = m.getValue();
  saveCodeMap();
}
// Debounced save on every keystroke so a crash/close never loses work.
function scheduleCodeSave() {
  window.clearTimeout(codeSaveTimer);
  codeSaveTimer = window.setTimeout(persistActiveCode, 400);
}

// Canonical curriculum levels, in track order.
const LEVEL_IDS = ["basic", "intermediate", "advanced"] as const;
// Level labels/blurbs are resolved live from the active locale so a language
// switch re-labels the onboarding and status bar without a reload.
function levelLabel(id: string): string {
  return t(`level.${id}`);
}
function levelBlurb(id: string): string {
  return t(`level.${id}.blurb`);
}

// Fold any historical label into a canonical level id. Old profiles stored a
// single capitalised label ("Beginner" | "Intermediate" | "Advanced"); map
// "beginner" → "basic" and keep the others.
function normalizeLevel(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (s === "beginner" || s === "basic") return "basic";
  if (s === "intermediate") return "intermediate";
  if (s === "advanced") return "advanced";
  return null;
}

// Resolve a saved payload into a valid, non-empty `levels` array. Missing/invalid
// data falls back to all levels so an existing student is never locked out.
function migrateLevels(p: { levels?: unknown; level?: unknown }): string[] {
  const out: string[] = [];
  if (Array.isArray(p.levels)) {
    for (const v of p.levels) {
      if (typeof v === "string") {
        const n = normalizeLevel(v);
        if (n && !out.includes(n)) out.push(n);
      }
    }
  } else if (typeof p.level === "string") {
    const n = normalizeLevel(p.level);
    if (n) out.push(n);
  }
  if (!out.length) return [...LEVEL_IDS];
  // Keep canonical track order regardless of saved order.
  return LEVEL_IDS.filter((id) => out.includes(id));
}

function loadProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(LS.profile);
    if (!raw) return null;
    const p = JSON.parse(raw) as Profile;
    if (!p || typeof p.language !== "string") return null;
    return { language: p.language, levels: migrateLevels(p) };
  } catch {
    return null;
  }
}
function saveProfile(p: Profile) {
  localStorage.setItem(LS.profile, JSON.stringify(p));
}
function loadPoints(): number {
  const n = Number(localStorage.getItem(LS.points));
  return Number.isFinite(n) ? n : 0;
}
function savePoints(n: number) {
  localStorage.setItem(LS.points, String(n));
}
function loadDone(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(LS.done) ?? "[]") as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function saveDone() {
  localStorage.setItem(LS.done, JSON.stringify([...done]));
}
function loadStats(): Record<string, Stat> {
  try {
    const o = JSON.parse(localStorage.getItem(LS.stats) ?? "{}") as Record<string, Stat>;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
function saveStats() {
  localStorage.setItem(LS.stats, JSON.stringify(stats));
}

// Record one attempt on a step (drill run or challenge submit) and its outcome.
// Accuracy per UNIT drives the study-guide remediation nudge.
function recordAttempt(step: StepDto, passed: boolean) {
  const s = stats[step.id] ?? { attempts: 0, passes: 0 };
  s.attempts += 1;
  if (passed) s.passes += 1;
  stats[step.id] = s;
  saveStats();
  if (!passed) maybeOfferStudyGuide(step);
}

function unitAccuracy(unit: UnitDto): { attempts: number; passes: number; rate: number } {
  let attempts = 0;
  let passes = 0;
  for (const st of unit.steps) {
    const s = stats[st.id];
    if (s) {
      attempts += s.attempts;
      passes += s.passes;
    }
  }
  return { attempts, passes, rate: attempts ? passes / attempts : 1 };
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Minimal, safe Markdown → HTML for prose/justification. Intentionally tiny:
// headings, inline code, fenced code, bold, lists, paragraphs.
function renderMarkdown(md: string): string {
  const lines = (md ?? "").replace(/\r/g, "").split("\n");
  let html = "";
  let inCode = false;
  let inList = false;
  let codeLang = ""; // language tag after the opening ``` fence
  let codeBuf: string[] = []; // raw code lines, highlighted after render
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      html += `<p>${inline(para.join(" "))}</p>`;
      para = [];
    }
  };
  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        // Emit a highlightable block: the raw code sits in textContent and the
        // post-render pass (`highlightMarkdownCode`) colourises it with Monaco.
        html += `<pre class="md-code" data-lang="${esc(codeLang)}">${esc(
          codeBuf.join("\n"),
        )}</pre>`;
        inCode = false;
        codeBuf = [];
        codeLang = "";
      } else {
        flushPara();
        closeList();
        inCode = true;
        codeLang = line.trim().slice(3).trim().toLowerCase(); // tag after ```
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flushPara();
      closeList();
      const level = line.match(/^#+/)![0].length;
      const tag = level <= 2 ? "h2" : "h3";
      html += `<${tag}>${inline(line.replace(/^#+\s/, ""))}</${tag}>`;
    } else if (/^\s*[-*]\s/.test(line)) {
      flushPara();
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(line.replace(/^\s*[-*]\s/, ""))}</li>`;
    } else if (line.trim() === "") {
      flushPara();
      closeList();
    } else {
      para.push(line);
    }
  }
  flushPara();
  closeList();
  if (inCode)
    html += `<pre class="md-code" data-lang="${esc(codeLang)}">${esc(
      codeBuf.join("\n"),
    )}</pre>`;
  return html;
}

// Map a fenced-code language tag (```rust) to a registered Monaco language id.
function mdCodeLangId(tag: string): string {
  const m: Record<string, string> = {
    rs: "rust",
    rust: "rust",
    go: "go",
    golang: "go",
    py: "python",
    python: "python",
    js: "javascript",
    javascript: "javascript",
    ts: "typescript",
    typescript: "typescript",
    c: "c",
    cpp: "cpp",
    "c++": "cpp",
    sh: "shell",
    bash: "shell",
    console: "shell",
    sql: "sql",
    toml: "ini",
    ini: "ini",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    html: "html",
    css: "css",
  };
  return m[tag] ?? tag;
}

// Colourise every not-yet-processed Markdown code block with Monaco's tokenizer
// (already bundled). `colorizeElement` reads the element text + `data-lang` and
// rewrites it in place — async, so failures degrade to plain text.
function highlightMarkdownCode(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("pre.md-code:not([data-hl])").forEach((el) => {
    el.dataset.hl = "1";
    const lang = mdCodeLangId((el.dataset.lang || "").trim());
    if (!lang || !(el.textContent || "").trim()) return;
    el.setAttribute("data-lang", lang); // colorizeElement keys off this
    monaco.editor
      .colorizeElement(el, { theme: "dxtutor-dark", mimeType: lang, tabSize: 4 })
      .then(() => el.classList.add("hl"))
      .catch(() => {
        /* leave the (already-escaped) plain text in place */
      });
  });
}

// One observer colourises blocks from EVERY render site (concept body, intro,
// gabarito, hints, glossary, study guide…) without each call remembering to.
let mdHlQueued = false;
const mdHlObserver = new MutationObserver(() => {
  if (mdHlQueued) return;
  mdHlQueued = true;
  requestAnimationFrame(() => {
    mdHlQueued = false;
    highlightMarkdownCode(document.body);
  });
});
mdHlObserver.observe(document.body, { childList: true, subtree: true });

// ── Monaco ────────────────────────────────────────────────────────────────────

// Suggestion/autocomplete options: OFF for drills (the student must type every
// character to build the muscle), ON for challenges.
type EditorOpts = monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions;

const SUGGEST_OFF: EditorOpts = {
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  wordBasedSuggestions: "off",
  parameterHints: { enabled: false },
  acceptSuggestionOnEnter: "off",
  tabCompletion: "off",
  hover: { enabled: false },
};
const SUGGEST_ON: EditorOpts = {
  quickSuggestions: true,
  suggestOnTriggerCharacters: true,
  wordBasedSuggestions: "currentDocument",
  parameterHints: { enabled: true },
  acceptSuggestionOnEnter: "on",
  tabCompletion: "on",
  hover: { enabled: true },
};

function setupEditor() {
  monaco.editor.defineTheme("dxtutor-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: { "editor.background": "#1e1e1e" },
  });

  editor = monaco.editor.create($("#editor"), {
    value: "",
    language: "rust",
    theme: "dxtutor-dark",
    automaticLayout: true,
    fontFamily: '"Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
    fontSize: 13,
    minimap: { enabled: false },
    stickyScroll: { enabled: false },
    scrollBeyondLastLine: false,
    padding: { top: 10 },
    tabSize: 4,
    renderWhitespace: "selection",
  });

  // Ctrl+Enter → the primary action for the active step (Run/Submit, Continue
  // or Next, whichever is live).
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
    primaryAction(),
  );
  // F1 → Hint (only meaningful on challenges).
  editor.addCommand(monaco.KeyCode.F1, () => void requestHint());

  // Glossary popover: hovering a reserved word shows its entry. Monaco only
  // surfaces hovers where the editor's `hover` option is enabled — that is the
  // concept/challenge editors, never the drill (its no-autocomplete purity is
  // preserved; the student can still open the 📖 Glossary panel any time).
  // Registered for every language we can host so the glossary popover follows the
  // active course (the model's language id drives which provider fires).
  const hoverProvider: monaco.languages.HoverProvider = {
    provideHover(model, position) {
      if (!editor || model !== editor.getModel()) return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const entry = glossaryMap.get(word.word);
      if (!entry) return null;
      const contents: monaco.IMarkdownString[] = [
        { value: `**\`${entry.keyword}\`** — ${entry.summary}` },
      ];
      if (entry.whenToUse) contents.push({ value: `*When to use:* ${entry.whenToUse}` });
      if (entry.example)
        contents.push({ value: "```" + langMeta().monaco + "\n" + entry.example + "\n```" });
      return {
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        ),
        contents,
      };
    },
  };
  for (const meta of Object.values(LANG_META))
    monaco.languages.registerHoverProvider(meta.monaco, hoverProvider);

  // Live reactions depend on the active step kind.
  editor.onDidChangeModelContent(() => {
    const step = currentStep();
    if (!step) return;
    scheduleCodeSave(); // persist the student's text (debounced) — nothing is lost
    if (step.kind === "drill") {
      updateDrillProgress(step);
    } else if (step.kind === "challenge") {
      window.clearTimeout(diagTimer);
      diagTimer = window.setTimeout(() => void refreshDiagnostics(step), 1000);
    }
  });
}

function modelFor(step: StepDto): monaco.editor.ITextModel {
  let m = models.get(step.id);
  if (!m) {
    // Restore the student's own text if we have it; otherwise fall back to the
    // starter (same default as before persistence existed).
    const saved = codeByStep[step.id];
    const initial = typeof saved === "string" ? saved : step.starter ?? "";
    m = monaco.editor.createModel(initial, langMeta().monaco);
    models.set(step.id, m);
  }
  return m;
}

// ── Track ordering / gating ──────────────────────────────────────────────────

function allSteps(): { step: StepDto; unit: UnitDto }[] {
  if (!course) return [];
  const out: { step: StepDto; unit: UnitDto }[] = [];
  for (const unit of course.units) for (const step of unit.steps) out.push({ step, unit });
  return out;
}

// ── Level filtering ──────────────────────────────────────────────────────────
// The track only shows units whose level the student opted into. Everything the
// student sees — gating, "current step", track-complete — is computed over these
// VISIBLE steps, never the hidden ones. Points are global and unaffected.

function selectedLevels(): Set<string> {
  const lv = profile?.levels;
  if (lv && lv.length) return new Set(lv);
  return new Set(LEVEL_IDS);
}

// A unit's canonical level, or null when the payload carries none.
function unitLevel(unit: UnitDto): string | null {
  return typeof unit.level === "string" ? normalizeLevel(unit.level) : null;
}

// Does the loaded course actually carry per-unit levels? When it does we filter
// and group by level; when it doesn't (older backend) we keep the flat track.
function courseHasLevels(): boolean {
  return !!course && course.units.some((u) => unitLevel(u) !== null);
}

// Units without a level are always visible (back-compat); levelled ones show
// only when their level is selected.
function isUnitVisible(unit: UnitDto): boolean {
  const lv = unitLevel(unit);
  return lv === null || selectedLevels().has(lv);
}

function visibleUnits(): UnitDto[] {
  return course ? course.units.filter(isUnitVisible) : [];
}

function visibleSteps(): { step: StepDto; unit: UnitDto }[] {
  const out: { step: StepDto; unit: UnitDto }[] = [];
  for (const unit of visibleUnits()) for (const step of unit.steps) out.push({ step, unit });
  return out;
}

// The current step is the first visible one not yet completed (or the last
// visible step if all are done).
function currentStepId(): string | null {
  const flat = visibleSteps();
  if (!flat.length) return null;
  for (const { step } of flat) if (!done.has(step.id)) return step.id;
  return flat[flat.length - 1].step.id;
}

// Gating: you can only open the current step or ones you've already completed —
// no jumping ahead.
function isUnlocked(stepId: string): boolean {
  return done.has(stepId) || stepId === currentStepId();
}

function stepById(id: string | null): StepDto | null {
  if (!id) return null;
  return allSteps().find((s) => s.step.id === id)?.step ?? null;
}
function unitOf(stepId: string): UnitDto | null {
  return allSteps().find((s) => s.step.id === stepId)?.unit ?? null;
}
function currentStep(): StepDto | null {
  return stepById(activeStepId);
}

// ── Sidebar (units + steps + state) ──────────────────────────────────────────

function kindTag(kind: StepKind): string {
  return kind === "concept" ? "Learn" : kind === "drill" ? "Drill" : "Apply";
}

// Challenge rating as STARS (★ filled, ☆ empty), out of 5. The stars express how
// tough the exercise is — NOT the points. Concept steps are reading, not a
// challenge, so they carry no stars (a 0-star item has no challenge for this
// level — the natural hook for AI to propose a harder variant). The content's
// absolute difficulty scale (≈1..26 across a course) is bucketed into 1..5.
function diffStars(d: unknown, kind?: string): string {
  if (kind === "concept") return "";
  const v = typeof d === "number" && isFinite(d) ? d : 0;
  if (v <= 0) return "";
  const n = v <= 3 ? 1 : v <= 7 ? 2 : v <= 12 ? 3 : v <= 18 ? 4 : 5;
  const stars = "&#9733;".repeat(n) + "&#9734;".repeat(5 - n);
  return `<span class="step-diff" title="Challenge ${n}/5 — more stars, tougher problem">${stars}</span>`;
}

// Is a unit's section expanded? An explicit (persisted) choice wins; otherwise
// the smart default opens only the unit that holds the current step — so the
// track reads like a VSCode Explorer with just the active folder unfolded.
function isUnitOpen(unit: UnitDto, curId: string | null): boolean {
  if (Object.prototype.hasOwnProperty.call(openUnits, unit.id)) return openUnits[unit.id];
  return unit.steps.some((s) => s.id === curId);
}

// Build the collapsible <li> for one unit (header + its gated steps).
function buildUnitGroup(unit: UnitDto, curId: string | null): HTMLLIElement {
  const unitDone = unit.steps.every((s) => done.has(s.id));
  const doneCount = unit.steps.filter((s) => done.has(s.id)).length;
  const open = isUnitOpen(unit, curId);

  const group = document.createElement("li");
  group.className = "unit-group" + (unitDone ? " done" : "") + (open ? "" : " collapsed");
  group.dataset.unit = unit.id;

  const header = document.createElement("div");
  header.className = "unit-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", String(open));
  header.innerHTML = `<span class="unit-caret">&#9662;</span>
    <span class="unit-title">${esc(unit.title)}</span>
    ${diffStars(unit.difficulty)}
    <span class="unit-meta">${
      unitDone
        ? '<span class="unit-check">&#10004;</span>'
        : `${doneCount}/${unit.steps.length}`
    }</span>`;
  header.title = unit.title;
  const toggle = () => toggleUnit(unit, curId);
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  group.appendChild(header);

  // The steps live in an overflow-clipped inner wrapper so the grid-rows
  // 1fr↔0fr transition animates the open/close without a jump.
  const steps = document.createElement("div");
  steps.className = "unit-steps";
  const inner = document.createElement("div");
  inner.className = "unit-steps-inner";

  for (const step of unit.steps) {
    const isDone = done.has(step.id);
    const isCurrent = step.id === curId && !isDone;
    const locked = !isUnlocked(step.id);
    const row = document.createElement("div");
    row.className =
      "step-item" +
      (isDone ? " done" : "") +
      (isCurrent ? " current" : "") +
      (locked ? " locked" : "") +
      (step.id === activeStepId ? " active" : "");
    row.dataset.id = step.id;
    const glyph = isDone ? "&#10004;" : locked ? "&#128274;" : "&#9654;";
    row.innerHTML = `<span class="step-glyph">${glyph}</span>
      <span class="step-label">${esc(step.title)}</span>
      ${diffStars(step.difficulty, step.kind)}
      <span class="step-kind ${step.kind}">${kindTag(step.kind)}</span>
      <span class="step-pts" title="Points earned on completion">+${step.points}</span>`;
    row.title = locked ? "Complete the current step first" : step.title;
    if (!locked) row.addEventListener("click", () => openStep(step));
    inner.appendChild(row);
  }
  steps.appendChild(inner);
  group.appendChild(steps);
  return group;
}

function renderSidebar() {
  if (!course) return;
  $("#project-title").textContent = course.title;
  $("#title-project").textContent = `${course.title} — Delonix Tutor`;
  $("#btn-reset-profile").classList.remove("hidden");

  const curId = currentStepId();
  const list = $("#track-list");
  list.innerHTML = "";

  const units = visibleUnits();

  if (!courseHasLevels()) {
    // Older payload with no per-unit level: keep the flat track as before.
    for (const unit of units) list.appendChild(buildUnitGroup(unit, curId));
    updateStatusBar();
    return;
  }

  // Levelled payload: organise the track into "BASIC / INTERMEDIATE / ADVANCED"
  // sections (only the selected levels that actually have visible units).
  const chosen = selectedLevels();

  // Units that carry no level still show, bucketed ahead of the sections.
  const unlevelled = units.filter((u) => unitLevel(u) === null);
  for (const unit of unlevelled) list.appendChild(buildUnitGroup(unit, curId));

  for (const levelId of LEVEL_IDS) {
    if (!chosen.has(levelId)) continue;
    const inLevel = units.filter((u) => unitLevel(u) === levelId);
    if (!inLevel.length) continue;

    const head = document.createElement("li");
    head.className = "track-level-head";
    head.dataset.level = levelId;
    head.textContent = levelLabel(levelId).toUpperCase();
    list.appendChild(head);

    for (const unit of inLevel) list.appendChild(buildUnitGroup(unit, curId));
  }
  updateStatusBar();
}

// Ensure the section holding a step is expanded (used when a step becomes active).
function ensureUnitExpandedFor(stepId: string) {
  const unit = unitOf(stepId);
  if (!unit) return;
  if (openUnits[unit.id] === true) return;
  openUnits[unit.id] = true;
  saveOpenUnits();
  const group = document.querySelector<HTMLElement>(
    `.unit-group[data-unit="${CSS.escape(unit.id)}"]`,
  );
  if (group) {
    group.classList.remove("collapsed");
    group.querySelector(".unit-header")?.setAttribute("aria-expanded", "true");
  }
}

// Flip a unit's section open/closed (persisted). We animate in place rather than
// re-rendering the whole list, so there is no flash and no scroll jump.
function toggleUnit(unit: UnitDto, curId: string | null) {
  const next = !isUnitOpen(unit, curId);
  openUnits[unit.id] = next;
  saveOpenUnits();
  const group = document.querySelector<HTMLElement>(
    `.unit-group[data-unit="${CSS.escape(unit.id)}"]`,
  );
  if (group) {
    group.classList.toggle("collapsed", !next);
    group.querySelector(".unit-header")?.setAttribute("aria-expanded", String(next));
  }
}

// ── Sandbox engine (where student code runs) ─────────────────────────────────
// The backend executes every Run/Submit inside a sandbox. Default is a Delonix
// container (the engine that powers Delonix); the student may switch to
// Docker/Podman, or run directly on the Host (fastest, least isolated). The
// choice is persisted here and pushed to the backend via `setSandboxEngine`.

type SandboxEngine = "delonix" | "docker" | "podman" | "host";

const SANDBOX_ENGINES: readonly SandboxEngine[] = ["delonix", "docker", "podman", "host"] as const;
const SANDBOX_DEFAULT: SandboxEngine = "delonix";

// Status-bar label / tooltip per engine, resolved live from the active locale
// (⬡ marks a container engine; ⌂ marks the Host).
function sandboxLabel(engine: SandboxEngine): string {
  return t(`sandbox.label.${engine}`);
}
function sandboxTip(engine: SandboxEngine): string {
  return t(`sandbox.tip.${engine}`);
}

let sandboxEngine: SandboxEngine = loadSandbox();

function isSandboxEngine(v: unknown): v is SandboxEngine {
  return typeof v === "string" && (SANDBOX_ENGINES as readonly string[]).includes(v);
}

function loadSandbox(): SandboxEngine {
  const v = localStorage.getItem(LS.sandbox);
  return isSandboxEngine(v) ? v : SANDBOX_DEFAULT;
}

function saveSandbox(engine: SandboxEngine) {
  localStorage.setItem(LS.sandbox, engine);
}

// Push the chosen engine to the backend and refresh the UI. Persists unless
// `persist` is false (used at startup, where the value is already stored).
async function applySandbox(engine: SandboxEngine, opts: { persist?: boolean } = {}) {
  sandboxEngine = engine;
  if (opts.persist !== false) saveSandbox(engine);
  updateSandboxIndicator();
  syncSandboxRadios();
  if (hasTauri) {
    try {
      await invoke("set_sandbox_engine", { engine });
    } catch (e) {
      console.error("setSandboxEngine failed:", e);
    }
  }
}

function updateSandboxIndicator() {
  const el = document.getElementById("status-sandbox");
  if (!el) return;
  if (!hasTauri) {
    // No backend to run code — be honest instead of implying a live container.
    el.textContent = "sandbox (app only)";
    el.setAttribute("title", "Code execution is only available inside the Delonix Tutor app (npm run tauri dev).");
    return;
  }
  el.textContent = sandboxLabel(sandboxEngine);
  el.setAttribute("title", sandboxTip(sandboxEngine));
}

function syncSandboxRadios() {
  document.querySelectorAll<HTMLInputElement>('#sandbox-choices input[name="sandbox"]').forEach((r) => {
    r.checked = r.value === sandboxEngine;
  });
}

function syncLocaleRadios() {
  const active = getLocale();
  document.querySelectorAll<HTMLInputElement>('#locale-choices input[name="locale"]').forEach((r) => {
    r.checked = r.value === active;
  });
}

function openSettings(opts?: { section?: string }) {
  syncSandboxRadios();
  syncLocaleRadios();
  $("#sandbox-appnote").classList.toggle("hidden", hasTauri);
  $("#settings-ai-model").textContent = activeModelLabel(); // mirror the Agent's active model
  ($("#settings-search") as HTMLInputElement).value = "";
  filterSettings("");
  $("#settings-overlay").classList.remove("hidden");
  if (opts?.section) {
    requestAnimationFrame(() => document.getElementById(opts.section!)?.scrollIntoView({ block: "start" }));
  }
}

/** Live-filter the Settings sections by heading + note text (RF-UI-03 search). */
function filterSettings(query: string): void {
  const q = query.trim().toLowerCase();
  document.querySelectorAll<HTMLElement>("#settings-overlay .settings-sec").forEach((sec) => {
    const hit = !q || sec.textContent?.toLowerCase().includes(q);
    sec.classList.toggle("hidden", !hit);
  });
}

function closeSettings() {
  $("#settings-overlay").classList.add("hidden");
}

function updateStatusBar() {
  $("#status-points").textContent = t("status.points", { points });
  if (profile) {
    $("#status-lang").textContent = profile.language;
    const lvl = $("#status-level");
    const chosen = LEVEL_IDS.filter((id) => profile!.levels.includes(id));
    lvl.textContent =
      chosen.length === LEVEL_IDS.length
        ? t("status.allLevels")
        : chosen.map((id) => levelLabel(id)).join(" · ");
    lvl.className = "pill";
  }
}

// ── Open a step (dispatch by kind) ───────────────────────────────────────────

// Per-language presentation metadata. The guided flow itself is data-driven, so
// a new course only needs its Monaco highlighting id, a source-file extension and
// a human-readable name. Everything falls back to Rust for older/unknown payloads.
const LANG_META: Record<string, { monaco: string; ext: string; name: string; glyph: string }> = {
  rust: { monaco: "rust", ext: "rs", name: "Rust", glyph: "&#129408;" }, // crab
  go: { monaco: "go", ext: "go", name: "Go", glyph: "&#128170;" }, // flexed biceps
  python: { monaco: "python", ext: "py", name: "Python", glyph: "&#128013;" }, // snake
  javascript: { monaco: "javascript", ext: "js", name: "JavaScript", glyph: "&#9889;" }, // bolt
  c: { monaco: "c", ext: "c", name: "C", glyph: "&#128295;" }, // wrench
};
function langMeta(): { monaco: string; ext: string; name: string; glyph: string } {
  const key = (course?.language ?? profile?.language ?? "rust").trim().toLowerCase();
  return LANG_META[key] ?? LANG_META.rust;
}

function fileName(step: StepDto): string {
  const base = step.entry && step.entry.trim() ? step.entry : step.id;
  return `${base}.${langMeta().ext}`;
}

function clearOverlays() {
  if (editor) {
    editor.changeViewZones((acc) => {
      for (const id of drillZoneIds) acc.removeZone(id);
    });
    const model = editor.getModel();
    if (model) monaco.editor.setModelMarkers(model, "dxtutor", []);
  }
  drillZoneIds = [];
  drillCommentDecorations?.clear();
}

function openStep(step: StepDto) {
  if (!isUnlocked(step.id)) return; // defensive: gating
  persistActiveCode(); // flush the step we are leaving before switching models
  activeStepId = step.id;
  window.clearTimeout(diagTimer);
  clearOverlays();

  editor.setModel(modelFor(step));
  requestAnimationFrame(() => editor.layout());

  // Sidebar highlight + make sure the active step's unit is unfolded (navigating
  // to a step always reveals it, even if its section was collapsed).
  ensureUnitExpandedFor(step.id);
  document.querySelectorAll(".step-item").forEach((el) =>
    el.classList.toggle("active", (el as HTMLElement).dataset.id === step.id),
  );

  // Tab.
  $("#tabs").innerHTML = `<div class="tab active">
      <span class="file-icon">&#9679;</span>${esc(fileName(step))}
    </div>`;

  // Status bar.
  $("#status-phase").textContent = step.title;
  updateStatusBar();

  // "Nothing without a clear introduction": a drill/challenge first shows its
  // briefing (the `intro`), gated behind Start, before the work area is revealed.
  // Concept steps are their own introduction (the `body`), so they open directly.
  if (step.kind === "concept") openConcept(step);
  else if (step.kind === "drill") maybeBrief(step, () => openDrill(step));
  else maybeBrief(step, () => openChallenge(step));
}

// ── Briefing gate ("nothing without a clear introduction") ───────────────────

// Show the step's `intro` first, gated behind Start; only then reveal the work
// area. Already-completed steps (and ones briefed earlier this session) skip it.
function maybeBrief(step: StepDto, proceed: () => void) {
  const intro = (step.intro ?? "").trim();
  if (done.has(step.id) || !intro || briefed.has(step.id)) {
    proceed();
    return;
  }
  showBriefing(step, proceed);
}

function showBriefing(step: StepDto, proceed: () => void) {
  // Keep the work area hidden: editor read-only, no drill ghost, no starter focus.
  editor.updateOptions({ ...SUGGEST_OFF, readOnly: true });
  clearOverlays();

  const kindLabel = step.kind === "drill" ? "Drill — rewrite it" : "Apply — your turn";
  const content = showResults();
  content.innerHTML = `
    <div class="step-banner ${step.kind}">
      <span class="step-banner-kind">Briefing · ${kindLabel}</span>
      ${diffStars(step.difficulty, step.kind)}<span class="step-banner-pts">+${step.points} pts</span>
    </div>
    <div class="result-card briefing-card">
      <div class="briefing-flag">&#128218; Read this first</div>
      <h2 class="step-heading">${esc(step.title)}</h2>
      <div class="markdown">${renderMarkdown(step.intro)}</div>
      <p class="disclaimer">This briefing explains how the computation solves the problem.
      Read it, then press <strong>Start</strong> (Ctrl+Enter) to open the work area.</p>
    </div>
    ${pkgCommandsHtml(step)}`;
  wirePkgCopy(content);

  pendingStart = () => {
    pendingStart = null;
    briefed.add(step.id);
    proceed();
  };
  setActions(["start"]);
}

function startStep() {
  const cb = pendingStart;
  if (cb) cb();
}

// ── Concept step ─────────────────────────────────────────────────────────────

function openConcept(step: StepDto) {
  editor.updateOptions({ ...SUGGEST_OFF, readOnly: true });
  // The editor isn't the focus of a concept — give it a gentle reminder.
  const m = modelFor(step);
  if (m.getValue().trim() === "") {
    m.setValue(`// ${step.title}\n//\n// Read the concept on the right, then press Continue.\n`);
  }

  const isDone = done.has(step.id);
  const content = showResults();
  content.innerHTML = `
    <div class="step-banner concept">
      <span class="step-banner-kind">Concept</span>
      ${diffStars(step.difficulty, step.kind)}<span class="step-banner-pts">+${step.points} pts</span>
    </div>
    <div class="result-card">
      <h2 class="step-heading">${esc(step.title)}</h2>
      ${step.prompt ? `<p class="step-prompt">${esc(step.prompt)}</p>` : ""}
      <div class="markdown">${renderMarkdown(step.body)}</div>
    </div>
    ${isDone ? '<p class="disclaimer">&#10004; You already completed this step.</p>' : ""}`;

  setActions(isDone ? ["next"] : ["continue"]);
}

// ── Drill step (the muscle-building core) ────────────────────────────────────

// Line-by-line normalization, tolerant of trailing whitespace and trailing
// blank lines (but not of different content or order).
function normLines(s: string): string[] {
  const lines = (s ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Mask the CONTENT of string ("…") and char ('…') literals with a single marker
// so only the STRUCTURE of a line is compared. This is the "creativity" rule:
// the student may change the text inside `println!("…")` (or any string/char)
// without changing the shape of the program. Escapes are honoured; a lone `'`
// with no nearby closing quote is treated as a Rust lifetime, not a char.
const LIT_MARK = "∎"; // ∎
function maskLiterals(line: string): string {
  let out = "";
  const n = line.length;
  let i = 0;
  while (i < n) {
    const ch = line[i];
    if (ch === '"') {
      i++;
      while (i < n) {
        if (line[i] === "\\") { i += 2; continue; }
        if (line[i] === '"') { i++; break; }
        i++;
      }
      out += `"${LIT_MARK}"`;
    } else if (ch === "'") {
      // Char literal only if a closing quote is within a short window; otherwise
      // it is almost certainly a lifetime (e.g. &'a str) — leave it as written.
      let j = i + 1;
      let closed = false;
      for (let k = 0; j < n && k < 12; k++) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === "'") { closed = true; break; }
        j++;
      }
      if (closed) {
        out += `'${LIT_MARK}'`;
        i = j + 1;
      } else {
        out += ch;
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Does the student's program match the target's STRUCTURE, ignoring the content
// of string/char literals? Line-for-line on the masked, trimmed lines (the same
// trailing-whitespace / trailing-blank tolerance as `normLines`).
function structuralMatch(student: string, target: string): boolean {
  const s = normLines(student).map(maskLiterals);
  const t = normLines(target).map(maskLiterals);
  if (s.length !== t.length) return false;
  for (let i = 0; i < t.length; i++) if (s[i] !== t[i]) return false;
  return true;
}

function placeholderPolicyFor(step: StepDto): "shown" | "onDemand" {
  return step.placeholderPolicy === "onDemand" ? "onDemand" : "shown";
}

// Is the drill target currently revealed? Completed drills always show it (with
// ticks); "shown" policy always reveals; "onDemand" starts hidden until asked.
function isPlaceholderRevealed(step: StepDto): boolean {
  if (done.has(step.id)) return true;
  if (placeholderPolicyFor(step) === "shown") return true;
  return placeholderRevealed.has(step.id);
}

function openDrill(step: StepDto) {
  // No autocomplete — the whole point is to type it yourself.
  editor.updateOptions({ ...SUGGEST_OFF, readOnly: false });
  editor.focus();

  const isDone = done.has(step.id);
  const target = normLines(step.target);
  const onDemand = placeholderPolicyFor(step) === "onDemand";
  const revealed = isPlaceholderRevealed(step);

  // The dim "type this" ghost placeholder inside the editor. It disappears once
  // the drill is complete, and (onDemand) only appears once the target is shown.
  if (!isDone && revealed) showDrillGhost(target);

  const content = showResults();
  const lineRows = target
    .map(
      (ln, i) =>
        `<div class="drill-line" data-i="${i}"><span class="mk">&#8226;</span><span class="code">${esc(
          ln,
        ) || "&nbsp;"}</span></div>`,
    )
    .join("");

  // onDemand (advanced): a Show/Hide toggle instead of the always-on target.
  const toggleBtn =
    onDemand && !isDone
      ? `<button class="btn btn-secondary drill-ph-toggle" type="button">${
          revealed ? t("btn.hidePlaceholder") : t("btn.showPlaceholder")
        }</button>`
      : "";
  const startHint = onDemand
    ? "Write it from what you learned — reveal the target only if you need it. The text inside strings is yours to change; press Run when it works."
    : "Rebuild the program in the editor to the left — the text inside strings is yours to change. Press Run when it works.";

  content.innerHTML = `
    <div class="step-banner drill">
      <span class="step-banner-kind">Drill — rewrite it</span>
      ${diffStars(step.difficulty, step.kind)}<span class="step-banner-pts">+${step.points} pts</span>
    </div>
    ${
      step.prompt
        ? `<div class="result-card"><div class="markdown">${renderMarkdown(step.prompt)}</div></div>`
        : ""
    }
    ${pkgCommandsHtml(step)}
    <div class="result-card drill-type-card">
      <div class="drill-type-head">
        <h3>Rebuild this <span class="drill-no-ac">no autocomplete</span></h3>
        ${toggleBtn}
      </div>
      <div class="drill-progress">
        <div class="drill-bar"><div class="drill-bar-fill" style="width:0%"></div></div>
        <span class="drill-count">0 / ${target.length} lines</span>
      </div>
      <pre class="drill-target${revealed ? "" : " hidden"}">${lineRows}</pre>
      <div class="drill-status waiting">${startHint}</div>
    </div>
    <div class="result-card drill-output hidden"><h3>Program output</h3><div class="drill-output-body"></div></div>
    <div class="result-card drill-explain hidden"><h3>What just happened</h3><div class="markdown"></div></div>`;
  wirePkgCopy(content);

  if (onDemand && !isDone) {
    content
      .querySelector<HTMLButtonElement>(".drill-ph-toggle")
      ?.addEventListener("click", () => toggleDrillPlaceholder(step));
  }

  if (isDone) {
    markDrillComplete(step, true);
  } else {
    setRunLabel(RUN_ICON + "Run");
    updateDrillProgress(step); // reflect any text the student already had
  }
  setActions(isDone ? ["next"] : ["run"]);
}

// Reveal / hide the drill target (onDemand policy). Hiding keeps the live
// line-by-line progress working — it only withholds the answer text + ghost.
function toggleDrillPlaceholder(step: StepDto) {
  const reveal = !placeholderRevealed.has(step.id);
  if (reveal) placeholderRevealed.add(step.id);
  else placeholderRevealed.delete(step.id);

  const pre = document.querySelector<HTMLElement>(".drill-target");
  pre?.classList.toggle("hidden", !reveal);
  const btn = document.querySelector<HTMLElement>(".drill-ph-toggle");
  if (btn) btn.textContent = reveal ? t("btn.hidePlaceholder") : t("btn.showPlaceholder");

  if (reveal) {
    showDrillGhost(normLines(step.target));
  } else {
    editor.changeViewZones((acc) => {
      for (const id of drillZoneIds) acc.removeZone(id);
      drillZoneIds = [];
    });
  }
}

function showDrillGhost(target: string[]) {
  const body = target.length ? target : ["(empty program)"];
  editor.changeViewZones((acc) => {
    for (const id of drillZoneIds) acc.removeZone(id);
    drillZoneIds = [];
    const id = acc.addZone({
      afterLineNumber: 0,
      heightInLines: body.length + 1,
      domNode: ghostNode("\u{1F4AA} Target — rewrite it below, line for line", body, "#4fc3d6"),
    });
    drillZoneIds.push(id);
  });
}

// A dim, VSCode-ghost-text-style card for a Monaco view zone.
function ghostNode(title: string, bodyLines: string[], accent: string): HTMLElement {
  const node = document.createElement("div");
  node.style.cssText =
    `border-left:2px solid ${accent};padding:4px 12px;` +
    `background:rgba(255,255,255,0.03);` +
    `font-family:"Cascadia Code","Fira Code",Menlo,Consolas,monospace;` +
    `font-size:12px;color:#8a9199;white-space:pre;overflow:auto;`;
  const head = document.createElement("div");
  head.style.cssText = `color:${accent};font-weight:600;margin-bottom:3px;white-space:normal;`;
  head.textContent = title;
  node.appendChild(head);
  for (const line of bodyLines) {
    const row = document.createElement("div");
    row.style.opacity = "0.75";
    row.textContent = line === "" ? " " : line;
    node.appendChild(row);
  }
  return node;
}

// Live comparison on every keystroke while a drill is active.
function updateDrillProgress(step: StepDto) {
  if (done.has(step.id)) return;
  // Compare STRUCTURE: the literal content of strings/chars is masked, so the
  // student can change the text inside `println!("…")` and the line still ticks.
  const target = normLines(step.target).map(maskLiterals);
  const user = normLines(editor.getValue()).map(maskLiterals);

  let matched = 0;
  const rows = document.querySelectorAll<HTMLElement>(".drill-target .drill-line");
  rows.forEach((row) => {
    const i = Number(row.dataset.i);
    const ok = user[i] !== undefined && user[i] === target[i];
    if (ok) matched++;
    const mk = row.querySelector(".mk")!;
    row.classList.toggle("ok", ok);
    mk.innerHTML = ok ? "&#10004;" : "&#8226;";
  });

  const full = user.length === target.length && matched === target.length;
  const pct = target.length ? Math.round((matched / target.length) * 100) : 100;

  const fill = document.querySelector<HTMLElement>(".drill-bar-fill");
  if (fill) fill.style.width = `${pct}%`;
  const count = document.querySelector<HTMLElement>(".drill-count");
  if (count) count.textContent = `${matched} / ${target.length} lines`;

  const status = document.querySelector<HTMLElement>(".drill-status");
  if (status) {
    if (full) {
      status.className = "drill-status match";
      status.innerHTML = "&#10004; Structure matches — press &#9654; Run to check it.";
    } else {
      const extra = user.length > target.length ? " (remove the extra lines)" : "";
      status.className = "drill-status waiting";
      status.textContent = `Not yet — ${matched} of ${target.length} lines match${extra}.`;
    }
  }

  // Auto-comment: every line whose structure now matches gets its explanation.
  setDrillLineComments(step);
}

// Show a dim ghost "// explanation" after each drill line the student has got
// right (index-aligned with lineComments). Pure decoration — it is never part
// of the model text, so the line-by-line comparison is untouched. When a line
// stops matching its comment disappears; on completion they stay visible.
function setDrillLineComments(step: StepDto) {
  const model = editor.getModel();
  if (!model || !model.getValue) return;
  const comments = step.lineComments ?? [];
  if (!comments.length) {
    drillCommentDecorations?.clear();
    return;
  }
  const target = normLines(step.target).map(maskLiterals);
  const user = normLines(editor.getValue()).map(maskLiterals);
  const complete = done.has(step.id);
  const decos: monaco.editor.IModelDeltaDecoration[] = [];
  const lineCount = model.getLineCount();
  for (let i = 0; i < target.length && i < comments.length; i++) {
    const text = (comments[i] ?? "").trim();
    if (!text) continue;
    const ok = complete || (user[i] !== undefined && user[i] === target[i]);
    if (!ok) continue;
    const line = i + 1;
    if (line > lineCount) continue;
    const col = model.getLineMaxColumn(line);
    decos.push({
      range: new monaco.Range(line, col, line, col),
      options: {
        showIfCollapsed: true,
        after: {
          content: `    // ${text}`,
          inlineClassName: "drill-linecomment",
          cursorStops: monaco.editor.InjectedTextCursorStops.None,
        },
      },
    });
  }
  if (!drillCommentDecorations) drillCommentDecorations = editor.createDecorationsCollection();
  drillCommentDecorations.set(decos);
}

// The RUN gate. A drill completes ONLY when the student presses Run and the
// program (1) runs cleanly (`ok`) AND (2) matches the target STRUCTURE (literal
// content is ignored — the strings may be the student's own). It runs no matter
// what, so the student always sees real output / real compiler errors.
async function runDrillGated(step: StepDto) {
  if (busy || done.has(step.id)) return;
  const status = document.querySelector<HTMLElement>(".drill-status");
  if (!hasTauri) {
    if (status) {
      status.className = "drill-status waiting";
      status.textContent = "Native backend unavailable — run inside `tauri dev` to execute it.";
    }
    return;
  }
  persistActiveCode(); // checkpoint the drill text before running
  setBusy(true);
  try {
    const r = await invoke<RunDto>("run_drill", {
      code: editor.getValue(),
      language: course?.language ?? "rust",
      dependencies: step.dependencies ?? [],
    });
    showDrillOutput(r);
    const structural = structuralMatch(editor.getValue(), step.target);
    // Accuracy counts a drill as "passed" only when it both ran and matched.
    recordAttempt(step, r.ok && structural);
    if (r.ok && structural) {
      completeStep(step); // points, progress, sidebar, celebration
      markDrillComplete(step, false);
      revealExplanation(step);
    } else if (r.ok && !structural) {
      if (status) {
        status.className = "drill-status waiting";
        status.textContent = "It runs! Now match the exercise structure to continue.";
      }
    } else {
      if (status) {
        status.className = "drill-status waiting";
        status.textContent = "It didn't compile — check the errors in the output below.";
      }
    }
  } catch (e) {
    renderError("Run", String(e));
  } finally {
    setBusy(false);
  }
}

function showDrillOutput(r: RunDto) {
  const card = document.querySelector<HTMLElement>(".drill-output");
  const body = document.querySelector<HTMLElement>(".drill-output-body");
  if (!card || !body) return;
  card.classList.remove("hidden");
  // Structured run output: a "$ running" header, stdout / stderr split into
  // labelled streams, and a clear exit-state footer (reuses the .run-* shell).
  const out = (r.stdout ?? "").replace(/\s+$/, "");
  const err = (r.stderr ?? "").replace(/\s+$/, "");
  let streams = "";
  if (out)
    streams += `<div class="run-sec"><div class="run-sec-h">stdout</div><pre class="run-pre">${esc(out)}</pre></div>`;
  if (err)
    streams += `<div class="run-sec err"><div class="run-sec-h">stderr</div><pre class="run-pre">${esc(err)}</pre></div>`;
  if (!streams) streams = `<div class="run-sec"><pre class="run-pre run-muted">(no output)</pre></div>`;
  const status = r.ok
    ? `<div class="run-status ok">Finished</div>`
    : `<div class="run-status err">Exited with error</div>`;
  body.innerHTML =
    `<div class="run-block"><div class="run-cmd"><span class="run-prompt">$</span> running</div>${streams}${status}</div>`;
}

// Drop the ghost, flip the UI into its "done" state.
function markDrillComplete(step: StepDto, silent: boolean) {
  editor.changeViewZones((acc) => {
    for (const id of drillZoneIds) acc.removeZone(id);
    drillZoneIds = [];
  });
  const status = document.querySelector<HTMLElement>(".drill-status");
  if (status) {
    status.className = "drill-status match";
    status.innerHTML = "&#10004; Nailed it — the target is gone. Points earned.";
  }
  const fill = document.querySelector<HTMLElement>(".drill-bar-fill");
  if (fill) fill.style.width = "100%";
  const count = document.querySelector<HTMLElement>(".drill-count");
  const target = normLines(step.target);
  if (count) count.textContent = `${target.length} / ${target.length} lines`;
  setDrillLineComments(step); // keep every line's explanation visible once done
  if (step.explanation) revealExplanation(step);
  setActions(["next"]);
  if (!silent) focusNext();
}

function revealExplanation(step: StepDto) {
  if (!step.explanation) return;
  const card = document.querySelector<HTMLElement>(".drill-explain");
  const body = document.querySelector<HTMLElement>(".drill-explain .markdown");
  if (card && body) {
    card.classList.remove("hidden");
    body.innerHTML = renderMarkdown(step.explanation);
  }
}

// ── Challenge step (apply, graded by the hidden tests) ───────────────────────

function openChallenge(step: StepDto) {
  editor.updateOptions({ ...SUGGEST_ON, readOnly: false });
  editor.focus();
  setRunLabel(RUN_ICON + "Run / Submit");

  const isDone = done.has(step.id);
  const content = showResults();
  content.innerHTML = `
    <div class="step-banner challenge">
      <span class="step-banner-kind">Apply — your turn</span>
      ${diffStars(step.difficulty, step.kind)}<span class="step-banner-pts">+${step.points} pts</span>
    </div>
    <div class="result-card">
      <h2 class="step-heading">${esc(step.title)}</h2>
      ${step.prompt ? `<p class="step-prompt">${esc(step.prompt)}</p>` : ""}
      <div class="markdown">${renderMarkdown(step.instructions || step.body)}</div>
      <p class="disclaimer">Press <strong>Run / Submit</strong> (Ctrl+Enter) to grade with the
      hidden tests. Correctness is decided by the tests — never by AI. Stuck? Press <strong>Hint</strong> (F1).</p>
    </div>
    ${pkgCommandsHtml(step)}
    ${isDone ? '<p class="disclaimer">&#10004; You already passed this challenge.</p>' : ""}`;
  wirePkgCopy(content);

  setActions(isDone ? ["run", "hint", "next"] : ["run", "hint"]);
}

// English "N passed, M failed" aggregated across EVERY "test result:" line cargo
// prints (lib tests, integration tests, doctests) — so a 0/0 lib line never masks
// the integration failures.
function enSummary(a: AssessmentDto): string {
  const re = /(\d+)\s+passed;\s+(\d+)\s+failed/gi;
  let passed = 0;
  let failed = 0;
  let found = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(a.correctness.raw)) !== null) {
    passed += Number(m[1]);
    failed += Number(m[2]);
    found = true;
  }
  return found ? `${passed} passed, ${failed} failed` : a.correctness.summary;
}
function fx(n: unknown, digits: number): string {
  return typeof n === "number" && isFinite(n) ? n.toFixed(digits) : "—";
}
function confBadge(conf: string): string {
  const c = conf.toLowerCase();
  return `<span class="conf-badge ${esc(c)}">${esc(conf)}</span>`;
}

function renderAssessment(step: StepDto, a: AssessmentDto) {
  const content = showResults();
  const passed = a.correctness.passed;

  // The most common "failure" is the untouched starter (`todo!()`): frame it as
  // a tutor would — "you haven't written it yet" — not as a scary error.
  const notImpl = !passed && /not yet implemented|todo!\(/i.test(a.correctness.raw);
  if (notImpl) {
    content.innerHTML = `
      <div class="verdict fail"><span>&#9998;</span>
        <span>Not written yet — implement <code>${esc(step.entry)}</code> and run again</span></div>
      <div class="result-card">
        <h3>Start here</h3>
        <p>The starter still calls <code>todo!()</code>, so the hidden tests can't pass yet.
        Replace it with your own implementation of <code>${esc(step.entry)}</code>, then press
        <strong>Run / Submit</strong> (Ctrl+Enter).</p>
        <p class="disclaimer">Stuck? Press <strong>Hint</strong> (F1). Correctness is always
        decided by the hidden tests, never by AI.</p>
      </div>`;
    lastTestOutput.set(step.id, a.correctness.raw);
    return;
  }

  let html = `<div class="verdict ${passed ? "pass" : "fail"}">
      <span>${passed ? "&#10004;" : "&#10006;"}</span>
      <span>${passed ? "Tests passed" : "Tests failed"} — ${esc(enSummary(a))}</span>
    </div>`;

  html += `<div class="result-card">
      <h3>Correctness (source of truth: the tests)</h3>
      <div class="kv"><span class="k">Verdict</span>
        <span class="v ${passed ? "good" : "bad"}">${passed ? "PASS" : "FAIL"}</span></div>
      <div class="kv"><span class="k">Summary</span><span class="v">${esc(enSummary(a))}</span></div>
      <p class="disclaimer">Decided by <code>cargo test</code> on hidden tests, never by AI.</p>
      ${a.correctness.raw.trim() ? `<pre class="raw">${esc(a.correctness.raw.trim())}</pre>` : ""}
    </div>`;

  if (a.complexity) {
    const c = a.complexity;
    const expected = a.expected ?? "—";
    const match = a.expected && c.bigO === a.expected ? "good" : a.expected ? "warn" : "";
    html += `<div class="result-card">
        <h3>Measured complexity (empirical estimate)</h3>
        <div class="kv"><span class="k">Measured class</span>
          <span class="v ${match}">${esc(c.bigO)} ${confBadge(c.confidence)}</span></div>
        <div class="kv"><span class="k">Expected (curated)</span><span class="v">${esc(expected)}</span></div>
        <div class="kv"><span class="k">R² (log-space)</span><span class="v">${fx(c.rSquared, 4)}</span></div>
        <div class="kv"><span class="k">log-log exponent</span><span class="v">${fx(c.exponent, 3)}</span></div>
        <div class="kv"><span class="k">Ranking</span><span class="v">${c.ranking
          .map((r) => `${esc(r[0])} (${fx(r[1], 3)})`)
          .join(" · ")}</span></div>
        <p class="disclaimer">This is an empirical ESTIMATE from timing the probe at growing
        input sizes — not a formal proof. Treat R²/confidence accordingly.</p>
      </div>`;
  } else if (passed) {
    html += `<div class="result-card">
        <h3>Measured complexity</h3>
        <div class="kv"><span class="k">Status</span><span class="v">No probe for this phase.</span></div>
      </div>`;
  }

  html += `<div class="result-card"><h3>Gabarito (curated reference)</h3>`;
  if (passed && a.gabarito) {
    const g = a.gabarito;
    html += `
      <div class="kv"><span class="k">Reference time</span><span class="v good">${esc(g.time)}</span></div>
      <div class="kv"><span class="k">Reference space</span><span class="v good">${esc(g.space)}</span></div>
      <h3 style="margin-top:10px">Reference solution</h3>
      <pre class="gabarito-solution">${esc((g.solution ?? "").trim())}</pre>
      <h3 style="margin-top:10px">Why this complexity</h3>
      <div class="markdown">${renderMarkdown(g.justification)}</div>`;
  } else {
    html += `<p class="gabarito-locked">&#128274; The reference solution unlocks once the tests
      pass. Keep going — ask for a Hint (F1) if you are stuck.</p>`;
  }
  html += `</div>`;

  content.innerHTML = html;
  if (!passed) lastTestOutput.set(step.id, a.correctness.raw);
  else lastTestOutput.delete(step.id);
}

async function submitChallenge(step: StepDto) {
  if (busy) return;
  if (!hasTauri) {
    renderError("Run / Submit", "native backend unavailable (run inside `tauri dev`).");
    return;
  }
  const code = editor.getValue();
  persistActiveCode(); // a submit is a good checkpoint to save the current text
  setBusy(true);
  try {
    const a = await invoke<AssessmentDto>("submit_step", { stepId: step.id, code });
    renderAssessment(step, a);
    recordAttempt(step, a.correctness.passed); // accuracy: a submit that passed vs failed
    if (a.correctness.passed && !done.has(step.id)) {
      completeStep(step);
      setActions(["run", "hint", "next"]);
      focusNext();
    }
  } catch (e) {
    renderError("Run / Submit", String(e));
  } finally {
    setBusy(false);
  }
}

// ── Completion / points / celebration ────────────────────────────────────────

function completeStep(step: StepDto) {
  if (done.has(step.id)) return;
  done.add(step.id);
  points += step.points;
  saveDone();
  savePoints(points);

  renderSidebar(); // refresh states + gating + points
  // keep the active row highlighted after the sidebar rebuild
  document.querySelectorAll(".step-item").forEach((el) =>
    el.classList.toggle("active", (el as HTMLElement).dataset.id === step.id),
  );

  toast(`&#9733; +${step.points} points`, "points");

  const unit = unitOf(step.id);
  if (unit && unit.steps.every((s) => done.has(s.id))) {
    toast(`&#127881; Unit complete — ${esc(unit.title)}`, "unit");
    celebrateUnit(unit);
  }
  if (visibleSteps().every((s) => done.has(s.step.id))) {
    toast("&#127942; Track complete! You finished every unit.", "unit");
  }
}

function celebrateUnit(unit: UnitDto) {
  const content = $("#results-content");
  const banner = document.createElement("div");
  banner.className = "unit-complete-banner";
  banner.innerHTML = `<span class="uc-emoji">&#127881;</span>
    <div><div class="uc-title">Unit complete!</div>
    <div class="uc-sub">${esc(unit.title)} — press Next to move on.</div></div>`;
  content.prepend(banner);
}

// ── Step action buttons (Run / Hint / Continue / Next) ───────────────────────

type ActionName = "run" | "hint" | "continue" | "next" | "start";
let activeActions: ActionName[] = [];

function setActions(names: ActionName[]) {
  activeActions = names;
  const map: Record<ActionName, string> = {
    run: "#btn-run",
    hint: "#btn-hint",
    continue: "#btn-continue",
    next: "#btn-next",
    start: "#btn-start",
  };
  for (const [name, sel] of Object.entries(map)) {
    $(sel).classList.toggle("hidden", !names.includes(name as ActionName));
  }
}

// Inline play glyph (matches the activity bar / topbar line-icon system).
const RUN_ICON =
  '<svg class="btn-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4.5v15l12-7.5-12-7.5Z"/></svg>';

// Line-icons for the package-manager teaching block (same stroke system as the
// rest of the UI): a shipping box for "install", a play triangle for "run" and a
// clipboard for the copy affordance on each command.
const PKG_ICON =
  '<svg class="pkg-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8l-9-5-9 5v8l9 5 9-5Z"/><path d="M3.3 7.5 12 12.5l8.7-5"/><path d="M12 12.5V21"/></svg>';
const RUNCMD_ICON =
  '<svg class="pkg-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5.5v13l10-6.5-10-6.5Z"/></svg>';
const COPY_ICON =
  '<svg class="pkg-copy-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';

// One copyable command row (monospace block + a copy button).
function pkgCmdRow(cmd: string): string {
  return `<div class="pkg-cmd"><code>${esc(cmd)}</code><button class="pkg-copy" type="button" data-cmd="${esc(
    cmd,
  )}" title="Copy command" aria-label="Copy command">${COPY_ICON}</button></div>`;
}

// Teaching panel for the language's official package manager. Shown in the
// briefing / exercise enunciation whenever the step declares installCommands.
// Steps without packages render nothing (empty string).
function pkgCommandsHtml(step: StepDto): string {
  const installs = (step.installCommands ?? []).map((c) => (c ?? "").trim()).filter(Boolean);
  if (installs.length === 0) return "";
  const run = (step.runCommand ?? "").trim();
  const runBlock = run
    ? `<div class="pkg-group">
         <div class="pkg-label">${RUNCMD_ICON}<span>Run it:</span></div>
         ${pkgCmdRow(run)}
       </div>`
    : "";
  return `<div class="result-card pkg-card">
    <div class="pkg-group">
      <div class="pkg-label">${PKG_ICON}<span>Install the package(s):</span></div>
      ${installs.map(pkgCmdRow).join("")}
    </div>
    ${runBlock}
    <p class="disclaimer">This is how you install and run with ${esc(
      langMeta().name,
    )}'s official package manager — worth learning. The Tutor already prepares the environment for you, so the sandbox takes care of the rest.</p>
  </div>`;
}

// Wire the copy buttons inside a freshly-rendered container. Uses the async
// Clipboard API when present and gives brief visual feedback on success.
function wirePkgCopy(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>(".pkg-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cmd = btn.dataset.cmd ?? "";
      void navigator.clipboard?.writeText(cmd).then(
        () => {
          btn.classList.add("copied");
          window.setTimeout(() => btn.classList.remove("copied"), 1200);
        },
        () => {},
      );
    });
  });
}

// The primary "run" button is shared by drills and challenges; its label tells
// the student what pressing it does ("Run" for a drill, "Run / Submit" for a
// graded challenge).
function setRunLabel(html: string) {
  $("#btn-run").innerHTML = html;
}

// Ctrl+Enter runs whichever primary action is live for the active step.
function primaryAction() {
  const step = currentStep();
  if (!step) return;
  if (activeActions.includes("start")) startStep();
  else if (activeActions.includes("run"))
    step.kind === "drill" ? void runDrillGated(step) : void submitChallenge(step);
  else if (activeActions.includes("continue")) continueStep(step);
  else if (activeActions.includes("next")) focusNext();
}

function continueStep(step: StepDto) {
  if (!done.has(step.id)) completeStep(step);
  focusNext();
}

// Advance to the next step in track order, if it is now unlocked.
function focusNext() {
  const flat = visibleSteps();
  const idx = flat.findIndex((s) => s.step.id === activeStepId);
  if (idx === -1 || idx + 1 >= flat.length) {
    setActions([]); // end of the track
    return;
  }
  const next = flat[idx + 1].step;
  if (isUnlocked(next.id)) openStep(next);
}

// ── Hints (challenges only) ──────────────────────────────────────────────────

async function requestHint() {
  if (busy) return;
  const step = currentStep();
  if (!step || step.kind !== "challenge") return;
  if (!hasTauri) {
    renderError("Hint", "native backend unavailable (run inside `tauri dev`).");
    return;
  }
  const level = hintLevel.get(step.id) ?? 1;
  const code = editor.getValue();
  setBusy(true);
  try {
    const h = await invoke<HintDto>("request_hint", { phaseId: step.id, code, level });
    renderHint(h);
    hintLevel.set(step.id, Math.min(3, level + 1));
  } catch (e) {
    renderError("Hint", String(e));
  } finally {
    setBusy(false);
  }
}

function renderHint(h: HintDto) {
  const content = showResults();
  const block = document.createElement("div");
  block.className = "hint-block";
  block.innerHTML = `<div class="hint-level">Hint · level ${h.level} · provider: ${esc(
    h.provider,
  )}</div><div class="markdown">${renderMarkdown(h.text)}</div>
    <p class="disclaimer">Hints never give the full solution and never claim your code is
    correct — only the tests decide that.</p>`;
  content.prepend(block);
}

// ── Live diagnostics (challenges only, best-effort) ──────────────────────────

async function refreshDiagnostics(step: StepDto) {
  const model = editor.getModel();
  if (!model || !hasTauri || currentStep()?.id !== step.id) return;
  const gen = ++diagGen;
  let diags: DiagnosticDto[];
  try {
    diags = await invoke<DiagnosticDto[]>("get_diagnostics", {
      stepId: step.id,
      code: editor.getValue(),
    });
  } catch {
    return; // best-effort — never disrupt editing
  }
  if (gen !== diagGen) return;

  const markers: monaco.editor.IMarkerData[] = diags.map((d) => {
    const line = Math.max(1, d.line);
    const col = Math.max(1, d.col);
    return {
      severity:
        d.severity === "warning"
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Error,
      message: d.message,
      startLineNumber: line,
      startColumn: col,
      endLineNumber: line,
      endColumn: col + 1,
    };
  });
  monaco.editor.setModelMarkers(model, "dxtutor", markers);
}

// ── Glossary (reserved-word reference) ───────────────────────────────────────

async function loadGlossary() {
  glossary = [];
  glossaryMap.clear();
  if (!hasTauri || !profile) return;
  try {
    const g = await invoke<GlossaryDto>("get_glossary", { language: profile.language });
    glossary = Array.isArray(g.entries) ? g.entries : [];
  } catch {
    glossary = []; // best-effort — the panel degrades gracefully
  }
  for (const e of glossary) glossaryMap.set(e.keyword, e);
}

function renderGlossaryList(filter = "") {
  const host = $("#gloss-list");
  if (!glossary.length) {
    host.innerHTML = `<p class="disclaimer">No glossary available${
      hasTauri ? "" : " (run inside the app with <code>npm run tauri dev</code>)"
    }.</p>`;
    return;
  }
  const q = filter.trim().toLowerCase();
  const items = glossary.filter(
    (e) =>
      !q ||
      e.keyword.toLowerCase().includes(q) ||
      e.summary.toLowerCase().includes(q),
  );
  if (!items.length) {
    host.innerHTML = `<p class="disclaimer">No keyword matches &ldquo;${esc(filter)}&rdquo;.</p>`;
    return;
  }
  host.innerHTML = items
    .map(
      (e) => `
      <div class="gloss-entry">
        <div class="gloss-kw"><code>${esc(e.keyword)}</code></div>
        <div class="gloss-summary">${esc(e.summary)}</div>
        ${
          e.whenToUse
            ? `<div class="gloss-field"><span class="gloss-lbl">When to use</span><span>${esc(
                e.whenToUse,
              )}</span></div>`
            : ""
        }
        ${e.example ? `<pre class="gloss-example">${esc(e.example)}</pre>` : ""}
      </div>`,
    )
    .join("");
}

function openGlossary() {
  $("#glossary-overlay").classList.remove("hidden");
  const search = $<HTMLInputElement>("#gloss-search");
  search.value = "";
  renderGlossaryList("");
  search.focus();
}

function closeGlossary() {
  $("#glossary-overlay").classList.add("hidden");
}

// ── Study guide (remediation when unit accuracy < 25%) ───────────────────────

// Offer the study guide — encouragingly, never humiliating — once the student
// has genuinely tried (≥ MIN_ATTEMPTS) yet the unit accuracy is under 25%.
function maybeOfferStudyGuide(step: StepDto) {
  const unit = unitOf(step.id);
  if (!unit) return;
  const { attempts, rate } = unitAccuracy(unit);
  if (attempts < MIN_ATTEMPTS_FOR_GUIDE || rate >= STUDY_RATE_THRESHOLD) return;
  if (studyOffered.has(unit.id)) return; // once per unit per session — no nagging
  studyOffered.add(unit.id);
  showStudyInvite(unit);
}

function showStudyInvite(unit: UnitDto) {
  const content = $("#results-content");
  content.querySelector(".study-invite")?.remove();
  const card = document.createElement("div");
  card.className = "study-invite";
  card.innerHTML = `
    <span class="si-emoji">&#129309;</span>
    <div class="si-text">
      <div class="si-title">Need a hand?</div>
      <div class="si-sub">Everyone hits tricky spots. A short study guide for
        <strong>${esc(unit.title)}</strong> can help it click. No pressure — keep going at your pace.</div>
    </div>
    <button class="btn btn-primary si-btn" type="button">Open the study guide</button>`;
  card.querySelector<HTMLButtonElement>(".si-btn")!.addEventListener("click", () =>
    void openStudyGuide(unit),
  );
  content.prepend(card);
}

async function openStudyGuide(unit: UnitDto) {
  const titleEl = $("#study-title-text");
  const body = $("#study-body");
  titleEl.textContent = `${t("study.title")} — ${unit.title}`;
  body.innerHTML = `<p class="disclaimer">Loading…</p>`;
  $("#studyguide-overlay").classList.remove("hidden");
  if (!hasTauri || !profile) {
    body.innerHTML = `<p class="disclaimer">The study guide is available inside the app
      (run <code>npm run tauri dev</code>).</p>`;
    return;
  }
  try {
    const g = await invoke<StudyGuideDto>("get_study_guide", {
      language: profile.language,
      unitId: unit.id,
    });
    titleEl.textContent = (g.title && g.title.trim()) || `${t("study.title")} — ${unit.title}`;
    body.innerHTML = renderMarkdown(g.body);
  } catch (e) {
    body.innerHTML = `<p class="disclaimer">Couldn't load the study guide: ${esc(String(e))}</p>`;
  }
}

function closeStudyGuide() {
  $("#studyguide-overlay").classList.add("hidden");
}

// ── Under the hood (REAL, measured resources + the compiler pipeline) ─────────
// The sacred rule: show only what is REAL and MEASURED. Telemetry comes from
// actually running the program; pipeline text from actually compiling it. GPU
// and NPU are shown as honestly UNUSED — never a faked meter.

function formatKb(kb: number): string {
  if (!isFinite(kb) || kb < 0) return "—";
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
function formatBytes(b: number): string {
  if (!isFinite(b) || b < 0) return "—";
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
// A bar's width is a VISUAL AID only, scaled against a soft reference ceiling for
// a small tutorial program. The bold number beside it is the real measurement.
function pctOf(v: number, softMax: number): number {
  if (!isFinite(v) || v <= 0 || softMax <= 0) return 0;
  return Math.min(100, (v / softMax) * 100);
}

// Count-up animation: the END value is the real measurement; only the path to it
// is animated. Reduced-motion jumps straight to the truth.
function animateNumber(el: HTMLElement | null, to: number, fmt: (v: number) => string) {
  if (!el) return;
  const target = isFinite(to) ? to : 0;
  if (reduceMotion || target === 0) {
    el.textContent = fmt(target);
    return;
  }
  const dur = 650;
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.textContent = fmt(target * eased);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = fmt(target);
  };
  requestAnimationFrame(step);
}
// Smoothly fill a bar from 0 to its width (CSS transition does the easing).
function animateBar(el: HTMLElement | null, pct: number) {
  if (!el) return;
  const w = Math.max(0, Math.min(100, pct));
  if (reduceMotion) {
    el.style.transition = "none";
    el.style.width = `${w}%`;
    return;
  }
  el.style.width = "0%";
  requestAnimationFrame(() => requestAnimationFrame(() => (el.style.width = `${w}%`)));
}

async function openUnderHood() {
  uhSource = editor ? editor.getValue() : "";
  const overlay = $("#underhood-overlay");
  overlay.classList.remove("hidden");
  const body = $("#uh-body");

  if (!hasTauri) {
    body.innerHTML = `<div class="uh-note">
      <strong>Under the hood</strong> compiles your code and runs it to read the <em>real</em> CPU,
      memory and I/O it uses — so it works only inside the app
      (<code>npm run tauri dev</code>). Nothing here is ever simulated.</div>`;
    return;
  }

  body.innerHTML = `<div class="uh-loading">
      <span class="spinner"></span>
      <div>
        <div class="uh-loading-title">Measuring your program…</div>
        <div class="uh-loading-sub">Compiling, then running it to read real CPU, memory and I/O.
          This takes a few seconds.</div>
      </div>
    </div>`;
  const rerun = $("#uh-rerun") as HTMLButtonElement;
  rerun.disabled = true;
  try {
    const [measured, pipeline] = await Promise.all([
      invoke<MeasuredRunDto>("run_measured", { code: uhSource }),
      invoke<PipelineDto>("compile_pipeline", { code: uhSource }),
    ]);
    uhPipeline = pipeline;
    renderUnderHood(measured, pipeline);
  } catch (e) {
    body.innerHTML = `<div class="uh-note error">Couldn't measure this program:
      <code>${esc(String(e))}</code></div>`;
  } finally {
    rerun.disabled = false;
  }
}

function closeUnderHood() {
  $("#underhood-overlay").classList.add("hidden");
}

// Honest "unused accelerator" row — a struck-through, greyed bar with a tooltip,
// NEVER a meter pretending to show activity.
function accelRow(name: string, tip: string): string {
  return `<div class="uh-accel-row" title="${esc(tip)}">
      <span class="uh-accel-name">${esc(name)}</span>
      <span class="uh-accel-track"><span class="uh-accel-strike"></span></span>
      <span class="uh-accel-tag">Not used by this program</span>
    </div>`;
}

// Build an animated memory-over-time chart from the REAL sample series. Returns
// an empty string when there is too little data to draw a meaningful line — the
// caller then falls back to the (always-present) peak-memory gauge. Nothing is
// invented: every vertex is a measured (tMs, rssKb) pair.
function buildMemChart(samples: MemSampleDto[], peakRssKb: number): string {
  const pts = Array.isArray(samples)
    ? samples.filter((s) => s && isFinite(s.tMs) && isFinite(s.rssKb) && s.rssKb >= 0)
    : [];
  if (pts.length < 2) return ""; // not enough to draw — gauge is the fallback

  const W = 600;
  const H = 150;
  const padX = 6;
  const padT = 14;
  const padB = 8;
  const plotW = W - padX * 2;
  const plotH = H - padT - padB;

  const ts = pts.map((s) => s.tMs);
  const rss = pts.map((s) => s.rssKb);
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const spanT = tMax - tMin || 1;
  const rMax = Math.max(peakRssKb || 0, ...rss, 1); // headroom to the real peak

  const xy = pts.map((s, i) => {
    const fx = pts.length > 1 ? (spanT ? (s.tMs - tMin) / spanT : i / (pts.length - 1)) : 0;
    const x = padX + fx * plotW;
    const y = padT + plotH - (s.rssKb / rMax) * plotH;
    return [x, y] as const;
  });

  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const baseY = (padT + plotH).toFixed(1);
  const area = `${line} L${(padX + plotW).toFixed(1)} ${baseY} L${padX.toFixed(1)} ${baseY} Z`;

  // Highlight the measured peak.
  let peakI = 0;
  for (let i = 1; i < rss.length; i++) if (rss[i] > rss[peakI]) peakI = i;
  const [px, py] = xy[peakI];

  return `
    <div class="uh-memchart">
      <div class="uh-memchart-head">
        <span class="uh-memchart-title">Memory over time</span>
        <span class="uh-badge measured"
          title="Each vertex is a real resident-set sample taken while your program ran.">MEASURED</span>
      </div>
      <svg class="uh-memchart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
        role="img" aria-label="Resident memory over time">
        <defs>
          <linearGradient id="uh-memgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(179,157,219,0.42)" />
            <stop offset="100%" stop-color="rgba(179,157,219,0.02)" />
          </linearGradient>
        </defs>
        <path class="uh-memchart-area" d="${area}" fill="url(#uh-memgrad)" />
        <path class="uh-memchart-line" d="${line}" pathLength="1"
          vector-effect="non-scaling-stroke" />
        <circle class="uh-memchart-peak" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}"
          r="3.5" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="uh-memchart-foot">
        <span>Peak <strong>${formatKb(rMax)}</strong></span>
        <span>${pts.length} samples over ${Math.round(tMax)} ms</span>
      </div>
    </div>`;
}

function renderProgramOutput(r: RunDto): string {
  let inner = "";
  if (r.stdout && r.stdout.trim()) inner += `<pre class="raw">${esc(r.stdout.trimEnd())}</pre>`;
  if (r.stderr && r.stderr.trim()) inner += `<pre class="raw stderr">${esc(r.stderr.trimEnd())}</pre>`;
  if (!inner) inner = `<p class="disclaimer">The program produced no output.</p>`;
  return `<div class="uh-output"><h3>Program output</h3>${inner}</div>`;
}

function renderUnderHood(m: MeasuredRunDto, p: PipelineDto) {
  const t = m.telemetry;
  const cpuUser = t.cpuUserMs ?? 0;
  const cpuSys = t.cpuSysMs ?? 0;
  const cpuTotal = cpuUser + cpuSys;
  const cpuPct = t.wallMs > 0 ? Math.min(100, Math.round((cpuTotal / t.wallMs) * 100)) : 0;
  const exitOk = t.exitCode === 0;
  const body = $("#uh-body");

  body.innerHTML = `
    <div class="uh-section">
      <div class="uh-section-head">
        <h3>Measured resources</h3>
        <span class="uh-badge measured"
          title="Every number here was obtained by actually running your program — none are simulated.">MEASURED</span>
      </div>
      <div class="uh-exit ${exitOk ? "ok" : "bad"}">
        <span class="uh-exit-dot"></span>
        <span>Exit code <strong>${t.exitCode}</strong> —
          ${exitOk ? "the program finished cleanly" : "the program exited with an error"}</span>
      </div>
      <div class="uh-gauges">
        <div class="uh-gauge">
          <div class="uh-gauge-label">Wall time</div>
          <div class="uh-gauge-value"><span id="uh-val-wall">0.0</span><span class="uh-unit">ms</span></div>
          <div class="uh-bar"><div class="uh-bar-fill cyan" id="uh-bar-wall"></div></div>
          <div class="uh-gauge-sub">elapsed real time</div>
        </div>
        <div class="uh-gauge">
          <div class="uh-gauge-label">CPU time</div>
          <div class="uh-gauge-value"><span id="uh-val-cpu">0.0</span><span class="uh-unit">ms</span></div>
          <div class="uh-bar"><div class="uh-bar-fill green" id="uh-bar-cpu"></div></div>
          <div class="uh-gauge-sub">user ${fx(cpuUser, 1)} · sys ${fx(cpuSys, 1)} — ${cpuPct}% of wall</div>
        </div>
        <div class="uh-gauge">
          <div class="uh-gauge-label">Peak memory</div>
          <div class="uh-gauge-value"><span id="uh-val-mem">0 KB</span></div>
          <div class="uh-bar"><div class="uh-bar-fill violet" id="uh-bar-mem"></div></div>
          <div class="uh-gauge-sub">peak resident set (RSS)</div>
        </div>
        <div class="uh-gauge">
          <div class="uh-gauge-label">Disk I/O</div>
          <div class="uh-gauge-value"><span id="uh-val-io">0</span><span class="uh-unit">blocks</span></div>
          <div class="uh-bar"><div class="uh-bar-fill amber" id="uh-bar-io"></div></div>
          <div class="uh-gauge-sub">read ${t.ioReadBlocks} · write ${t.ioWriteBlocks}</div>
        </div>
      </div>
      ${buildMemChart(t.samples ?? [], t.peakRssKb)}
      <div class="uh-accel">
        ${accelRow(
          "GPU",
          "No GPU kernels were launched. These exercises are plain CPU Rust, so the GPU stays idle — there is nothing real to measure, and Delonix Tutor will not fake a meter.",
        )}
        ${accelRow(
          "NPU",
          "No neural / tensor accelerator was used. There is no ML inference in these programs, so the NPU is untouched — a fake reading here would be dishonest.",
        )}
      </div>
      ${renderProgramOutput(m.run)}
      <p class="uh-foot">Bars are a visual aid; the bold number is the real measurement.
        GPU and NPU are shown as unused on purpose — Delonix Tutor never fakes a meter.</p>
    </div>

    <div class="uh-section">
      <div class="uh-section-head">
        <h3>Compiler pipeline</h3>
        <span class="uh-badge"
          title="How the Rust compiler and LLVM turn your source into bytes the CPU runs.">source → machine code</span>
      </div>
      <div class="uh-stepper" id="uh-stepper">
        ${UH_PHASES.map(
          (ph, i) =>
            `<button class="uh-step${i === 0 ? " active" : ""}" data-phase="${ph.key}" type="button">
              <span class="uh-step-idx">${i + 1}</span>
              <span class="uh-step-label">${esc(ph.label)}</span>
            </button>${
              i < UH_PHASES.length - 1 ? '<span class="uh-step-arrow">&#8594;</span>' : ""
            }`,
        ).join("")}
      </div>
      <div class="uh-phase-blurb" id="uh-phase-blurb"></div>
      <div class="uh-bin" id="uh-bin">Binary size: <strong>${formatBytes(p.binaryBytes)}</strong>
        <span class="uh-bin-sub">(${
          isFinite(p.binaryBytes) ? p.binaryBytes.toLocaleString() : "—"
        } bytes on disk)</span></div>
      <pre class="uh-viewer" id="uh-viewer"></pre>
    </div>`;

  // Animate the gauges (count-up numbers + fill bars). Soft ceilings are a small
  // tutorial program's typical scale — purely illustrative, clamped to 100%.
  animateNumber($("#uh-val-wall"), t.wallMs, (v) => v.toFixed(1));
  animateNumber($("#uh-val-cpu"), cpuTotal, (v) => v.toFixed(1));
  animateNumber($("#uh-val-mem"), t.peakRssKb, (v) => formatKb(v));
  animateNumber($("#uh-val-io"), (t.ioReadBlocks ?? 0) + (t.ioWriteBlocks ?? 0), (v) =>
    Math.round(v).toLocaleString(),
  );
  animateBar($("#uh-bar-wall"), pctOf(t.wallMs, 1000)); // vs 1 s
  animateBar($("#uh-bar-cpu"), cpuPct); // meaningful: CPU as a share of wall
  animateBar($("#uh-bar-mem"), pctOf(t.peakRssKb, 131072)); // vs 128 MB
  animateBar($("#uh-bar-io"), pctOf((t.ioReadBlocks ?? 0) + (t.ioWriteBlocks ?? 0), 2048)); // vs 2048 blocks

  // Wire the pipeline stepper.
  const stepper = $("#uh-stepper");
  stepper.querySelectorAll<HTMLButtonElement>(".uh-step").forEach((btn) =>
    btn.addEventListener("click", () => {
      stepper.querySelectorAll(".uh-step").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      showPhase(btn.dataset.phase as PhaseKey);
    }),
  );
  showPhase("source");
}

function showPhase(key: PhaseKey) {
  const phase = UH_PHASES.find((p) => p.key === key);
  const blurb = $("#uh-phase-blurb");
  const viewer = $("#uh-viewer");
  const bin = $("#uh-bin");
  if (!phase) return;
  blurb.textContent = phase.blurb;
  // The binary-size line belongs only to the machine-code phase.
  bin.classList.toggle("hidden", key !== "machine");

  let text = "";
  if (key === "source") {
    text = uhSource.trim() ? uhSource : "(the editor was empty)";
  } else if (uhPipeline) {
    if (key === "mir") text = uhPipeline.mir;
    else if (key === "llvm") text = uhPipeline.llvmIr;
    else if (key === "asm") text = uhPipeline.asm;
    else if (key === "machine") text = uhPipeline.disasm;
  }

  // Honest fallback: if a phase is empty (e.g. MIR needs nightly, or objdump is
  // absent), show the pipeline's own notes rather than pretending we have output.
  if (key !== "source" && (!text || !text.trim())) {
    const note = (uhPipeline?.notes ?? "").trim();
    viewer.classList.add("empty");
    viewer.textContent =
      note ||
      "This phase isn't available on this toolchain (for example, MIR may need a nightly compiler, or the disassembly needs binutils/objdump).";
    return;
  }
  viewer.classList.remove("empty");
  viewer.textContent = text;
}

// ── Visualize execution (step-by-step tracer, "Python Tutor" style) ──────────
// Honesty: every step shown here is a REAL event emitted by the backend running
// Python under sys.settrace. This UI only plays back what the interpreter did —
// it never invents a line, a value, or a frame.

// Monaco language id for the visualizer editor, following the course language.
function vizMonacoLang(): string {
  return vizLanguage() === "rust" ? "rust" : "python";
}
// The code the visualizer starts with: for Rust, prefer whatever the student has
// in the main editor for the active step (so they trace their own work); fall
// back to a ready-made example when that is empty or just the concept placeholder.
function vizInitialCode(): string {
  if (vizLanguage() === "rust") {
    const cur = (editor?.getValue() ?? "").trim();
    if (cur && !/Read the concept on the right/.test(cur) && !/todo!\(/.test(cur)) {
      return editor.getValue();
    }
    return VIZ_DEFAULT_RUST;
  }
  return VIZ_DEFAULT_CODE;
}

function ensureVizEditor() {
  if (vizEditor) return;
  vizEditor = monaco.editor.create($("#viz-editor"), {
    value: vizInitialCode(),
    language: vizMonacoLang(),
    theme: "dxtutor-dark",
    automaticLayout: true,
    fontFamily: '"Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
    fontSize: 13,
    minimap: { enabled: false },
    stickyScroll: { enabled: false },
    scrollBeyondLastLine: false,
    glyphMargin: true, // room for the current-line arrow in the gutter
    padding: { top: 10 },
    tabSize: 4,
    renderWhitespace: "selection",
  });
  vizDecorations = vizEditor.createDecorationsCollection();
}

// The visualizer follows the course language. Python traces via sys.settrace and
// Rust via the backend's trace_execution("rust", …); any other language is still
// honest that live step-through isn't wired, rather than showing foreign code.
function vizLanguage(): string {
  return (profile?.language ?? "Rust").toLowerCase();
}
function vizLangLabel(): string {
  return profile?.language ?? "this language";
}
function vizSupported(): boolean {
  const l = vizLanguage();
  return l === "python" || l === "rust";
}

function openVisualize() {
  const overlay = $("#visualize-overlay");
  overlay.classList.remove("hidden");

  const body = overlay.querySelector<HTMLElement>(".viz-body")!;
  const left = overlay.querySelector<HTMLElement>(".viz-left")!;
  const runBtn = $("#viz-run") as HTMLButtonElement;
  const notes = $("#viz-notes");

  if (!vizSupported()) {
    // In a Rust course everything is about Rust: no Python. Say so honestly and
    // point to the compiler pipeline, which IS real on this host.
    vizPause();
    left.classList.add("hidden");
    body.classList.add("solo");
    runBtn.classList.add("hidden");
    $("#viz-transport").classList.add("hidden");
    $("#viz-player").classList.add("hidden");
    notes.classList.remove("hidden");
    notes.innerHTML = `<div class="viz-note">
      <p><strong>Live step-through for ${esc(vizLangLabel())} is coming</strong> — it needs source
      instrumentation, and this host has no <code>gdb</code>/<code>lldb</code>.</p>
      <p>Meanwhile, see the compiler pipeline in <strong>&#128300; Under the hood</strong>.</p>
    </div>`;
    return;
  }

  // Supported (Python): restore the two-column tracer layout.
  left.classList.remove("hidden");
  body.classList.remove("solo");
  runBtn.classList.remove("hidden");
  ensureVizEditor();
  // Lay out now that the container is visible, and focus the editor.
  requestAnimationFrame(() => {
    vizEditor?.layout();
    vizEditor?.focus();
  });
}

function closeVisualize() {
  vizPause();
  $("#visualize-overlay").classList.add("hidden");
}

// Reconstruct a call-stack snapshot for every step from the real depth/func/event
// stream, so stepping backward and forward is deterministic.
function buildVizFrames(steps: TraceStepDto[]): string[][] {
  const stack: string[] = [];
  const out: string[][] = [];
  for (const s of steps) {
    stack[s.depth] = s.func || "?";
    stack.length = s.depth + 1; // a deeper frame can never outlive a shallower one
    out.push(stack.slice());
    if (s.event === "return") stack.length = s.depth; // the frame is leaving
  }
  return out;
}

async function runVisualize() {
  const code = vizEditor ? vizEditor.getValue() : VIZ_DEFAULT_CODE;
  vizPause();
  const runBtn = $("#viz-run") as HTMLButtonElement;
  const spinner = $("#viz-spinner");
  const notes = $("#viz-notes");
  const player = $("#viz-player");
  const transport = $("#viz-transport");

  // Reset the view while we work.
  player.classList.add("hidden");
  transport.classList.add("hidden");
  notes.classList.remove("hidden");
  notes.innerHTML = `<span class="spinner viz-inline-spinner"></span> Tracing your program…`;
  runBtn.disabled = true;
  spinner.classList.remove("hidden");

  if (!hasTauri) {
    spinner.classList.add("hidden");
    runBtn.disabled = false;
    notes.innerHTML = `<strong>Visualize execution</strong> runs your ${esc(
      vizLangLabel(),
    )} program step by step through the real backend, so it works only inside the
      app (<code>npm run tauri dev</code>). Nothing here is simulated.`;
    return;
  }

  try {
    const trace = await invoke<ExecutionTraceDto>("trace_execution", {
      language: vizLanguage(),
      code,
    });
    if (!trace.supported) {
      notes.innerHTML = `<div class="viz-note">${
        trace.notes ? renderMarkdown(trace.notes) : "<p>This program can't be traced.</p>"
      }</div>`;
      return;
    }
    if (!trace.steps || trace.steps.length === 0) {
      notes.innerHTML = `<div class="viz-note"><p>The trace finished with no steps to show.</p>${
        trace.notes ? renderMarkdown(trace.notes) : ""
      }</div>`;
      return;
    }
    // Ready: prime the player.
    vizSteps = trace.steps;
    vizStdout = trace.stdout ?? "";
    vizFrames = buildVizFrames(vizSteps);
    vizIdx = 0;
    vizPrevVars = new Map();
    notes.classList.add("hidden");
    player.classList.remove("hidden");
    transport.classList.remove("hidden");
    renderVizStep(true);
  } catch (e) {
    notes.innerHTML = `<div class="viz-note error">Couldn't trace this program:
      <code>${esc(String(e))}</code></div>`;
  } finally {
    spinner.classList.add("hidden");
    runBtn.disabled = false;
  }
}

function vizGoto(idx: number) {
  const clamped = Math.max(0, Math.min(vizSteps.length - 1, idx));
  if (clamped === vizIdx) {
    // still refresh on first paint
    renderVizStep(false);
    return;
  }
  vizIdx = clamped;
  renderVizStep(false);
  if (vizPlaying && vizIdx >= vizSteps.length - 1) vizPause();
}

function vizStepForward() {
  vizPause();
  vizGoto(vizIdx + 1);
}
function vizStepBack() {
  vizPause();
  vizGoto(vizIdx - 1);
}

function vizSpeedDelayMs(): number {
  const slider = $("#viz-speed") as HTMLInputElement;
  const v = Number(slider.value) || 5; // 1 (slow) .. 10 (fast)
  // 1 → 1500ms, 10 → 220ms. Honour reduced-motion with a calmer floor.
  const base = 1500 - (v - 1) * ((1500 - 220) / 9);
  return reduceMotion ? Math.max(base, 700) : base;
}

function vizPlay() {
  if (vizPlaying) return;
  if (vizIdx >= vizSteps.length - 1) vizIdx = 0; // replay from the top
  vizPlaying = true;
  updateVizPlayBtn();
  const tick = () => {
    if (!vizPlaying) return;
    if (vizIdx >= vizSteps.length - 1) {
      vizPause();
      return;
    }
    vizIdx += 1;
    renderVizStep(false);
    vizTimer = window.setTimeout(tick, vizSpeedDelayMs());
  };
  vizTimer = window.setTimeout(tick, vizSpeedDelayMs());
}

function vizPause() {
  vizPlaying = false;
  if (vizTimer !== undefined) {
    window.clearTimeout(vizTimer);
    vizTimer = undefined;
  }
  updateVizPlayBtn();
}

function vizTogglePlay() {
  if (vizPlaying) vizPause();
  else vizPlay();
}

function updateVizPlayBtn() {
  const btn = $("#viz-play");
  btn.innerHTML = vizPlaying
    ? `&#10073;&#10073;&nbsp;${esc(t("viz.pause"))}`
    : `&#9654;&nbsp;${esc(t("viz.play"))}`;
  btn.classList.toggle("playing", vizPlaying);
}

// Paint the editor highlight + the three panels for the current step.
function renderVizStep(firstPaint: boolean) {
  const step = vizSteps[vizIdx];
  if (!step || !vizEditor) return;

  // 1) Highlight the current line + gutter arrow, and scroll it into view.
  vizDecorations?.set([
    {
      range: new monaco.Range(step.line, 1, step.line, 1),
      options: {
        isWholeLine: true,
        className: "viz-line-active",
        glyphMarginClassName: "viz-glyph-arrow",
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    },
  ]);
  vizEditor.revealLineInCenterIfOutsideViewport(step.line, monaco.editor.ScrollType.Smooth);

  // 2) Variables panel, flashing the ones whose value changed since last paint.
  const vars = $("#viz-vars");
  const nowVars = new Map<string, string>();
  for (const v of step.locals) nowVars.set(v.name, v.value);
  if (step.locals.length === 0) {
    vars.innerHTML = `<div class="viz-empty">No locals in this frame yet.</div>`;
  } else {
    vars.innerHTML = step.locals
      .map((v) => {
        const prev = vizPrevVars.get(v.name);
        const changed = !firstPaint && prev !== v.value; // new or mutated
        return `<div class="viz-var${changed ? " changed" : ""}">
            <span class="viz-var-name">${esc(v.name)}</span>
            <span class="viz-var-eq">=</span>
            <span class="viz-var-value">${esc(v.value)}</span>
            <span class="viz-var-ty">${esc(v.ty)}</span>
          </div>`;
      })
      .join("");
  }
  vizPrevVars = nowVars;

  // 3) Call stack — innermost frame on top, annotated with the live event.
  const frames = vizFrames[vizIdx] ?? [step.func];
  const evtTag =
    step.event === "call" ? "call" : step.event === "return" ? "return" : "line";
  const stack = $("#viz-stack");
  stack.innerHTML = frames
    .map((name, d) => {
      const top = d === frames.length - 1;
      return `<div class="viz-frame${top ? " top" : ""}">
          <span class="viz-frame-depth">${d}</span>
          <span class="viz-frame-name">${esc(name)}</span>
          ${top ? `<span class="viz-frame-evt ${evtTag}">${evtTag}</span>` : ""}
        </div>`;
    })
    .reverse()
    .join("");

  // 4) Output — stdout accumulated up to this step.
  const out = $("#viz-output");
  const slice = vizStdout.slice(0, Math.max(0, step.stdoutLen));
  out.textContent = slice;
  if (slice) out.scrollTop = out.scrollHeight;

  // 5) Transport state: progress + button enablement.
  const n = vizSteps.length;
  $("#viz-progress-label").textContent = `${vizIdx + 1} / ${n}`;
  const fill = $("#viz-progress-fill");
  fill.style.width = `${n > 1 ? (vizIdx / (n - 1)) * 100 : 100}%`;
  ($("#viz-back") as HTMLButtonElement).disabled = vizIdx <= 0;
  ($("#viz-fwd") as HTMLButtonElement).disabled = vizIdx >= n - 1;
}

// ── Results pane / panels / spinner ──────────────────────────────────────────

function showResults(): HTMLElement {
  const content = $("#results-content");
  $("#results-empty").classList.add("hidden");
  content.classList.remove("hidden");
  return content;
}

function renderError(where: string, message: string) {
  const content = showResults();
  const block = document.createElement("div");
  block.className = "error-block";
  block.textContent = `${where}: ${message}`;
  content.prepend(block);
}

function toggleTerminal(force?: boolean) {
  // The dock lives at #body level and overlays the editor column in BOTH modes, so the
  // terminal (and the session shell) are reachable from Learning and Workspace alike.
  const open = force ?? !document.body.classList.contains("term-open");
  document.body.classList.toggle("term-open", open);
  requestAnimationFrame(() => {
    editor?.layout();
    if (open) fitTerminal();
  });
}

// ── Panel tabs: Terminal | Problems (real Monaco markers) ─────────────────────

/** Switch the bottom panel tab. Problems overlays the terminal (which stays mounted). */
function setPanelTab(tab: "terminal" | "problems"): void {
  document.querySelectorAll("#panel-tabs .ptab").forEach((b) =>
    b.classList.toggle("active", (b as HTMLElement).dataset.ptab === tab),
  );
  document.getElementById("panel-problems")?.classList.toggle("hidden", tab !== "problems");
  if (tab === "problems") renderProblems();
}

/** Populate the Problems list from the REAL Monaco markers (rust-analyzer diagnostics +
 *  Review findings) and keep the tab's count badge fresh. Click a row → jump to it. */
function renderProblems(): void {
  const host = document.getElementById("panel-problems");
  const countEl = document.getElementById("problems-count");
  const markers = monaco.editor
    .getModelMarkers({})
    .filter((m) => m.severity >= monaco.MarkerSeverity.Warning);
  markers.sort(
    (a, b) =>
      b.severity - a.severity ||
      a.resource.path.localeCompare(b.resource.path) ||
      a.startLineNumber - b.startLineNumber,
  );
  if (countEl) countEl.textContent = markers.length ? String(markers.length) : "";
  if (!host) return;
  if (!markers.length) {
    host.innerHTML = `<div class="prob-empty">Nenhum problema detectado.</div>`;
    return;
  }
  host.innerHTML = markers
    .map((m) => {
      const sev =
        m.severity === monaco.MarkerSeverity.Error ? "e" : m.severity === monaco.MarkerSeverity.Warning ? "w" : "i";
      const glyph = sev === "e" ? "✖" : sev === "w" ? "⚠" : "ℹ";
      const path = decodeURIComponent(m.resource.path);
      const name = path.split("/").pop() ?? path;
      return (
        `<div class="prob-row" data-path="${esc(path)}" data-line="${m.startLineNumber}">` +
        `<span class="prob-ic ${sev}">${glyph}</span>` +
        `<span class="prob-msg">${esc(m.message)}</span>` +
        `<span class="prob-loc">${esc(name)}:${m.startLineNumber}</span></div>`
      );
    })
    .join("");
}

let busy = false;
function setBusy(on: boolean) {
  busy = on;
  $("#spinner").classList.toggle("hidden", !on);
  ($("#btn-run") as HTMLButtonElement).disabled = on;
  ($("#btn-hint") as HTMLButtonElement).disabled = on;
}

// ── Toast feedback ───────────────────────────────────────────────────────────

function toast(html: string, kind: "points" | "unit") {
  const host = $("#toast-host");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = html;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  window.setTimeout(() => {
    el.classList.remove("show");
    window.setTimeout(() => el.remove(), 300);
  }, 2600);
}

// ── Onboarding ───────────────────────────────────────────────────────────────

// Popular languages we advertise as "coming soon" while no embedded course
// exists for them yet. The moment `list_courses` returns a course for one of
// these, it is promoted to an available card automatically (see showOnboarding)
// — no edit here needed, so this is purely roadmap context.
const COMING_SOON_LANGS = ["python", "javascript", "c"];
let pendingLanguage: string | null = null;
const pendingLevels = new Set<string>();

// Map a backend course language onto a display name + icon. LANG_META is the
// single source of presentation metadata; a language the frontend has never
// heard of still gets a readable, title-cased name and a neutral glyph so a
// brand-new embedded course surfaces without any hardcoding here.
function langPresentation(language: string): { name: string; glyph: string } {
  const key = language.trim().toLowerCase();
  const meta = LANG_META[key];
  const name = meta?.name ?? (language.trim().charAt(0).toUpperCase() + language.trim().slice(1));
  const glyph = meta?.glyph ?? "&#128187;"; // laptop — neutral fallback icon
  return { name, glyph };
}

async function showOnboarding() {
  const overlay = $("#onboarding");
  overlay.classList.remove("hidden");
  showOnbScreen("language");
  pendingLevels.clear();
  pendingLanguage = null;

  // Available languages are data-driven: pull the embedded catalogue and build
  // one card per distinct language (dedupe so several curricula for the same
  // language collapse into one). If the brain is unreachable (e.g. opened
  // outside Tauri) we fall back to a minimal honest set instead of crashing.
  let catalogue: CourseSummaryDto[] = [];
  let fellBack = false;
  if (hasTauri) {
    try {
      catalogue = await invoke<CourseSummaryDto[]>("list_courses");
    } catch (e) {
      console.error("list_courses failed:", e);
      fellBack = true;
    }
  } else {
    fellBack = true;
  }

  const seen = new Set<string>();
  const available: { id: string; name: string; glyph: string; blurb: string }[] = [];
  for (const c of catalogue) {
    const key = c.language.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const { name, glyph } = langPresentation(c.language);
    // Keep the exact backend language string as the id so it round-trips to
    // get_course (which matches case-insensitively).
    available.push({ id: c.language, name, glyph, blurb: (c.summary || c.title || "").trim() });
  }
  if (available.length === 0) {
    // Minimal fallback — Rust is always part of the catalogue in the real app.
    const { name, glyph } = langPresentation("rust");
    available.push({
      id: "rust",
      name,
      glyph,
      blurb: "Offline fallback — the full catalogue loads inside the app.",
    });
    seen.add("rust");
  }

  // Curated "coming soon" cards: only languages that do not already have a
  // course (so promotion to available happens for free when a course appears).
  const soon = COMING_SOON_LANGS.filter((id) => !seen.has(id)).map((id) => ({
    id,
    ...langPresentation(id),
  }));

  const langHost = $("#onb-languages");
  langHost.innerHTML = "";
  for (const lang of available) {
    const card = document.createElement("button");
    card.className = "onb-lang";
    card.type = "button";
    card.innerHTML = `<span class="onb-lang-glyph">${lang.glyph}</span>
      <span class="onb-lang-label">${esc(lang.name)}</span>
      ${lang.blurb ? `<span class="onb-lang-blurb">${esc(lang.blurb)}</span>` : ""}
      <span class="onb-lang-tag ok">${esc(t("onb.available"))}</span>`;
    card.addEventListener("click", () => {
      pendingLanguage = lang.id;
      showOnbScreen("level");
    });
    langHost.appendChild(card);
  }
  for (const lang of soon) {
    const card = document.createElement("button");
    card.className = "onb-lang soon";
    card.type = "button";
    card.disabled = true;
    card.innerHTML = `<span class="onb-lang-glyph">${lang.glyph}</span>
      <span class="onb-lang-label">${esc(lang.name)}</span>
      <span class="onb-lang-tag">${esc(t("onb.comingSoon"))}</span>`;
    langHost.appendChild(card);
  }
  if (fellBack) {
    const note = document.createElement("p");
    note.className = "onb-fallback-note";
    note.textContent = t("onb.fallbackNote");
    langHost.appendChild(note);
  }

  const startBtn = $<HTMLButtonElement>("#onb-start");
  const syncStart = () => {
    startBtn.disabled = pendingLevels.size === 0;
  };

  const lvlHost = $("#onb-levels");
  lvlHost.innerHTML = "";
  for (const id of LEVEL_IDS) {
    const btn = document.createElement("button");
    btn.className = "onb-level";
    btn.type = "button";
    btn.setAttribute("role", "checkbox");
    btn.setAttribute("aria-checked", "false");
    btn.dataset.level = id;
    btn.innerHTML = `<span class="onb-level-text">
        <span class="onb-level-name">${esc(levelLabel(id))}</span>
        <span class="onb-level-blurb">${esc(levelBlurb(id))}</span>
      </span>
      <span class="onb-level-box" aria-hidden="true">&#10003;</span>`;
    btn.addEventListener("click", () => {
      const on = !pendingLevels.has(id);
      if (on) pendingLevels.add(id);
      else pendingLevels.delete(id);
      btn.classList.toggle("selected", on);
      btn.setAttribute("aria-checked", String(on));
      syncStart();
    });
    lvlHost.appendChild(btn);
  }
  syncStart();

  startBtn.onclick = () => {
    if (!pendingLanguage || pendingLevels.size === 0) return;
    const levels = LEVEL_IDS.filter((id) => pendingLevels.has(id));
    void finishOnboarding({ language: pendingLanguage, levels });
  };
}

function showOnbScreen(which: "language" | "level") {
  document.querySelectorAll<HTMLElement>(".onb-screen").forEach((el) =>
    el.classList.toggle("hidden", el.dataset.screen !== which),
  );
}

async function finishOnboarding(p: Profile) {
  profile = p;
  saveProfile(p);
  $("#onboarding").classList.add("hidden");
  await loadCourse();
}

// Reset profile → wipe progress for a clean restart and re-show onboarding.
function resetProfile() {
  const ok = window.confirm(
    "Change course? This clears your saved profile, points and progress on this device.",
  );
  if (!ok) return;
  localStorage.removeItem(LS.profile);
  localStorage.removeItem(LS.points);
  localStorage.removeItem(LS.done);
  localStorage.removeItem(LS.stats);
  localStorage.removeItem(LS.code);
  localStorage.removeItem(LS.openUnits);
  profile = null;
  course = null;
  activeStepId = null;
  points = 0;
  done.clear();
  stats = {};
  codeByStep = {};
  openUnits = {};
  placeholderRevealed.clear();
  briefed.clear();
  studyOffered.clear();
  glossary = [];
  glossaryMap.clear();
  models.forEach((m) => m.dispose());
  models.clear();
  updateStatusBar();
  void showOnboarding();
}

// ── Course load ──────────────────────────────────────────────────────────────

async function loadCourse() {
  if (!profile) return;
  if (!hasTauri) {
    $("#project-title").textContent = "Native backend unavailable";
    renderError(
      "Startup",
      "The Delonix Tutor brain is reachable only inside the Tauri app. Run `npm run tauri dev`.",
    );
    return;
  }
  try {
    course = await invoke<CourseDto>("get_course", { language: profile.language });
    void loadGlossary(); // populate the 📖 panel + hover popover (best-effort)
    renderSidebar();
    const startId = currentStepId();
    const start = stepById(startId);
    if (start) openStep(start);
  } catch (e) {
    renderError("Startup", String(e));
  }
}

// ── Terminal (xterm ↔ PTY over Tauri) ────────────────────────────────────────

let term: Terminal;
let fitAddon: FitAddon;
let ptyReady = false;
let runProjectTestsRef: () => void = () => {}; // set in init; used by the command palette

function fitTerminal() {
  if (fitAddon && term) {
    try {
      fitAddon.fit();
      if (ptyReady) void invoke("pty_resize", { rows: term.rows, cols: term.cols });
    } catch {
      /* terminal not visible yet */
    }
  }
}

async function setupTerminal() {
  term = new Terminal({
    fontFamily: '"Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: "#181818", foreground: "#cccccc", cursor: "#ffffff" },
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open($("#panel-terminal"));
  fitTerminal();

  if (!hasTauri) {
    term.writeln("\x1b[33mDelonix Tutor terminal — native PTY unavailable in the browser.\x1b[0m");
    term.writeln("Run the app with \x1b[1mnpm run tauri dev\x1b[0m to get a real bash shell.");
    return;
  }

  await listen<string>("pty://data", (ev) => term.write(ev.payload));
  await listen<number>("pty://exit", (ev) => {
    term.writeln(`\r\n\x1b[90m[process exited: ${ev.payload}]\x1b[0m`);
    ptyReady = false;
  });
  term.onData((data) => {
    if (ptyReady) void invoke("pty_write", { data });
  });

  try {
    await invoke("pty_spawn", { rows: term.rows, cols: term.cols });
    ptyReady = true;
  } catch (e) {
    term.writeln(`\r\n\x1b[31mFailed to start shell: ${esc(String(e))}\x1b[0m`);
  }
  window.addEventListener("resize", fitTerminal);
}

/** Open the terminal panel and attach it to the project's persistent container session —
 *  a live interactive shell INSIDE the devcontainer (replaces the current PTY session). */
async function attachSessionTerminal(root: string) {
  toggleTerminal(true);
  if (!hasTauri || !term) return;
  requestAnimationFrame(() => fitTerminal());
  term.clear();
  term.writeln("\x1b[90mattaching to container session…\x1b[0m");
  try {
    await invoke("pty_spawn_in_session", { rows: term.rows, cols: term.cols, root });
    ptyReady = true;
    term.focus();
  } catch (e) {
    term.writeln(`\r\n\x1b[31m${esc(String(e))}\x1b[0m`);
  }
}

/** Reflect a running container session in the status bar (persists across restarts, since
 *  the container keeps running) — click to re-attach a terminal to it. */
async function refreshSessionStatus() {
  const chip = document.getElementById("status-session");
  if (!chip) return;
  const root = workspaceRoot();
  if (!root || !hasTauri) {
    chip.classList.add("hidden");
    return;
  }
  try {
    const st = await invoke<{ running: boolean }>("devcontainer_session_status", { root });
    chip.classList.toggle("hidden", !st.running);
  } catch {
    chip.classList.add("hidden");
  }
}

// ── Mode toggle (Learning ↔ Workspace) ───────────────────────────────────────

type AppMode = "learning" | "workspace";
const MODE_KEY = "dxtutor.mode";
let appMode: AppMode = "learning";

function loadMode(): AppMode {
  return localStorage.getItem(MODE_KEY) === "workspace" ? "workspace" : "learning";
}

function setMode(mode: AppMode) {
  appMode = mode;
  localStorage.setItem(MODE_KEY, mode);
  const ws = mode === "workspace";
  if (ws) void refreshGitBranch(); // show the branch in the status bar when working on a project

  document.body.classList.toggle("mode-workspace", ws);
  document.body.classList.toggle("mode-learning", !ws);

  // Swap the visible surfaces. `.hidden` carries !important, so toggle it
  // directly rather than relying on body-class display rules to win.
  $("#editor-main").classList.toggle("hidden", ws);
  $("#ws-main").classList.toggle("hidden", !ws);
  $("#learning-sidebar").classList.toggle("hidden", ws);
  $("#workspace-sidebar").classList.toggle("hidden", !ws);

  // Activity bar: light the mode-owning button; others keep their own behaviour.
  document.querySelectorAll(".act[data-mode]").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.mode === mode);
  });

  // Observable mode + active-project indicator (RF-UI-04).
  const modeEl = document.getElementById("status-mode");
  if (modeEl) {
    const name = workspaceRoot()?.split(/[\\/]/).filter(Boolean).pop();
    modeEl.textContent = ws ? (name ? `Project · ${name}` : "Project") : "Learning";
  }
  if (ws) {
    activateWorkspace();
    void refreshSessionStatus(); // surface a running container session (persists across restarts)
  } else {
    // Returning to Learning: relayout the guided editor (it was hidden).
    requestAnimationFrame(() => editor?.layout());
  }
}

// ── Run and Debug target ──────────────────────────────────────────────────────
// What the 🐞 debugger steps through: in Learning mode the current step's editor
// code (course language); in Workspace mode the active file (language by
// extension). The debugger traces this with the SAME backend `trace_execution`.
/** Render the Breakpoints list in the Run and Debug view (toggle / remove / jump). */
function renderBreakpointsPanel(): void {
  const host = document.getElementById("bp-list");
  if (!host) return;
  const bps = allBreakpoints();
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  if (bps.length === 0) {
    host.innerHTML = `<div class="bp-empty">No breakpoints. Click the editor gutter (Alt+click for a condition).</div>`;
    return;
  }
  host.innerHTML = bps
    .map(
      (b) =>
        `<div class="bp-row${b.enabled ? "" : " off"}" data-path="${esc(b.path)}" data-line="${b.line}" title="${esc(b.path)}:${b.line}">` +
        `<input type="checkbox" class="bp-toggle" ${b.enabled ? "checked" : ""} aria-label="Enabled" />` +
        `<span class="bp-loc">${esc(b.name)}:${b.line}</span>` +
        (b.condition ? `<span class="bp-cond" title="condition">${esc(b.condition)}</span>` : "") +
        `<button class="bp-remove" title="Remove">✕</button></div>`,
    )
    .join("");
}

function currentDebugTarget(): DebugTarget | null {
  if (appMode === "workspace") {
    return workspaceActions.debugTarget();
  }
  const code = editor?.getValue() ?? "";
  const lang = (profile?.language ?? "Rust").toLowerCase();
  return {
    code,
    title: currentStep()?.title ?? "Current exercise",
    monacoLang: lang,
    traceLang: lang,
  };
}

// ── Menu bar (File / Run drop-downs) ──────────────────────────────────────────

function closeMenus() {
  document.getElementById("menu-dropdown")?.remove();
  document.querySelectorAll(".menu span[data-menu]").forEach((s) => s.classList.remove("open"));
}

type MenuItem = { label: string; key?: string; chev?: boolean; run: () => void } | "sep";

let menuToastTimer: number | undefined;
/** A small transient notice for menu items without a dedicated surface. */
function menuToast(msg: string): void {
  let el = document.getElementById("dx-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "dx-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  window.clearTimeout(menuToastTimer);
  menuToastTimer = window.setTimeout(() => el?.classList.remove("show"), 1900);
}

/** The Monaco editor a menu command should act on: the focused one, else the first with a model. */
function menuEditor(): monaco.editor.ICodeEditor | undefined {
  const eds = monaco.editor.getEditors();
  return eds.find((e) => e.hasTextFocus()) ?? eds.find((e) => e.getModel()) ?? eds[0];
}
const trig = (id: string) => menuEditor()?.trigger("menu", id, null);
const clickBtn = (sel: string): boolean => {
  const el = document.querySelector(sel) as HTMLButtonElement | null;
  el?.click();
  return !!el;
};

function openMenu(anchor: HTMLElement, items: MenuItem[]) {
  closeMenus();
  anchor.classList.add("open");
  const dd = document.createElement("div");
  dd.id = "menu-dropdown";
  dd.className = "menu-dropdown";
  dd.innerHTML = items
    .map((it, i) =>
      it === "sep"
        ? `<div class="menu-sep"></div>`
        : `<button class="menu-item" data-i="${i}"><span class="mi-label">${esc(it.label)}</span>` +
          (it.key ? `<span class="mi-key">${esc(it.key)}</span>` : "") +
          (it.chev ? `<span class="mi-chev">›</span>` : "") +
          `</button>`,
    )
    .join("");
  const rect = anchor.getBoundingClientRect();
  dd.style.left = `${rect.left}px`;
  dd.style.top = `${rect.bottom}px`;
  document.body.appendChild(dd);
  dd.querySelectorAll(".menu-item").forEach((btn) =>
    btn.addEventListener("click", () => {
      const i = Number((btn as HTMLElement).dataset.i);
      const it = items[i];
      closeMenus();
      if (it !== "sep") it.run();
    }),
  );
}

function wireMenus() {
  // Full VSCode-style menu bar (File/Edit/Selection/View/Go/Run/Terminal/Help), matching the
  // dxtutor-IDE prototype. Items wire to REAL actions where the app has them (save/open/run,
  // debug, terminal, the Monaco editor commands and the activity views); items the app does
  // not back yet show an honest toast rather than a dead click. Built per-open so labels
  // follow the active locale.
  const soon = (label: string) => menuToast(`${label} — ainda não disponível`);
  const buildMenus = (): Record<string, MenuItem[]> => ({
    file: [
      { label: t("menu.newFile"), key: "Ctrl+N", run: workspaceActions.newFile },
      { label: "New Window", key: "Ctrl+Shift+N", run: () => soon("New Window") },
      "sep",
      { label: "Open File…", key: "Ctrl+O", run: workspaceActions.openFolder },
      { label: t("menu.openFolder"), run: workspaceActions.openFolder },
      { label: "Open Recent", chev: true, run: () => soon("Open Recent") },
      "sep",
      { label: t("menu.save"), key: "Ctrl+S", run: workspaceActions.save },
      { label: "Save As…", key: "Ctrl+Shift+S", run: () => soon("Save As") },
      { label: t("menu.saveAll"), run: workspaceActions.saveAll },
      "sep",
      { label: "Exit", key: "Ctrl+Q", run: () => soon("Exit") },
    ],
    edit: [
      { label: "Undo", key: "Ctrl+Z", run: () => trig("undo") },
      { label: "Redo", key: "Ctrl+Y", run: () => trig("redo") },
      "sep",
      { label: "Cut", key: "Ctrl+X", run: () => trig("editor.action.clipboardCutAction") },
      { label: "Copy", key: "Ctrl+C", run: () => trig("editor.action.clipboardCopyAction") },
      { label: "Paste", key: "Ctrl+V", run: () => trig("editor.action.clipboardPasteAction") },
      "sep",
      { label: "Find", key: "Ctrl+F", run: () => trig("actions.find") },
      { label: "Replace", key: "Ctrl+H", run: () => trig("editor.action.startFindReplaceAction") },
      "sep",
      { label: "Rename Symbol", key: "F2", run: () => trig("editor.action.rename") },
      { label: "Format Document", key: "Shift+Alt+F", run: () => trig("editor.action.formatDocument") },
    ],
    selection: [
      { label: "Select All", key: "Ctrl+A", run: () => trig("editor.action.selectAll") },
      "sep",
      { label: "Copy Line Down", key: "Ctrl+Shift+Alt+↓", run: () => trig("editor.action.copyLinesDownAction") },
      { label: "Move Line Up", key: "Alt+↑", run: () => trig("editor.action.moveLinesUpAction") },
      { label: "Move Line Down", key: "Alt+↓", run: () => trig("editor.action.moveLinesDownAction") },
      "sep",
      { label: "Add Cursor Above", key: "Ctrl+Alt+↑", run: () => trig("editor.action.insertCursorAbove") },
      { label: "Add Cursor Below", key: "Ctrl+Alt+↓", run: () => trig("editor.action.insertCursorBelow") },
    ],
    view: [
      { label: "Command Palette…", key: "Ctrl+Shift+P", run: () => trig("editor.action.quickCommand") },
      "sep",
      { label: "Explorer", run: () => { if (!clickBtn('.act[data-view="workspace"]')) setMode("workspace"); } },
      { label: "Search", run: () => openSearch() },
      { label: "Source Control", run: () => openGit() },
      { label: "Testing", run: () => openTests() },
      "sep",
      { label: "Terminal", key: "Ctrl+`", run: () => toggleTerminal() },
      { label: "Problems", run: () => soon("Problems") },
    ],
    go: [
      { label: "Go to File…", key: "Ctrl+P", run: () => trig("editor.action.quickCommand") },
      { label: "Go to Symbol…", key: "Ctrl+Shift+O", run: () => trig("editor.action.quickOutline") },
      { label: "Go to Line/Column…", key: "Ctrl+G", run: () => trig("editor.action.gotoLine") },
      "sep",
      { label: "Go to Definition", key: "F12", run: () => trig("editor.action.revealDefinition") },
      { label: "Go Back", key: "Alt+←", run: () => trig("editor.action.navigateBack") },
      { label: "Go Forward", key: "Alt+→", run: () => trig("editor.action.navigateForward") },
    ],
    run: [
      { label: "Start Debugging", key: "F5", run: () => clickBtn("#ws-btn-debug") },
      { label: "Run Without Debugging", key: "Ctrl+F5", run: workspaceActions.run },
      { label: "Stop", key: "Shift+F5", run: () => soon("Stop") },
      "sep",
      { label: "Toggle Breakpoint", key: "F9", run: () => soon("Toggle Breakpoint") },
      "sep",
      { label: "Run Task…", chev: true, run: () => soon("Run Task") },
    ],
    terminal: [
      { label: "New Terminal", key: "Ctrl+Shift+`", run: () => toggleTerminal(true) },
      { label: "Split Terminal", key: "Ctrl+Shift+5", run: () => soon("Split Terminal") },
      "sep",
      { label: "Run Task…", run: () => soon("Run Task") },
      { label: "Run Build Task…", key: "Ctrl+Shift+B", run: workspaceActions.run },
      "sep",
      { label: "Clear", run: () => soon("Clear") },
    ],
    help: [
      { label: "Welcome", run: () => soon("Welcome") },
      { label: "Documentation", run: () => soon("Documentation") },
      "sep",
      { label: "About dxtutor", run: () => menuToast("dxtutor IDE — tutor de programação com LSP real") },
    ],
  });
  document.querySelectorAll<HTMLElement>(".menu span[data-menu]").forEach((span) => {
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = span.dataset.menu!;
      // A click on an already-open menu closes it (VSCode-style toggle).
      if (span.classList.contains("open")) {
        closeMenus();
        return;
      }
      // Switching to Workspace mode on first File/Run use makes the actions visible.
      if (appMode !== "workspace") setMode("workspace");
      openMenu(span, buildMenus()[key] ?? []);
    });
  });
  window.addEventListener("click", closeMenus);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenus();
  });
}

// ── Window decorator (real min / max·restore / close + drag) ─────────────────
// The titlebar is our own chrome (the OS decorations are off), so the controls
// drive the Tauri window directly. In a plain browser (no Tauri) there is no
// window to drive, so we neutralise the controls and the drag region.
// Window controls (minimize / maximize / close) and dragging come from the
// native OS titlebar (Tauri `decorations: true`). No custom window chrome.

// ── Bootstrap ────────────────────────────────────────────────────────────────

function hideBoot() {
  const boot = document.getElementById("boot");
  if (!boot) return;
  boot.classList.add("boot-hiding");
  window.setTimeout(() => boot.remove(), 400);
}

function wireChrome() {
  $("#btn-run").addEventListener("click", () => {
    const s = currentStep();
    if (!s) return;
    if (s.kind === "drill") void runDrillGated(s);
    else void submitChallenge(s);
  });
  $("#btn-hint").addEventListener("click", () => void requestHint());
  $("#btn-continue").addEventListener("click", () => {
    const s = currentStep();
    if (s) continueStep(s);
  });
  $("#btn-next").addEventListener("click", () => focusNext());
  $("#btn-start").addEventListener("click", () => startStep());
  $("#btn-term-close").addEventListener("click", () => toggleTerminal(false));
  // Panel tabs (Terminal | Problems). Problems is populated live from Monaco markers.
  document.querySelectorAll("#panel-tabs .ptab").forEach((b) =>
    b.addEventListener("click", () => setPanelTab((b as HTMLElement).dataset.ptab as "terminal" | "problems")),
  );
  document.getElementById("panel-problems")?.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".prob-row") as HTMLElement | null;
    if (row?.dataset.path) void openFileAt(row.dataset.path, Number(row.dataset.line) || 1, 1);
  });
  // Keep the Problems count + list in sync as diagnostics change.
  monaco.editor.onDidChangeMarkers(() => renderProblems());
  renderProblems(); // initial count
  // Title-bar right extras (prototype parity).
  document.getElementById("tb-update")?.addEventListener("click", () => menuToast("Já tens a versão mais recente ✓"));
  document.getElementById("tb-toggle-panel")?.addEventListener("click", () => toggleTerminal());
  document.getElementById("tb-toggle-agent")?.addEventListener("click", (e) => {
    (e.currentTarget as HTMLElement).classList.toggle("on");
    clickBtn('.act[data-view="assistant"]');
  });
  document.getElementById("tb-account")?.addEventListener("click", () => menuToast("angolar.devops — Plano Max"));
  // Frameless window (decorations:false) → our own min/max/close in the titlebar, so the app
  // has ONE integrated bar like the prototype (no second native OS titlebar on top).
  if ("__TAURI_INTERNALS__" in window) {
    const appWin = getCurrentWindow();
    document.getElementById("win-min")?.addEventListener("click", () => void appWin.minimize());
    document.getElementById("win-max")?.addEventListener("click", () => void appWin.toggleMaximize());
    document.getElementById("win-close")?.addEventListener("click", () => void appWin.close());
    const syncMax = () =>
      void appWin.isMaximized().then((m) => document.getElementById("win-max")?.classList.toggle("is-max", m));
    syncMax();
    void appWin.onResized(syncMax);
  }
  $("#btn-reset-profile").addEventListener("click", (e) => {
    e.stopPropagation(); // don't also toggle the section header underneath
    resetProfile();
  });

  // LEARNING TRACK section header: collapse / expand the whole track (VSCode-style).
  const sectionTitle = $("#project-title");
  const toggleSection = () => {
    const sidebar = $("#sidebar");
    const collapsed = sidebar.classList.toggle("track-collapsed");
    sectionTitle.setAttribute("aria-expanded", String(!collapsed));
  };
  sectionTitle.addEventListener("click", toggleSection);
  sectionTitle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleSection();
    }
  });
  $("#onb-back").addEventListener("click", () => showOnbScreen("language"));

  // Glossary panel (📖 activity button) + study-guide overlay chrome.
  $("#gloss-close").addEventListener("click", closeGlossary);
  $<HTMLInputElement>("#gloss-search").addEventListener("input", (e) =>
    renderGlossaryList((e.target as HTMLInputElement).value),
  );
  $("#study-close").addEventListener("click", closeStudyGuide);

  // Settings overlay: close, backdrop dismiss, sandbox-engine radios, reset.
  $("#settings-close").addEventListener("click", closeSettings);
  $("#settings-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  // RF-UI-03: the Agent gear opens unified Settings at the AI section; live search filters.
  setSettingsHandler(() => openSettings({ section: "settings-sec-ai" }));
  $("#settings-search").addEventListener("input", (e) =>
    filterSettings((e.target as HTMLInputElement).value),
  );
  $("#status-sandbox").addEventListener("click", () => openSettings());
  $("#status-sandbox").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
      e.preventDefault();
      openSettings();
    }
  });
  document.querySelectorAll<HTMLInputElement>('#sandbox-choices input[name="sandbox"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (r.checked && isSandboxEngine(r.value)) void applySandbox(r.value);
    }),
  );

  // Language selector: flip the whole chrome locale live (setLocale re-applies
  // every data-i18n binding and fires onLocaleChange; see wireLocale()).
  document.querySelectorAll<HTMLInputElement>('#locale-choices input[name="locale"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (r.checked && (r.value === "en" || r.value === "ptAO")) setLocale(r.value as Locale);
    }),
  );
  $("#settings-reset").addEventListener("click", () => {
    closeSettings();
    resetProfile();
  });

  // Under-the-hood panel: a topbar button, the activity-bar 🔬 button, re-measure
  // and close. Opening (re-)measures the CURRENT editor code.
  $("#btn-underhood").addEventListener("click", () => void openUnderHood());
  $("#uh-close").addEventListener("click", closeUnderHood);

  // Visualize-execution overlay: open/close, run the tracer, and the player
  // transport (step back/forward, play/pause, speed).
  $("#viz-close").addEventListener("click", closeVisualize);
  $("#viz-run").addEventListener("click", () => void runVisualize());
  $("#viz-back").addEventListener("click", () => vizStepBack());
  $("#viz-fwd").addEventListener("click", () => vizStepForward());
  $("#viz-play").addEventListener("click", () => vizTogglePlay());
  $("#visualize-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeVisualize();
  });
  $("#uh-rerun").addEventListener("click", () => void openUnderHood());
  $("#underhood-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeUnderHood();
  });
  // Click the dimmed backdrop to dismiss either overlay.
  $("#glossary-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeGlossary();
  });
  $("#studyguide-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeStudyGuide();
  });
  // Escape closes whichever scaffolding overlay is open.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#settings-overlay").classList.contains("hidden")) closeSettings();
      if (!$("#glossary-overlay").classList.contains("hidden")) closeGlossary();
      if (!$("#studyguide-overlay").classList.contains("hidden")) closeStudyGuide();
      if (!$("#underhood-overlay").classList.contains("hidden")) closeUnderHood();
      if (!$("#visualize-overlay").classList.contains("hidden")) closeVisualize();
    }
  });

  // Keyboard transport for the visualizer when its overlay is focused/open.
  window.addEventListener("keydown", (e) => {
    if ($("#visualize-overlay").classList.contains("hidden")) return;
    const tag = (e.target as HTMLElement)?.tagName;
    const inEditor = (e.target as HTMLElement)?.closest?.("#viz-editor");
    if (inEditor || tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      vizStepForward();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      vizStepBack();
    } else if (e.key === " ") {
      e.preventDefault();
      vizTogglePlay();
    }
  });

  // Ctrl+` toggles the terminal, like VSCode.
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "Backquote") {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminal();
      }
    },
    { capture: true },
  );

  document.querySelectorAll(".act").forEach((el) =>
    el.addEventListener("click", () => {
      const view = (el as HTMLElement).dataset.view;

      // Left-docked views replace the sidebar (VSCode-style) and are mutually
      // exclusive: clicking an open view closes it; opening one closes the others.
      const LEFT_VIEWS: Record<string, string> = {
        git: "#git-overlay",
        search: "#search-overlay",
        tests: "#tests-overlay",
        debug: "#rundebug-overlay",
        remote: "#remote-overlay",
      };
      if (view && view in LEFT_VIEWS) {
        const target = document.querySelector(LEFT_VIEWS[view])!;
        const wasOpen = !target.classList.contains("hidden");
        Object.values(LEFT_VIEWS).forEach((s) => document.querySelector(s)?.classList.add("hidden"));
        if (wasOpen) return; // toggle off → sidebar returns
        if (view === "git") openGit();
        else if (view === "search") openSearch();
        else if (view === "tests") openTests();
        else if (view === "remote") openRemote();
        else {
          setMode("workspace"); // Run and Debug view lives in the sidebar column
          target.classList.remove("hidden");
          renderBreakpointsPanel();
        }
        return;
      }

      if (view === "settings") {
        openSettings();
        return;
      }
      if (view === "glossary") {
        openGlossary();
        return;
      }
      if (view === "underhood") {
        void openUnderHood();
        return;
      }
      if (view === "visualize") {
        openVisualize();
        return;
      }
      if (view === "debug") {
        openDebug();
        return;
      }
      if (view === "review") {
        openReview();
        return;
      }
      if (view === "tests") {
        openTests();
        return;
      }
      if (view === "search") {
        openSearch();
        return;
      }
      if (view === "git") {
        openGit();
        return;
      }
      if (view === "assistant") {
        openAssistant();
        return;
      }
      // Action icons (not views): Run and Hint trigger their topbar action so the
      // activity-bar icon actually *does* its job rather than silently no-op.
      if (view === "run") {
        if (appMode === "workspace") ($("#ws-btn-run") as HTMLButtonElement).click();
        else ($("#btn-run") as HTMLButtonElement).click();
        return;
      }
      if (view === "hint") {
        if (appMode !== "learning") setMode("learning");
        void requestHint();
        return;
      }
      // Mode-owning buttons: Learning track (data-mode=learning) and the file
      // Explorer (data-mode=workspace) switch the whole surface.
      if (view === "workspace") {
        setMode("workspace");
        return;
      }
      if (view === "explorer") {
        setMode("learning");
        return;
      }
      document.querySelectorAll(".act:not([data-mode])").forEach((a) => a.classList.remove("active"));
      el.classList.add("active");
    }),
  );

  initActiveViewIndicators();
}

// VSCode/Antigravity-style active-view accent bar: light the activity-bar icon of
// whichever overlay panel is currently visible. Driven by observing each overlay's
// `hidden` class, so it stays correct no matter how the panel is opened or closed
// (icon, shortcut, or its own close button) without touching every call site.
function initActiveViewIndicators() {
  const map: Record<string, string> = {
    git: "#git-overlay",
    search: "#search-overlay",
    tests: "#tests-overlay",
    review: "#review-overlay",
    debug: "#rundebug-overlay",
    remote: "#remote-overlay",
    assistant: "#assistant-overlay",
    glossary: "#glossary-overlay",
    underhood: "#underhood-overlay",
    visualize: "#visualize-overlay",
    settings: "#settings-overlay",
  };
  for (const [view, sel] of Object.entries(map)) {
    const overlay = document.querySelector(sel);
    const icon = document.querySelector(`.act[data-view="${view}"]`);
    if (!overlay || !icon) continue;
    const sync = () => icon.classList.toggle("view-open", !overlay.classList.contains("hidden"));
    new MutationObserver(sync).observe(overlay, { attributes: true, attributeFilter: ["class"] });
    sync();
  }
}

// ── Resizable sidebar ────────────────────────────────────────────────────────
// The sidebar width lives in the `--sidebar-w` custom property on #body; a slim
// drag handle (#sidebar-resizer) live-updates it and persists to localStorage.
// Both Monaco editors use automaticLayout, so the editor column re-flows on its
// own as the grid column changes.
const SIDEBAR_W_KEY = "dxtutor.sidebarWidth";
const SIDEBAR_MIN = 180;
const sidebarMax = () => Math.min(560, Math.round(window.innerWidth * 0.5));

function applySidebarWidth(px: number) {
  const clamped = Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), Math.round(px)));
  // Set on :root so BOTH the #body grid and the left-docked view panels
  // (.codemap-drawer) read the same width — the panels replace the sidebar
  // column exactly, VSCode-style, and resize live with it.
  document.documentElement.style.setProperty("--sidebar-w", `${clamped}px`);
}

function currentSidebarWidth(): number {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"), 10) || 260;
}

function initSidebarResizer() {
  const handle = document.getElementById("sidebar-resizer");
  if (!handle) return;

  // Restore the persisted width (clamped to the current window bounds).
  const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
  if (Number.isFinite(saved) && saved > 0) applySidebarWidth(saved);

  let dragging = false;
  const onMove = (e: MouseEvent) => {
    if (dragging) applySidebarWidth(e.clientX - 48); // 48px = activity bar
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.classList.remove("resizing-sidebar");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    localStorage.setItem(SIDEBAR_W_KEY, String(currentSidebarWidth()));
  };
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add("dragging");
    document.body.classList.add("resizing-sidebar");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  // Double-click the handle to reset to the default width.
  handle.addEventListener("dblclick", () => {
    applySidebarWidth(260);
    localStorage.setItem(SIDEBAR_W_KEY, String(currentSidebarWidth()));
  });
  // Keep the sidebar within bounds if the window is shrunk.
  window.addEventListener("resize", () => applySidebarWidth(currentSidebarWidth()));
}

// When the locale flips (from the Settings selector), re-apply every static
// data-i18n binding (done inside setLocale) and re-render the JS-built chrome:
// status bar, sandbox indicator and the learning-track level headings. Course
// CONTENT (unit/step titles, prose) is backend text and stays in its language.
function onLocaleFlip() {
  updateStatusBar();
  updateSandboxIndicator();
  if (course) renderSidebar();
}

async function main() {
  initI18n(); // paint static chrome strings + set <html lang> before anything shows
  onLocaleChange(onLocaleFlip);
  setupEditor();
  wireChrome();
  initSidebarResizer();
  wireMenus();
  initWorkspace(); // build the Workspace/Explorer surface (hidden until its mode)
  initReview({ ensureWorkspaceMode: () => setMode("workspace") }); // Code Review panel
  initCodeMap({ ensureWorkspaceMode: () => setMode("workspace") }); // CodeMap panel
  initTests({ ensureWorkspaceMode: () => setMode("workspace") }); // Tests panel
  initSearch({ ensureWorkspaceMode: () => setMode("workspace") }); // Search panel
  initQuickOpen({
    ensureWorkspaceMode: () => setMode("workspace"),
    commands: () => [
      { label: "Learning: Open track", hint: "View", run: () => setMode("learning") },
      { label: "Explorer: Open folder view", hint: "View", run: () => setMode("workspace") },
      { label: "Run / Submit", hint: "Action", run: () => (appMode === "workspace" ? $("#ws-btn-run") : $("#btn-run")).click() },
      { label: "Run project tests", hint: "Action", run: () => runProjectTestsRef() },
      { label: "Architecture Studio", hint: "Design", run: () => openArch() },
      { label: "Request a hint", hint: "Action", run: () => { if (appMode !== "learning") setMode("learning"); void requestHint(); } },
      { label: "Search in project", hint: "View", run: () => openSearch() },
      { label: "Source Control (Git)", hint: "View", run: () => openGit() },
      { label: "Remote: Dev Containers", hint: "View", run: () => openRemote() },
      { label: "Run and Debug", hint: "View", run: () => openDebug() },
      { label: "Tests", hint: "View", run: () => openTests() },
      { label: "Code Review", hint: "View", run: () => openReview() },
      { label: "Dev Assistant", hint: "View", run: () => openAssistant() },
      { label: "Glossary", hint: "View", run: () => openGlossary() },
      { label: "Under the hood", hint: "View", run: () => void openUnderHood() },
      { label: "Visualize execution", hint: "View", run: () => openVisualize() },
      { label: "Settings", hint: "View", run: () => openSettings() },
    ],
  }); // Ctrl+P quick-open · Ctrl+Shift+P command palette
  initGit({ ensureWorkspaceMode: () => setMode("workspace") }); // Git panel
  initRemote({
    ensureWorkspaceMode: () => setMode("workspace"),
    openSessionTerminal: (root) => void attachSessionTerminal(root),
  }); // Remote / Dev Containers
  initExplain(); // AI code-summary panel
  initArch(); // Architecture Studio (System Design + validation + scaffold)

  // Workspace editor actions: Explain (AI summary), Review, Debug.
  const explainActive = () => {
    const path = activeFilePath();
    if (!path) return;
    const code = currentFileContent(path);
    if (code == null) return;
    const name = path.split(/[\\/]/).pop() ?? path;
    void explainFile(path, code, langForFile(name), name);
  };
  $("#ws-btn-explain").addEventListener("click", explainActive);
  $("#ws-btn-review").addEventListener("click", () => openReview());
  $("#ws-btn-debug").addEventListener("click", () => openDebug());
  setExplainFolderHandler((path) => {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    void explainFolder(path, name);
  });

  // Container session status chip: re-attach a terminal on click; refresh on session changes.
  const openSessionFromStatus = () => {
    const root = workspaceRoot();
    if (root) void attachSessionTerminal(root);
  };
  $("#status-session").addEventListener("click", openSessionFromStatus);
  $("#status-session").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
      e.preventDefault();
      openSessionFromStatus();
    }
  });
  setSessionChangeHandler(() => void refreshSessionStatus());

  // RF-AG-02: run the project's tests and show the command + real outcome (cited evidence).
  const runProjectTests = async () => {
    const root = workspaceRoot();
    if (!root || !hasTauri) return;
    setMode("workspace");
    showTestOutput("…", null, "", "");
    try {
      const r = await invoke<{ command: string; ok: boolean; stdout: string; stderr: string }>(
        "run_tests",
        { root },
      );
      showTestOutput(r.command, r.ok, r.stdout, r.stderr);
    } catch (e) {
      showTestOutput("tests", false, "", String(e));
    }
  };
  runProjectTestsRef = runProjectTests; // exposed to the command palette below
  // Autonomous loop: when the Agent's plan finishes its steps, verify by running the tests.
  setPlanCompleteHandler(() => void runProjectTests());
  setCodeMapHandler((symbol, pos) => void openCodeMap(symbol, pos)); // editor → CodeMap (resolved when possible)
  initAssistant(); // Dev Assistant chat panel
  initEdit(); // "Edit with me" interruptible assisted editing
  setEditHandler((path, content, lang) => startEdit(path, content, lang)); // editor → Edit with AI
  setLocalizedEditHandler((path, sl, el, selected, lang) => void startLocalizedEdit(path, sl, el, selected, lang)); // editor → localized edit
  setMethodEditHandler((path, code, lang) => void startMethodEdit(path, code, lang)); // editor → edit a named method
  setEntrypointHandler((path, code, lang) => void addEntrypoint(path, code, lang)); // editor → add main entrypoint
  initDebug({ getTarget: currentDebugTarget }); // wire the Run-and-Debug panel
  // Run and Debug sidebar view (VSCode empty-state): launch the debugger / make a launch.json.
  $("#rundebug-close").addEventListener("click", () => $("#rundebug-overlay").classList.add("hidden"));
  $("#rundebug-start").addEventListener("click", () => {
    $("#rundebug-overlay").classList.add("hidden");
    openDebug();
  });
  const launchJson = () => void createLaunchJson();
  $("#rundebug-launch").addEventListener("click", launchJson);
  $("#rundebug-launch").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") launchJson();
  });

  // Breakpoints panel (in the Run and Debug view): list, toggle, remove, jump.
  setBreakpointsChangeHandler(renderBreakpointsPanel);
  $("#bp-clear").addEventListener("click", () => removeAllBreakpoints());
  $("#bp-list").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest(".bp-row") as HTMLElement | null;
    if (!row) return;
    const path = row.dataset.path!;
    const line = Number(row.dataset.line);
    if (t.closest(".bp-toggle")) setBreakpointEnabled(path, line, (t as HTMLInputElement).checked);
    else if (t.closest(".bp-remove")) removeBreakpoint(path, line);
    else void openFileAt(path, line, 1);
  });

  await setupTerminal();

  profile = loadProfile();
  points = loadPoints();
  for (const id of loadDone()) done.add(id);
  stats = loadStats();
  codeByStep = loadCode(); // restore every step's typed code from the last session
  updateStatusBar();

  // Align the backend sandbox with the saved choice (default: Delonix container)
  // BEFORE any Run/Submit can fire, so execution always lands in the right engine.
  await applySandbox(loadSandbox(), { persist: false });

  if (!profile) {
    await showOnboarding();
  } else {
    await loadCourse();
  }

  // Apply the saved mode (Learning ↔ Workspace) once everything is mounted,
  // then reveal the app by dismissing the boot splash — no raw HTML is ever seen.
  setMode(loadMode());
  hideBoot();
}

main().catch((err) => {
  console.error("dxtutor failed to start:", err);
  hideBoot();
});
