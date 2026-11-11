// dxtutor desktop — "Run and Debug" panel (VSCode-style, but honest).
//
// This is an IDE-grade debugger surface that navigates a REAL, pre-computed
// execution trace produced by the backend's `trace_execution(language, code)`
// command (Python via sys.settrace, Rust via syn instrumentation). There is no
// gdb/lldb on this host, so instead of pretending to attach to a live process
// we step through the same honest trace that powers "Visualize execution" —
// only here it is dressed as a debugger: breakpoints, Continue (F5), Step Over
// (F10), Step Into (F11), Step Back and Stop, plus the Variables, Call Stack,
// Breakpoints and Debug Console panels.
//
// This module owns ONLY the Run-and-Debug surface. main.ts supplies the code to
// debug (the current Learning step, or the active Workspace file) through a
// small context callback, and wires the activity-bar button to `openDebug()`.

import { monaco } from "./monaco";
import { invoke } from "@tauri-apps/api/core";

import "./debug.css";

const hasTauri = "__TAURI_INTERNALS__" in window;
const reduceMotion =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── Contract types (shared with the backend tracer) ──────────────────────────

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

// What main.ts hands us: the code to debug and how to read/trace it.
export interface DebugTarget {
  code: string;
  title: string; // header label (file name or step title)
  monacoLang: string; // monaco language id for syntax highlighting
  traceLang: string; // language passed to trace_execution ("python" | "rust" | …)
}
export interface DebugContext {
  getTarget: () => DebugTarget | null;
}

// ── State ────────────────────────────────────────────────────────────────────

let ctx: DebugContext | null = null;
let dbgEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let bpDecorations: monaco.editor.IEditorDecorationsCollection | null = null;
let lineDecorations: monaco.editor.IEditorDecorationsCollection | null = null;
let hoverDecorations: monaco.editor.IEditorDecorationsCollection | null = null;

let steps: TraceStepDto[] = [];
let stdout = "";
let frames: string[][] = [];
let idx = 0;
let running = false; // a debug session is live (trace loaded)
let lastCode = ""; // detect when the target changed (to reset breakpoints)
let lastTraceLang = "";
let prevVars = new Map<string, string>(); // name → value at the previously painted step

// Breakpoints are line numbers; kept per session (reset when the code changes).
const breakpoints = new Set<number>();

// ── DOM helpers ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Monaco editor (lazy) ──────────────────────────────────────────────────────

function ensureEditor() {
  if (dbgEditor) return;
  dbgEditor = monaco.editor.create($("#dbg-editor"), {
    value: "",
    language: "rust",
    theme: "dxtutor-dark", // defined by main.ts's setupEditor()
    readOnly: true, // the source mirrors the real editor; edit there, then re-start
    automaticLayout: true,
    fontFamily: '"Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
    fontSize: 13,
    minimap: { enabled: false },
    stickyScroll: { enabled: false },
    scrollBeyondLastLine: false,
    glyphMargin: true, // room for breakpoint dots + the current-line arrow
    lineNumbersMinChars: 3,
    padding: { top: 10 },
    tabSize: 4,
    renderWhitespace: "selection",
  });
  bpDecorations = dbgEditor.createDecorationsCollection();
  lineDecorations = dbgEditor.createDecorationsCollection();
  hoverDecorations = dbgEditor.createDecorationsCollection();

  // Click the glyph margin / line number to toggle a breakpoint on that line.
  dbgEditor.onMouseDown((e) => {
    const t = e.target.type;
    if (
      t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
      t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    ) {
      const line = e.target.position?.lineNumber;
      if (line) toggleBreakpoint(line);
    }
  });
  // A faint "ghost" breakpoint dot follows the pointer in the glyph margin.
  dbgEditor.onMouseMove((e) => {
    const t = e.target.type;
    const line =
      (t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) &&
      e.target.position
        ? e.target.position.lineNumber
        : 0;
    if (line && !breakpoints.has(line)) {
      hoverDecorations?.set([
        {
          range: new monaco.Range(line, 1, line, 1),
          options: { glyphMarginClassName: "dbg-glyph-bp-hover" },
        },
      ]);
    } else {
      hoverDecorations?.set([]);
    }
  });
  dbgEditor.onMouseLeave(() => hoverDecorations?.set([]));
}

// ── Breakpoints ────────────────────────────────────────────────────────────────

function toggleBreakpoint(line: number) {
  if (breakpoints.has(line)) breakpoints.delete(line);
  else breakpoints.add(line);
  paintDecorations();
  renderBreakpointList();
}

function paintDecorations() {
  if (!dbgEditor) return;
  const activeLine = running && steps.length ? steps[idx]?.line : 0;

  // Breakpoint dots — but not on the active line (its glyph becomes the arrow).
  bpDecorations?.set(
    [...breakpoints]
      .filter((l) => l !== activeLine)
      .map((l) => ({
        range: new monaco.Range(l, 1, l, 1),
        options: { glyphMarginClassName: "dbg-glyph-bp" },
      })),
  );

  // Current execution line: whole-line highlight + a gutter arrow (fused with a
  // red ring when the stop happens to be on a breakpoint, VSCode-style).
  if (activeLine) {
    const onBp = breakpoints.has(activeLine);
    lineDecorations?.set([
      {
        range: new monaco.Range(activeLine, 1, activeLine, 1),
        options: {
          isWholeLine: true,
          className: "dbg-line-active",
          glyphMarginClassName: onBp ? "dbg-glyph-arrow-bp" : "dbg-glyph-arrow",
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      },
    ]);
  } else {
    lineDecorations?.set([]);
  }
}

function renderBreakpointList() {
  const host = $("#dbg-breakpoints");
  if (breakpoints.size === 0) {
    host.innerHTML = `<div class="dbg-empty">No breakpoints. Click the gutter to add one.</div>`;
    return;
  }
  const lines = dbgEditor?.getModel()?.getLinesContent() ?? [];
  host.innerHTML = [...breakpoints]
    .sort((a, b) => a - b)
    .map((l) => {
      const src = (lines[l - 1] ?? "").trim();
      return (
        `<div class="dbg-bp-row" data-line="${l}" title="Remove breakpoint">` +
        `<span class="dbg-bp-dot"></span>` +
        `<span class="dbg-bp-line">${l}</span>` +
        `<span class="dbg-bp-src">${esc(src)}</span></div>`
      );
    })
    .join("");
  host.querySelectorAll<HTMLElement>(".dbg-bp-row").forEach((row) =>
    row.addEventListener("click", () => toggleBreakpoint(Number(row.dataset.line))),
  );
}

// ── Call-stack reconstruction (identical honest logic to Visualize) ───────────

function buildFrames(all: TraceStepDto[]): string[][] {
  const stack: string[] = [];
  const out: string[][] = [];
  for (const s of all) {
    stack[s.depth] = s.func || "?";
    stack.length = s.depth + 1;
    out.push(stack.slice());
    if (s.event === "return") stack.length = s.depth;
  }
  return out;
}

// ── Open / close ──────────────────────────────────────────────────────────────

export function openDebug() {
  const overlay = $("#debug-overlay");
  overlay.classList.remove("hidden");
  const target = ctx?.getTarget() ?? null;

  const notes = $("#dbg-notes");
  const main = overlay.querySelector<HTMLElement>(".dbg-main")!;
  const side = overlay.querySelector<HTMLElement>(".dbg-side")!;

  if (!target || !target.code.trim()) {
    main.classList.add("solo");
    side.classList.add("hidden");
    $("#dbg-editor").classList.add("hidden");
    $("#dbg-console-wrap").classList.add("hidden");
    setControls(false);
    notes.classList.remove("hidden");
    notes.innerHTML = `<div class="dbg-note"><p>Nothing to debug yet — open a
      Learning step or a Workspace file with some code, then come back.</p></div>`;
    return;
  }

  side.classList.remove("hidden");
  main.classList.remove("solo");
  $("#dbg-editor").classList.remove("hidden");
  $("#dbg-console-wrap").classList.remove("hidden");
  ensureEditor();

  // Load the target code + language into the (read-only) debug editor.
  const model = dbgEditor!.getModel();
  const codeChanged = target.code !== lastCode || target.traceLang !== lastTraceLang;
  if (!model || model.getValue() !== target.code) {
    dbgEditor!.setValue(target.code);
  }
  monaco.editor.setModelLanguage(dbgEditor!.getModel()!, target.monacoLang);
  lastCode = target.code;
  lastTraceLang = target.traceLang;

  // If the code changed since last time, old breakpoints/line numbers no longer
  // map — start clean (honest, avoids phantom stops on unrelated lines).
  if (codeChanged) {
    breakpoints.clear();
    stopSession(); // clears the run state + decorations
  }

  $("#dbg-target-name").textContent = target.title || "Current code";
  renderBreakpointList();
  paintDecorations();
  setStatus(
    running
      ? statusText()
      : "Ready — set breakpoints in the gutter, then Start Debugging.",
  );

  requestAnimationFrame(() => {
    dbgEditor?.layout();
    dbgEditor?.focus();
  });
}

export function closeDebug() {
  $("#debug-overlay").classList.add("hidden");
}

// ── Debug session lifecycle ────────────────────────────────────────────────────

async function startDebugging() {
  const target = ctx?.getTarget();
  if (!target) return;
  const startBtn = $("#dbg-start") as HTMLButtonElement;
  const spinner = $("#dbg-spinner");
  const notes = $("#dbg-notes");

  // Reset the view while the backend traces.
  stopSession();
  notes.classList.add("hidden");
  startBtn.disabled = true;
  spinner.classList.remove("hidden");
  setStatus("Starting — tracing your program…");

  if (!hasTauri) {
    spinner.classList.add("hidden");
    startBtn.disabled = false;
    showNote(
      `<p><strong>Run and Debug</strong> traces your program through the real
      backend, so it works only inside the desktop app
      (<code>npm run tauri dev</code>). Nothing here is simulated.</p>`,
      false,
    );
    return;
  }

  try {
    const trace = await invoke<ExecutionTraceDto>("trace_execution", {
      language: target.traceLang,
      code: target.code,
    });
    if (!trace.supported) {
      showNote(
        trace.notes
          ? renderNotes(trace.notes)
          : `<p>Live debugging isn't available for this language on this host.</p>`,
        false,
      );
      return;
    }
    if (!trace.steps || trace.steps.length === 0) {
      showNote(
        `<p>The program ran but produced no trace steps to step through.</p>${
          trace.notes ? renderNotes(trace.notes) : ""
        }`,
        false,
      );
      return;
    }
    // Session is live.
    steps = trace.steps;
    stdout = trace.stdout ?? "";
    frames = buildFrames(steps);
    idx = 0;
    running = true;
    prevVars = new Map();
    notes.classList.add("hidden");
    setControls(true);
    // If there are breakpoints, run straight to the first one (VSCode-style);
    // otherwise pause on the very first statement.
    if (breakpoints.size) continueExec(true);
    else renderStep(true);
  } catch (e) {
    showNote(`Couldn't start debugging: <code>${esc(String(e))}</code>`, true);
  } finally {
    spinner.classList.add("hidden");
    startBtn.disabled = false;
  }
}

function stopSession() {
  running = false;
  steps = [];
  frames = [];
  idx = 0;
  prevVars = new Map();
  setControls(false);
  if (bpDecorations) paintDecorations();
  lineDecorations?.set([]);
  $("#dbg-vars").innerHTML = "";
  $("#dbg-stack").innerHTML = "";
  $("#dbg-console").textContent = "";
}

function stopDebugging() {
  stopSession();
  renderBreakpointList();
  setStatus("Stopped. Start Debugging to run again.");
}

// ── Transport (Continue / Step Over / Step Into / Step Back) ──────────────────

function gotoStep(n: number, firstPaint = false) {
  idx = Math.max(0, Math.min(steps.length - 1, n));
  renderStep(firstPaint);
}

// Continue (F5): advance to the next step sitting on a breakpoint; if none, run
// to the end. `fromStart` lets us honour a breakpoint on the very first line.
function continueExec(fromStart = false) {
  if (!running) return;
  const begin = fromStart ? idx : idx + 1;
  for (let i = begin; i < steps.length; i++) {
    if (breakpoints.has(steps[i].line)) {
      gotoStep(i);
      setStatus(`Breakpoint hit — line ${steps[i].line}.`);
      return;
    }
  }
  // No further breakpoint: run to completion.
  gotoStep(steps.length - 1);
  setStatus("Program finished — end of trace.");
}

// Step Over (F10): advance to the next step in the same frame or shallower
// (i.e. do not descend into a function called on this line).
function stepOver() {
  if (!running) return;
  const depth = steps[idx]?.depth ?? 0;
  for (let i = idx + 1; i < steps.length; i++) {
    if (steps[i].depth <= depth) {
      gotoStep(i);
      setStatus(statusText());
      return;
    }
  }
  gotoStep(steps.length - 1);
  setStatus("Program finished — end of trace.");
}

// Step Into (F11): advance exactly one trace step (descends into calls).
function stepInto() {
  if (!running) return;
  if (idx >= steps.length - 1) {
    setStatus("Program finished — end of trace.");
    return;
  }
  gotoStep(idx + 1);
  setStatus(statusText());
}

// Step Back: rewind one trace step (only possible because the trace is recorded).
function stepBack() {
  if (!running) return;
  if (idx <= 0) {
    setStatus("At the first step — can't step back further.");
    return;
  }
  gotoStep(idx - 1);
  setStatus(statusText());
}

function statusText(): string {
  const s = steps[idx];
  if (!s) return "";
  const evt = s.event === "call" ? "entering" : s.event === "return" ? "returning from" : "at";
  return `Paused — ${evt} ${s.func || "?"}, line ${s.line} (step ${idx + 1} of ${steps.length}).`;
}

// ── Rendering (editor + the four panels) ──────────────────────────────────────

function renderStep(firstPaint: boolean) {
  const step = steps[idx];
  if (!step || !dbgEditor) return;

  // Editor: breakpoints + current line, revealed into view.
  paintDecorations();
  dbgEditor.revealLineInCenterIfOutsideViewport(step.line, monaco.editor.ScrollType.Smooth);

  // Variables — flash the ones whose value changed since the last paint.
  const vars = $("#dbg-vars");
  const now = new Map<string, string>();
  for (const v of step.locals) now.set(v.name, v.value);
  if (step.locals.length === 0) {
    vars.innerHTML = `<div class="dbg-empty">No locals in this frame yet.</div>`;
  } else {
    vars.innerHTML = step.locals
      .map((v) => {
        const prev = prevVars.get(v.name);
        const changed = !firstPaint && prev !== v.value;
        return `<div class="dbg-var${changed ? " changed" : ""}">
            <span class="dbg-var-name">${esc(v.name)}</span>
            <span class="dbg-var-eq">=</span>
            <span class="dbg-var-value">${esc(v.value)}</span>
            <span class="dbg-var-ty">${esc(v.ty)}</span>
          </div>`;
      })
      .join("");
  }
  prevVars = now;

  // Call stack — innermost frame on top, tagged with the live event.
  const fr = frames[idx] ?? [step.func];
  const evtTag = step.event === "call" ? "call" : step.event === "return" ? "return" : "line";
  $("#dbg-stack").innerHTML = fr
    .map((name, d) => {
      const top = d === fr.length - 1;
      return `<div class="dbg-frame${top ? " top" : ""}">
          <span class="dbg-frame-depth">${d}</span>
          <span class="dbg-frame-name">${esc(name)}</span>
          ${top ? `<span class="dbg-frame-evt ${evtTag}">${evtTag}</span>` : ""}
        </div>`;
    })
    .reverse()
    .join("");

  // Debug Console — stdout accumulated up to this step.
  const out = $("#dbg-console");
  const slice = stdout.slice(0, Math.max(0, step.stdoutLen));
  out.textContent = slice;
  if (slice) out.scrollTop = out.scrollHeight;

  // Step counter + button enablement.
  $("#dbg-stepcount").textContent = `${idx + 1} / ${steps.length}`;
  ($("#dbg-stepback") as HTMLButtonElement).disabled = idx <= 0;
  ($("#dbg-stepinto") as HTMLButtonElement).disabled = idx >= steps.length - 1;
  ($("#dbg-stepover") as HTMLButtonElement).disabled = idx >= steps.length - 1;
}

// ── Small UI helpers ───────────────────────────────────────────────────────────

function setControls(live: boolean) {
  $("#dbg-controls").classList.toggle("hidden", !live);
  $("#dbg-start").classList.toggle("hidden", live);
  $("#dbg-stepcount").classList.toggle("hidden", !live);
}

function setStatus(text: string) {
  $("#dbg-status").textContent = text;
}

function showNote(html: string, isError: boolean) {
  const notes = $("#dbg-notes");
  notes.classList.remove("hidden");
  notes.innerHTML = `<div class="dbg-note${isError ? " error" : ""}">${html}</div>`;
  setStatus(isError ? "Could not start." : "");
}

// Tiny markdown-ish rendering for the backend's honest `notes` text.
function renderNotes(md: string): string {
  return md
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim()).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`)
    .join("");
}

// ── Public init ────────────────────────────────────────────────────────────────

export function initDebug(context: DebugContext) {
  ctx = context;

  $("#dbg-close").addEventListener("click", closeDebug);
  $("#dbg-start").addEventListener("click", () => void startDebugging());
  $("#dbg-continue").addEventListener("click", () => continueExec());
  $("#dbg-stepover").addEventListener("click", () => stepOver());
  $("#dbg-stepinto").addEventListener("click", () => stepInto());
  $("#dbg-stepback").addEventListener("click", () => stepBack());
  $("#dbg-stop").addEventListener("click", () => stopDebugging());

  // Click the dimmed backdrop to dismiss.
  $("#debug-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeDebug();
  });

  // Keyboard transport (VSCode-style) while the panel is open and focus is not
  // in a text input. F5 Continue · F10 Step Over · F11 Step Into · Shift+F11
  // Step Back · Shift+F5 Stop · Esc close.
  window.addEventListener(
    "keydown",
    (e) => {
      if ($("#debug-overlay").classList.contains("hidden")) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") {
        closeDebug();
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) stopDebugging();
        else if (running) continueExec();
        else void startDebugging();
      } else if (e.key === "F10") {
        e.preventDefault();
        e.stopPropagation();
        if (running) stepOver();
        else void startDebugging();
      } else if (e.key === "F11") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) stepBack();
        else stepInto();
      }
    },
    { capture: true },
  );

  // reduceMotion is honoured in debug.css via prefers-reduced-motion; keep a
  // reference so bundlers never tree-shake the intent away.
  void reduceMotion;
}
