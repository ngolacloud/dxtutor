// dxtutor desktop — Workspace / Explorer mode.
//
// A real IDE surface alongside the guided Learning track: open a real folder,
// browse a lazy file tree, edit many files in tabs (Monaco), save, create,
// delete, rename, and run a file. It consumes a FIXED Tauri command contract
// (camelCase) implemented by the backend:
//
//   pickFolder()                 -> string | null
//   listDir(path)                -> EntryDto[]   { name, path, isDir }
//   readTextFile(path)           -> string
//   writeTextFile(path, contents)-> void
//   createPath(path, isDir)      -> void
//   deletePath(path)             -> void
//   renamePath(from, to)         -> void
//   runPath(path)                -> { ok, stdout, stderr }
//
// This module owns ONLY the Workspace surface; the Learning mode in main.ts is
// untouched. main.ts drives the mode toggle and calls `activateWorkspace()`.

import { monaco } from "./monaco";
import { invoke } from "@tauri-apps/api/core";

import "./workspace.css";
import type { DebugTarget } from "./debug";
import { t } from "./i18n";
import { installLsp, lspDidOpen, lspDidChange, LSP_LANGUAGES, type LspHost } from "./lsp";
import { gitStatusMap, type GitDeco } from "./git";

const hasTauri = "__TAURI_INTERNALS__" in window;

// ── Contract types ───────────────────────────────────────────────────────────

interface EntryDto {
  name: string;
  path: string;
  isDir: boolean;
}
interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// ── State ──────────────────────────────────────────────────────────────────

const LS = {
  folder: "dxtutor.ws.folder", // last opened root
  expanded: "dxtutor.ws.expanded", // array of expanded dir paths
  tabs: "dxtutor.ws.tabs", // {folder, paths[], active} — reopened on restart
  recents: "dxtutor.ws.recents", // array of recently opened root paths (most-recent first)
  breakpoints: "dxtutor.ws.breakpoints", // {[absPath]: [{line,condition,enabled}]} across sessions
  sections: "dxtutor.ws.sections", // which Explorer sections (outline/timeline/deps) are open
} as const;

const RECENTS_MAX = 8;

/** Recently opened folders, most-recent first. Powers the Welcome screen list. */
function recentFolders(): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(LS.recents) ?? "[]");
    return Array.isArray(a) ? (a as string[]) : [];
  } catch {
    return [];
  }
}

function pushRecent(path: string): void {
  const list = [path, ...recentFolders().filter((p) => p !== path)].slice(0, RECENTS_MAX);
  localStorage.setItem(LS.recents, JSON.stringify(list));
}

/** Render the Welcome screen's recent-workspaces list (basename + dim path, click = mount). */
function renderRecents(): void {
  const host = document.getElementById("ws-recents-list");
  const empty = document.getElementById("ws-recents-empty");
  if (!host || !empty) return;
  const list = recentFolders();
  empty.classList.toggle("hidden", list.length > 0);
  host.innerHTML = list
    .map((p) => {
      const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
      return `<button class="ws-recent" data-path="${esc(p)}"><span class="ws-recent-name">${esc(name)}</span><span class="ws-recent-path">${esc(p)}</span></button>`;
    })
    .join("");
}

let wsEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let rootPath: string | null = null;

// Lazily loaded children, keyed by directory path.
const childrenCache = new Map<string, EntryDto[]>();
// Git decorations keyed by ABSOLUTE path (file → state). Loaded once per workspace and on
// Refresh / after file+git operations; renderTree only READS it (cheap — no git spawn).
let gitDeco = new Map<string, GitDeco>();
// Directories the user has expanded (persisted so the tree re-opens as left).
const expanded = new Set<string>(loadExpanded());

interface Tab {
  path: string;
  name: string;
  model: monaco.editor.ITextModel;
  saved: string; // last persisted content (for restore + non-hot-path checks)
  savedVersionId: number; // Monaco alternativeVersionId at save — O(1) dirty check for big files
}
const tabs: Tab[] = [];
let activeTabPath: string | null = null;
let applyingModel = false; // guard: suppress dirty updates during programmatic swaps

// The Explain view is a REAL tab (sentinel path) that occupies the editor area when active,
// sitting in the tab bar beside the file tabs. `explainTab` holds its label when present.
const EXPLAIN_TAB = "__explain__";
let explainTab: { name: string; path: string | null } | null = null;

/** Open (or focus) the Explain tab. With a file `path` it SPLITS the editor (code left,
 *  summary right); with no path (folder/module mode) the summary takes the full area. */
export function openExplainTab(name: string, path?: string): void {
  explainTab = { name, path: path ?? null };
  setActiveTab(EXPLAIN_TAB);
}

/** Close the Explain tab (from its panel header or the tab's ✕). */
export function closeExplainTab(): void {
  closeTab(EXPLAIN_TAB);
}

/** Reveal a line in the workspace editor without changing tabs — used by the Explain jump
 *  links so the code (left pane) scrolls beside the summary, keeping the split. */
export function revealLine(line: number): void {
  if (!wsEditor) return;
  const ln = Math.max(1, line);
  wsEditor.revealLineInCenter(ln);
  wsEditor.setPosition({ lineNumber: ln, column: 1 });
}

// ── Breakpoints ────────────────────────────────────────────────────────────
// Line breakpoints per file, set by clicking the editor glyph margin. They are anchored as
// MODEL decorations (one per breakpoint) so Monaco keeps them on the right line as the code
// is edited above them — resilient, not a frozen line number. An optional condition makes
// the debugger stop only when it holds. The debugger seeds its stops from the active file
// (see debugTarget()). Keyed by file path → decoration id → condition (empty = unconditional).
// Keyed by file path → decoration id → {cond, enabled}. A disabled breakpoint stays visible
// (dimmed) but is skipped by the debugger.
interface BpState {
  cond: string;
  enabled: boolean;
}
const bpById = new Map<string, Map<string, BpState>>();
let onBreakpointsChanged: () => void = () => {};
/** Register a callback fired whenever breakpoints change (wired by main.ts's panel). */
export function setBreakpointsChangeHandler(fn: () => void): void {
  onBreakpointsChanged = fn;
}

/** Register the "Explain folder" action (wired by main.ts to the Explain module). */
let explainFolderHandler: (path: string) => void = () => {};
export function setExplainFolderHandler(fn: (path: string) => void): void {
  explainFolderHandler = fn;
}

/** Persist all breakpoints (across files) so they survive a restart, then notify the panel. */
function bpChanged(): void {
  const store: Record<string, Array<{ line: number; condition: string; enabled: boolean }>> = {};
  // Start from what's saved so breakpoints in CLOSED files are kept too.
  try {
    Object.assign(store, JSON.parse(localStorage.getItem(LS.breakpoints) ?? "{}"));
  } catch {
    /* ignore */
  }
  for (const [path, m] of bpById) {
    const tab = tabByPath(path);
    if (!tab) continue; // only re-serialize files we currently hold
    const list: Array<{ line: number; condition: string; enabled: boolean }> = [];
    for (const [id, st] of m) {
      const line = bpLine(tab.model, id);
      if (line) list.push({ line, condition: st.cond, enabled: st.enabled });
    }
    if (list.length) store[path] = list.sort((a, b) => a.line - b.line);
    else delete store[path];
  }
  localStorage.setItem(LS.breakpoints, JSON.stringify(store));
  onBreakpointsChanged();
}

/** Re-create the saved breakpoints for a file as it opens (decorations on its model). */
function restoreBreakpointsFor(path: string): void {
  let store: Record<string, Array<{ line: number; condition: string; enabled: boolean }>> = {};
  try {
    store = JSON.parse(localStorage.getItem(LS.breakpoints) ?? "{}");
  } catch {
    return;
  }
  for (const bp of store[path] ?? []) {
    paintBp(path, bp.line, { cond: bp.condition, enabled: bp.enabled });
  }
}

function bpMap(path: string): Map<string, BpState> {
  let m = bpById.get(path);
  if (!m) {
    m = new Map();
    bpById.set(path, m);
  }
  return m;
}

/** A breakpoint decoration's CURRENT line in the model (moves with edits), or null. */
function bpLine(model: monaco.editor.ITextModel, id: string): number | null {
  return model.getDecorationRange(id)?.startLineNumber ?? null;
}

function bpDecoration(st: BpState): monaco.editor.IModelDeltaDecoration {
  const cls = ["ws-bp-glyph"];
  if (st.cond) cls.push("ws-bp-cond");
  if (!st.enabled) cls.push("ws-bp-off");
  return {
    range: new monaco.Range(1, 1, 1, 1), // placeholder; set by deltaDecorations at the line
    options: {
      glyphMarginClassName: cls.join(" "),
      glyphMarginHoverMessage: st.cond ? { value: `Conditional breakpoint: \`${st.cond}\`` } : undefined,
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  };
}

/** The decoration id of the breakpoint currently on `line`, or null. */
function bpIdAtLine(model: monaco.editor.ITextModel, m: Map<string, BpState>, line: number): string | null {
  for (const [id] of m) if (bpLine(model, id) === line) return id;
  return null;
}

/** Create/replace the decoration for a breakpoint at `line` with state `st`. */
function paintBp(path: string, line: number, st: BpState): void {
  const tab = tabByPath(path);
  if (!tab) return;
  const m = bpMap(path);
  const existing = bpIdAtLine(tab.model, m, line);
  if (existing) {
    tab.model.deltaDecorations([existing], []);
    m.delete(existing);
  }
  const [id] = tab.model.deltaDecorations(
    [],
    [{ ...bpDecoration(st), range: new monaco.Range(line, 1, line, 1) }],
  );
  m.set(id, st);
}

function toggleBreakpoint(path: string, line: number): void {
  const tab = tabByPath(path);
  if (!tab) return;
  const m = bpMap(path);
  const existing = bpIdAtLine(tab.model, m, line);
  if (existing) {
    tab.model.deltaDecorations([existing], []);
    m.delete(existing);
  } else {
    paintBp(path, line, { cond: "", enabled: true });
  }
  bpChanged();
}

/** Set (or clear, with empty) a condition on the breakpoint at `line`; creates one if none. */
function setBreakpointCondition(path: string, line: number, cond: string): void {
  const tab = tabByPath(path);
  if (!tab) return;
  const id = bpIdAtLine(tab.model, bpMap(path), line);
  const enabled = id ? (bpMap(path).get(id)?.enabled ?? true) : true;
  paintBp(path, line, { cond, enabled });
  bpChanged();
}

/** Enable/disable the breakpoint at `line` (kept visible but skipped when disabled). */
export function setBreakpointEnabled(path: string, line: number, enabled: boolean): void {
  const tab = tabByPath(path);
  if (!tab) return;
  const id = bpIdAtLine(tab.model, bpMap(path), line);
  const cond = id ? (bpMap(path).get(id)?.cond ?? "") : "";
  paintBp(path, line, { cond, enabled });
  bpChanged();
}

/** Remove the breakpoint at `line`. */
export function removeBreakpoint(path: string, line: number): void {
  const tab = tabByPath(path);
  if (!tab) return;
  const m = bpMap(path);
  const id = bpIdAtLine(tab.model, m, line);
  if (id) {
    tab.model.deltaDecorations([id], []);
    m.delete(id);
  }
  bpChanged();
}

/** Remove every breakpoint across all files. */
export function removeAllBreakpoints(): void {
  for (const [path, m] of bpById) {
    const tab = tabByPath(path);
    if (tab) tab.model.deltaDecorations([...m.keys()], []);
    m.clear();
  }
  localStorage.removeItem(LS.breakpoints);
  onBreakpointsChanged();
}

/** Current (enabled) breakpoints for a file — read live from the decorations. */
function fileBreakpoints(path: string): Array<{ line: number; condition: string; enabled: boolean }> {
  const tab = tabByPath(path);
  if (!tab) return [];
  const out: Array<{ line: number; condition: string; enabled: boolean }> = [];
  for (const [id, st] of bpMap(path)) {
    const line = bpLine(tab.model, id);
    if (line) out.push({ line, condition: st.cond, enabled: st.enabled });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Every breakpoint across all open files, for the Breakpoints panel. */
export function allBreakpoints(): Array<{ path: string; name: string; line: number; condition: string; enabled: boolean }> {
  const out: Array<{ path: string; name: string; line: number; condition: string; enabled: boolean }> = [];
  for (const [path, m] of bpById) {
    const tab = tabByPath(path);
    if (!tab) continue;
    for (const [id, st] of m) {
      const line = bpLine(tab.model, id);
      if (line) out.push({ path, name: tab.name, line, condition: st.cond, enabled: st.enabled });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadExpanded(): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(LS.expanded) ?? "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function saveExpanded() {
  localStorage.setItem(LS.expanded, JSON.stringify([...expanded]));
}

// ── Path utilities (POSIX-first, tolerant of Windows separators) ─────────────

function sep(p: string): string {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}
function joinPath(parent: string, name: string): string {
  const s = sep(parent);
  return parent.replace(/[\\/]+$/, "") + s + name;
}
function parentOf(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return i <= 0 ? norm : norm.slice(0, i);
}
function baseName(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return i < 0 ? norm : norm.slice(i + 1);
}

// ── Language detection by extension ──────────────────────────────────────────

export function langForFile(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    rs: "rust",
    py: "python",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    markdown: "markdown",
    toml: "ini",
    ini: "ini",
    cfg: "ini",
    yml: "yaml",
    yaml: "yaml",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sh: "shell",
    bash: "shell",
    go: "go",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    java: "java",
    kt: "kotlin",
    rb: "ruby",
    php: "php",
    sql: "sql",
    xml: "xml",
  };
  return map[ext] ?? "plaintext";
}

// Language passed to the backend tracer. Only Rust/Python are traceable; any
// other extension still gets an honest "not supported" note from the backend.
function traceLangForFile(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "rs") return "rust";
  if (ext === "py") return "python";
  return langForFile(name); // backend reports it as unsupported, honestly
}

// Monochrome codicon-style SVG icons for the file tree + tabs (no emoji — matches the
// "dxtutor IDE" prototype). Single-stroke line glyphs tinted per file family by a CSS
// `ic-*` class, so the whole tree reads as one quiet, professional icon system.
const svgIco = (inner: string): string =>
  `<svg class="tree-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const FILE_BODY = '<path d="M13 3H7A1.5 1.5 0 0 0 5.5 4.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V8.5Z"/><path d="M13 3v5.5h5.5"/>';
const ICON = {
  folder: svgIco('<path d="M3 7.3A1.5 1.5 0 0 1 4.5 5.8h3.7a1.5 1.5 0 0 1 1.06.44l1.24 1.26H19.5A1.5 1.5 0 0 1 21 9v8.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.2Z"/>'),
  folderOpen: svgIco('<path d="M3 7.3A1.5 1.5 0 0 1 4.5 5.8h3.7a1.5 1.5 0 0 1 1.06.44L10.5 7.5H19.5A1.5 1.5 0 0 1 21 9v1.3"/><path d="M3 9.2v8a1.5 1.5 0 0 0 1.5 1.5h12.9a1.5 1.5 0 0 0 1.45-1.1L21 11H6.6a1.5 1.5 0 0 0-1.45 1.1Z"/>'),
  file: svgIco(FILE_BODY),
  // Standalone `</>` — code files read as code, not as a generic document.
  code: svgIco('<path d="m8.6 8.6-3.8 3.4 3.8 3.4M15.4 8.6l3.8 3.4-3.8 3.4M13.4 6l-2.8 12"/>'),
  // Rust = cog (the Rust emblem).
  cog: svgIco('<circle cx="12" cy="12" r="2.8"/><path d="M12 2.7v2.3M12 19v2.3M4.5 7.2l2 1.15M17.5 15.65l2 1.15M4.5 16.8l2-1.15M17.5 8.35l2-1.15M2.7 12H5M19 12h2.3"/>'),
  // Config = braces.
  braces: svgIco('<path d="M9.3 4.6c-1.7 0-2.1 1-2.1 2.7 0 1.4-.1 2.7-1.7 3 1.6.3 1.7 1.6 1.7 3 0 1.7.4 2.7 2.1 2.7"/><path d="M14.7 4.6c1.7 0 2.1 1 2.1 2.7 0 1.4.1 2.7 1.7 3-1.6.3-1.7 1.6-1.7 3 0 1.7-.4 2.7-2.1 2.7"/>'),
  md: svgIco(FILE_BODY + '<path d="M8.4 16.6v-3l1.6 1.8 1.6-1.8v3"/>'),
  img: svgIco('<rect x="4" y="5" width="16" height="14" rx="1.6"/><circle cx="9" cy="10" r="1.4"/><path d="m5 17 4.3-3.8 3 2.4L16 11l3 3.4"/>'),
  lock: svgIco('<rect x="5" y="11" width="14" height="9" rx="1.6"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
};

/** Icon + tint class for a file, by extension — mirrors the prototype's palette. */
function fileIcon(name: string): { cls: string; svg: string } {
  const lower = name.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  if (lower.endsWith(".lock")) return { cls: "ic-lock", svg: ICON.lock };
  if (ext === "rs") return { cls: "ic-rs", svg: ICON.cog };
  if (["ts", "tsx"].includes(ext)) return { cls: "ic-ts", svg: ICON.code };
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return { cls: "ic-js", svg: ICON.code };
  if (ext === "py") return { cls: "ic-py", svg: ICON.code };
  if (ext === "go") return { cls: "ic-go", svg: ICON.code };
  if (ext === "toml") return { cls: "ic-toml", svg: ICON.braces };
  if (["json", "yml", "yaml", "ini", "cfg", "conf", "xml"].includes(ext)) return { cls: "ic-cfg", svg: ICON.braces };
  if (["md", "markdown", "txt"].includes(ext)) return { cls: "ic-md", svg: ICON.md };
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return { cls: "ic-img", svg: ICON.img };
  return { cls: "ic-file", svg: ICON.file };
}

// ── Tauri command wrappers (fixed camelCase contract) ────────────────────────

async function cmdPickFolder(): Promise<string | null> {
  return await invoke<string | null>("pick_folder");
}
async function cmdListDir(path: string): Promise<EntryDto[]> {
  return await invoke<EntryDto[]>("list_dir", { path });
}
async function cmdReadFile(path: string): Promise<string> {
  return await invoke<string>("read_text_file", { path });
}
async function cmdWriteFile(path: string, contents: string): Promise<void> {
  await invoke("write_text_file", { path, contents });
}
async function cmdCreatePath(path: string, isDir: boolean): Promise<void> {
  await invoke("create_path", { path, isDir });
}
async function cmdDeletePath(path: string): Promise<void> {
  await invoke("delete_path", { path });
}
async function cmdRenamePath(from: string, to: string): Promise<void> {
  await invoke("rename_path", { from, to });
}
async function cmdRunPath(path: string): Promise<RunResult> {
  return await invoke<RunResult>("run_path", { path });
}

// ── Output panel ─────────────────────────────────────────────────────────────

function showOutput(open: boolean) {
  $("#ws-editor-stack").classList.toggle("out-open", open);
  requestAnimationFrame(() => wsEditor?.layout());
}
// Simple status line (open/save/create/… outcomes) rendered in the same
// run-block shell as a real run, so the Output panel reads consistently.
function writeOutput(title: string, body: string, kind: "ok" | "err" | "info") {
  $("#ws-output").innerHTML =
    `<div class="run-block">` +
    (body ? `<div class="run-sec"><pre class="run-pre">${esc(body)}</pre></div>` : "") +
    `<div class="run-status ${kind}">${esc(title)}</div></div>`;
  showOutput(true);
}

/** Render a cited test run (command + outcome + output) into the Output panel — the
 *  Agent's verify step shows real evidence, not a claim (RF-AG-02). */
export function showTestOutput(command: string, ok: boolean | null, stdout: string, stderr: string): void {
  const body = (stdout || "") + (stderr ? (stdout ? "\n" : "") + stderr : "");
  $("#ws-output").innerHTML =
    `<div class="run-block"><div class="run-sec"><div class="run-cmd">$ ${esc(command)}</div>` +
    (body ? `<pre class="run-pre">${esc(body)}</pre>` : "") +
    `</div><div class="run-status ${ok == null ? "info" : ok ? "ok" : "err"}">` +
    `${ok == null ? "running tests…" : ok ? "✓ tests passed" : "✗ tests failed"}</div></div>`;
  showOutput(true);
}

// A run's output: "$ running <file>" header, stdout / stderr split into
// labelled streams, and a clear exit-state footer. `running` shows a spinner
// and omits the footer while the program is still executing.
function runOutputHtml(name: string, r: RunResult | null, running: boolean): string {
  const header =
    `<div class="run-cmd"><span class="run-prompt">$</span> running <b>${esc(name)}</b>` +
    (running ? `<span class="run-spin"></span>` : ``) +
    `</div>`;
  if (!r) return `<div class="run-block">${header}</div>`;

  const out = (r.stdout ?? "").replace(/\s+$/, "");
  const err = (r.stderr ?? "").replace(/\s+$/, "");
  let streams = "";
  if (out)
    streams += `<div class="run-sec"><div class="run-sec-h">stdout</div><pre class="run-pre">${esc(out)}</pre></div>`;
  if (err)
    streams += `<div class="run-sec err"><div class="run-sec-h">stderr</div><pre class="run-pre">${esc(err)}</pre></div>`;
  if (!streams) streams = `<div class="run-sec"><pre class="run-pre run-muted">(no output)</pre></div>`;

  const status = r.ok
    ? `<div class="run-status ok">Finished — ${esc(name)}</div>`
    : `<div class="run-status err">Exited with error — ${esc(name)}</div>`;
  return `<div class="run-block">${header}${streams}${status}</div>`;
}

// ── File tree (lazy) ─────────────────────────────────────────────────────────

async function loadChildren(dir: string): Promise<EntryDto[]> {
  if (childrenCache.has(dir)) return childrenCache.get(dir)!;
  const entries = await cmdListDir(dir);
  // Dirs first, then files; each alphabetical (case-insensitive).
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  childrenCache.set(dir, entries);
  return entries;
}

/** Reload the git decorations for the open workspace (no-op outside Tauri / a repo). */
async function refreshGitStatus(): Promise<void> {
  gitDeco = rootPath && hasTauri ? await gitStatusMap(rootPath) : new Map();
  updateGitBadge();
}

/** Badge the Source Control activity-bar icon with the change count (prototype parity). */
function updateGitBadge(): void {
  const btn = document.querySelector('.act[data-view="git"]');
  if (!btn) return;
  const n = gitDeco.size;
  let badge = btn.querySelector(".act-badge");
  if (!n) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "act-badge";
    btn.appendChild(badge);
  }
  badge.textContent = n > 99 ? "99+" : String(n);
}

/** Roll-up colour for a folder: the strongest git state among its descendants, or null
 *  when the subtree is clean. Deletion dominates, then modified, then untracked/added. */
function dirRollup(dir: string): GitDeco["cls"] | null {
  const prefix = dir.replace(/\/+$/, "") + "/";
  let found: GitDeco["cls"] | null = null;
  for (const [p, d] of gitDeco) {
    if (!p.startsWith(prefix)) continue;
    if (d.cls === "git-d") return "git-d";
    if (d.cls === "git-m") found = "git-m";
    else if (!found) found = "git-u";
  }
  return found;
}

function rowHtml(entry: EntryDto, depth: number): string {
  const pad = 8 + depth * 12;
  const guide = depth > 0 ? ` has-guide" style="--d:${depth};padding-left:` : `" style="padding-left:`;
  if (entry.isDir) {
    const open = expanded.has(entry.path);
    const caret = open ? "▾" : "▸";
    // Roll-up: a discreet dot when any descendant is dirty (name stays uncoloured for dirs).
    const roll = dirRollup(entry.path);
    const dot = roll ? `<span class="ws-git-dot ws-git-dot-${roll.slice(4)}"></span>` : "";
    return (
      `<div class="ws-row ws-dir${guide}${pad}px" role="treeitem" data-path="${esc(entry.path)}" data-dir="1" ` +
      `title="${esc(entry.path)}">` +
      `<span class="ws-caret">${caret}</span>` +
      `<span class="ws-icon ic-folder">${open ? ICON.folderOpen : ICON.folder}</span>` +
      `<span class="ws-name">${esc(entry.name)}</span>${dot}</div>`
    );
  }
  const fi = fileIcon(entry.name);
  // Git decoration: colour the name (via the row class) + a status letter at the right edge.
  const g = gitDeco.get(entry.path);
  const gitCls = g ? ` ${g.cls}` : "";
  const gitBadge = g ? `<span class="ws-git">${esc(g.letter)}</span>` : "";
  return (
    `<div class="ws-row ws-file${gitCls}${guide}${pad + 14}px" role="treeitem" data-path="${esc(entry.path)}" ` +
    `title="${esc(entry.path)}">` +
    `<span class="ws-icon ${fi.cls}">${fi.svg}</span>` +
    `<span class="ws-name">${esc(entry.name)}</span>${gitBadge}</div>`
  );
}

async function renderTree() {
  const host = $("#ws-tree");
  if (!rootPath) {
    host.innerHTML = "";
    $("#ws-empty").classList.remove("hidden");
    $("#ws-root-title").textContent = t("ws.noFolder");
    return;
  }
  $("#ws-empty").classList.add("hidden");
  $("#ws-root-title").textContent = baseName(rootPath).toUpperCase();

  // Build the visible rows by walking expanded directories depth-first.
  const parts: string[] = [];
  const walk = async (dir: string, depth: number) => {
    const entries = await loadChildren(dir);
    for (const e of entries) {
      parts.push(rowHtml(e, depth));
      if (e.isDir && expanded.has(e.path)) await walk(e.path, depth + 1);
    }
  };
  try {
    await walk(rootPath, 0);
    host.innerHTML = parts.join("");
    highlightActiveRow();
  } catch (err) {
    host.innerHTML = `<div class="ws-tree-error">Could not read folder:<br>${esc(String(err))}</div>`;
  }
}

function highlightActiveRow() {
  document.querySelectorAll("#ws-tree .ws-row").forEach((el) => {
    const path = (el as HTMLElement).dataset.path;
    el.classList.toggle("active", path != null && path === activeTabPath);
  });
}

async function toggleDir(path: string) {
  if (expanded.has(path)) expanded.delete(path);
  else {
    expanded.add(path);
    await loadChildren(path); // ensure cached before re-render
  }
  saveExpanded();
  await renderTree();
}

// Refresh a directory's listing from disk and re-render. Also re-reads git state, since
// the caller (create / delete / rename) just changed the working tree.
async function refreshDir(dir: string) {
  childrenCache.delete(dir);
  if (dir === rootPath || expanded.has(dir)) await loadChildren(dir);
  await refreshGitStatus();
  await renderTree();
  await loadSectionData(); // a new/removed Cargo.lock or commit may change Timeline/Deps
  void renderSections();
}

// ── Explorer sections: Outline / Timeline / Rust Dependencies ──────────────────
// Collapsible sections below the file tree (prototype parity). All real data, no new
// backend command: Outline = `file_outline` (symbols of the ACTIVE file, click to jump);
// Timeline = `git_log` (recent repo commits); Rust Dependencies = the resolved crates
// parsed from the nearest Cargo.lock. Timeline/Deps are cached per workspace; Outline
// refreshes with the active file.
interface OutlineSym { name: string; kind: string; startLine: number; endLine: number }
interface GitCommitDto { short: string; subject: string; date: string; author: string }
function loadSections(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS.sections) ?? "");
    if (Array.isArray(v)) return v as string[];
  } catch { /* default below */ }
  return ["outline", "deps"];
}
const SEC_OPEN = new Set<string>(loadSections());
const saveSections = () => localStorage.setItem(LS.sections, JSON.stringify([...SEC_OPEN]));
let secTimeline: GitCommitDto[] = [];
let secDeps: Array<{ name: string; ver: string }> = [];
let sectionsBound = false;

/** A quiet mono glyph + tint class for an outline symbol, by kind. */
function outlineGlyph(kind: string): string {
  const map: Record<string, [string, string]> = {
    function: ["ƒ", "ic-ts"], method: ["ƒ", "ic-ts"], fn: ["ƒ", "ic-ts"],
    struct: ["◇", "ic-cfg"], class: ["◇", "ic-cfg"],
    enum: ["▽", "ic-img"], union: ["▽", "ic-img"],
    trait: ["◈", "ic-ts"], interface: ["◈", "ic-ts"],
    impl: ["⊞", "ic-py"], module: ["▤", "ic-folder"], mod: ["▤", "ic-folder"],
    const: ["c", "ic-toml"], static: ["c", "ic-toml"], field: ["•", "ic-file"],
  };
  const [g, cls] = map[kind.toLowerCase()] ?? ["·", "ic-file"];
  return `<span class="ws-sec-glyph ${cls}">${g}</span>`;
}

/** Every resolved crate in a Cargo.lock (name + version), sorted — like the prototype. */
function cargoLockCrates(text: string): Array<{ name: string; ver: string }> {
  const out: Array<{ name: string; ver: string }> = [];
  let name = "";
  for (const line of text.split("\n")) {
    const n = /^name\s*=\s*"(.+?)"/.exec(line);
    const v = /^version\s*=\s*"(.+?)"/.exec(line);
    if (n) name = n[1];
    else if (v && name) { out.push({ name, ver: v[1] }); name = ""; }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fetch the per-workspace section data (Timeline + Rust deps) once per mount/refresh. */
async function loadSectionData(): Promise<void> {
  secTimeline = [];
  secDeps = [];
  if (!rootPath || !hasTauri) return;
  try { secTimeline = await invoke<GitCommitDto[]>("git_log", { root: rootPath, max: 8 }); } catch { /* not a repo */ }
  try { secDeps = cargoLockCrates(await cmdReadFile(rootPath + "/Cargo.lock")); } catch { /* no Cargo.lock */ }
}

function sectionHtml(key: string, label: string, count: string, body: string): string {
  const open = SEC_OPEN.has(key);
  return (
    `<div class="ws-section${open ? " open" : ""}" data-section="${key}">` +
    `<div class="ws-sec-hd" data-sec="${key}"><span class="ws-sec-chev">▸</span>` +
    `<span class="ws-sec-lbl">${label}</span>${count ? `<span class="ws-sec-cnt">${count}</span>` : ""}</div>` +
    `<div class="ws-sec-body">${body}</div></div>`
  );
}

/** Rebuild the Explorer sections. Outline is fetched here (per active file); Timeline/Deps
 *  come from the per-workspace cache (`loadSectionData`). */
async function renderSections(): Promise<void> {
  const host = document.getElementById("ws-sections");
  if (!host) return;
  if (!rootPath) { host.innerHTML = ""; return; }

  // Outline — symbols of the active file (best-effort; Rust/Go/etc via the parser/LSP).
  let outlineBody = `<div class="ws-sec-empty">Abre um ficheiro para ver a estrutura.</div>`;
  let outlineCount = "";
  const tab = activeTabPath && activeTabPath !== EXPLAIN_TAB ? tabByPath(activeTabPath) : undefined;
  if (tab) {
    outlineBody = `<div class="ws-sec-empty">Sem símbolos neste ficheiro.</div>`;
    try {
      const syms = await invoke<OutlineSym[]>("file_outline", {
        code: tab.model.getValue(), lang: langForFile(tab.name), root: rootPath, file: tab.path,
      });
      if (syms.length) {
        outlineCount = String(syms.length);
        outlineBody = syms
          .map((s) =>
            `<div class="ws-sec-row" data-line="${s.startLine}" title="${esc(s.kind)} · L${s.startLine}">` +
            `${outlineGlyph(s.kind)}<span class="ws-sec-name">${esc(s.name)}</span>` +
            `<span class="ws-sec-meta">${s.startLine}</span></div>`)
          .join("");
      }
    } catch { /* outline best-effort */ }
  }

  // Timeline — recent repo commits.
  const timelineBody = secTimeline.length
    ? secTimeline
        .map((c) =>
          `<div class="ws-sec-row" title="${esc(c.author)} · ${esc(c.date)}">` +
          `<span class="ws-sec-glyph ic-toml">●</span><span class="ws-sec-name">${esc(c.subject)}</span>` +
          `<span class="ws-sec-meta">${esc(c.short)}</span></div>`)
        .join("")
    : `<div class="ws-sec-empty">Sem histórico git.</div>`;

  // Rust Dependencies — resolved crates from Cargo.lock (capped, scrollable).
  const CAP = 200;
  const depsBody = secDeps.length
    ? secDeps
        .slice(0, CAP)
        .map((d) =>
          `<div class="ws-sec-row"><span class="ws-sec-glyph ic-rs">${svgIco('<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>')}</span>` +
          `<span class="ws-sec-name">${esc(d.name)}</span><span class="ws-sec-meta">${esc(d.ver)}</span></div>`)
        .join("") +
      (secDeps.length > CAP ? `<div class="ws-sec-empty">+${secDeps.length - CAP} mais…</div>` : "")
    : `<div class="ws-sec-empty">Sem Cargo.lock.</div>`;

  host.innerHTML =
    sectionHtml("outline", "Outline", outlineCount, outlineBody) +
    sectionHtml("timeline", "Timeline", secTimeline.length ? String(secTimeline.length) : "", timelineBody) +
    sectionHtml("deps", "Rust Dependencies", secDeps.length ? String(secDeps.length) : "", depsBody);
  bindSections();
}

/** One delegated listener: toggle a section, or jump to an outline symbol's line. */
function bindSections(): void {
  if (sectionsBound) return;
  const host = document.getElementById("ws-sections");
  if (!host) return;
  sectionsBound = true;
  host.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const hd = target.closest<HTMLElement>(".ws-sec-hd");
    if (hd) {
      const key = hd.dataset.sec!;
      if (SEC_OPEN.has(key)) SEC_OPEN.delete(key);
      else SEC_OPEN.add(key);
      hd.parentElement?.classList.toggle("open", SEC_OPEN.has(key));
      saveSections();
      return;
    }
    const row = target.closest<HTMLElement>(".ws-sec-row[data-line]");
    if (row && wsEditor) {
      const ln = Number(row.dataset.line);
      if (ln > 0) {
        wsEditor.setPosition({ lineNumber: ln, column: 1 });
        wsEditor.revealPositionInCenter({ lineNumber: ln, column: 1 });
        wsEditor.focus();
      }
    }
  });
}

/** The active file's path as clickable `›`-separated breadcrumb segments (prototype
 *  parity): workspace root → … → file (with its type icon). Empty for Explain/no file. */
function renderBreadcrumbs(): void {
  const host = document.getElementById("ws-breadcrumbs");
  if (!host) return;
  const path = activeTabPath && activeTabPath !== EXPLAIN_TAB ? activeTabPath : null;
  if (!path || !rootPath) {
    host.innerHTML = "";
    return;
  }
  const rel = path.startsWith(rootPath) ? path.slice(rootPath.length).replace(/^\/+/, "") : baseName(path);
  const parts = [baseName(rootPath), ...rel.split("/").filter(Boolean)];
  const fi = fileIcon(baseName(path));
  host.innerHTML = parts
    .map((seg, i) => {
      const isFile = i === parts.length - 1;
      const icon = isFile ? `<span class="${fi.cls}">${fi.svg}</span>` : "";
      return `<span class="bc-seg${isFile ? " file" : ""}">${icon}${esc(seg)}</span>`;
    })
    .join(`<span class="bc-sep">›</span>`);
}

// ── Tabs + editor ─────────────────────────────────────────────────────────────

function renderTabs() {
  const host = $("#ws-tabs");
  if (!tabs.length && !explainTab) {
    host.innerHTML = "";
    $("#ws-welcome").classList.toggle("hidden", rootPath != null);
    return;
  }
  $("#ws-welcome").classList.add("hidden");
  let html = tabs
    .map((t) => {
      // O(1) dirty check (alternativeVersionId) — avoids a full-buffer compare per keystroke,
      // which would lag on large files (RF-UI-05).
      const dirty = t.model.getAlternativeVersionId() !== t.savedVersionId;
      const active = t.path === activeTabPath;
      const mark = dirty
        ? `<span class="ws-tab-dot" title="Unsaved changes">●</span>`
        : `<span class="ws-tab-close" data-close="${esc(t.path)}" title="Close">✕</span>`;
      const fi = fileIcon(t.name);
      return (
        `<div class="tab ws-tab${active ? " active" : ""}" data-tab="${esc(t.path)}" title="${esc(t.path)}">` +
        `<span class="file-icon ${fi.cls}">${fi.svg}</span>` +
        `<span class="ws-tab-name">${esc(t.name)}</span>${mark}</div>`
      );
    })
    .join("");
  if (explainTab) {
    const active = activeTabPath === EXPLAIN_TAB;
    html +=
      `<div class="tab ws-tab explain-tab${active ? " active" : ""}" data-tab="${EXPLAIN_TAB}" title="Explain: ${esc(explainTab.name)}">` +
      `<span class="file-icon ic-explain">${svgIco('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.8 10.6c.6.5.8 1.1.8 1.9h6c0-.8.2-1.4.8-1.9A6 6 0 0 0 12 3Z"/>')}</span>` +
      `<span class="ws-tab-name">Explain: ${esc(explainTab.name)}</span>` +
      `<span class="ws-tab-close" data-close="${EXPLAIN_TAB}" title="Close">✕</span></div>`;
  }
  host.innerHTML = html;
}

function tabByPath(path: string): Tab | undefined {
  return tabs.find((t) => t.path === path);
}

/** Persist the open tabs + active tab for THIS folder, so a restart can reopen them. */
function saveOpenTabs() {
  if (!rootPath) return;
  localStorage.setItem(
    LS.tabs,
    JSON.stringify({ folder: rootPath, paths: tabs.map((t) => t.path), active: activeTabPath }),
  );
}

/** Reopen the tabs saved for `root` (section 5 — buffer recovery after restart). Skips
 *  files that no longer exist; restores the previously-active tab. */
async function restoreTabs(root: string) {
  let saved: { folder?: string; paths?: string[]; active?: string } = {};
  try {
    saved = JSON.parse(localStorage.getItem(LS.tabs) ?? "{}");
  } catch {
    return;
  }
  if (saved.folder !== root || !Array.isArray(saved.paths)) return;
  for (const p of saved.paths) {
    if (!tabByPath(p)) await openFile(p); // openFile reads from disk; missing files no-op
  }
  if (saved.active && tabByPath(saved.active)) setActiveTab(saved.active);
}

function setActiveTab(path: string) {
  // Explain tab: SPLIT the editor area — the explained file's code on the left, the summary
  // on the right, both visible side by side.
  if (path === EXPLAIN_TAB) {
    if (!explainTab || !wsEditor) return;
    activeTabPath = EXPLAIN_TAB;
    const region = $("#ws-editor-region");
    region.classList.remove("explain-split", "explain-full");
    const fileTab = explainTab.path ? tabByPath(explainTab.path) : null;
    if (fileTab) {
      applyingModel = true;
      wsEditor.setModel(fileTab.model); // left pane shows the explained file
      applyingModel = false;
      region.classList.add("explain-split"); // code | summary
    } else {
      region.classList.add("explain-full"); // module summary takes the whole area
    }
    $("#ws-welcome").classList.add("hidden");
    $("#explain-panel").classList.remove("hidden");
    renderTabs();
    renderBreadcrumbs(); // Explain tab → clear (no single file path)
    requestAnimationFrame(() => wsEditor?.layout());
    return;
  }
  const tab = tabByPath(path);
  if (!tab || !wsEditor) return;
  activeTabPath = path;
  $("#ws-editor-region").classList.remove("explain-split", "explain-full"); // leaving → code full
  $("#explain-panel").classList.add("hidden");
  applyingModel = true;
  wsEditor.setModel(tab.model); // model carries its own breakpoint decorations
  applyingModel = false;
  $("#ws-welcome").classList.add("hidden");
  saveOpenTabs();
  renderTabs();
  highlightActiveRow();
  renderBreadcrumbs();
  void renderSections(); // refresh the Outline for the newly-active file
  requestAnimationFrame(() => {
    wsEditor?.layout();
    wsEditor?.focus();
  });
}

async function openFile(path: string) {
  const existing = tabByPath(path);
  if (existing) {
    setActiveTab(path);
    return;
  }
  let contents = "";
  try {
    contents = await cmdReadFile(path);
  } catch (err) {
    writeOutput("Open failed", String(err), "err");
    return;
  }
  const name = baseName(path);
  const model = monaco.editor.createModel(contents, langForFile(name));
  let autosaveTimer: number | undefined;
  model.onDidChangeContent(() => {
    if (!applyingModel) renderTabs();
    // Autosave: persist this file a short while after the last edit (VSCode's afterDelay).
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      const tab = tabs.find((tb) => tb.model === model);
      if (tab) void autosaveTab(tab);
    }, 1200);
  });
  tabs.push({ path, name, model, saved: contents, savedVersionId: model.getAlternativeVersionId() });
  restoreBreakpointsFor(path); // re-create any breakpoints saved for this file last session
  // Files in a supported language get semantic power from their LSP server (rust-analyzer,
  // gopls, typescript-language-server, pyright): open the document and stream edits
  // (debounced) so navigation, rename and diagnostics stay in sync.
  const lspLang = langForFile(name);
  if (rootPath && (LSP_LANGUAGES as readonly string[]).includes(lspLang)) {
    // Opening the doc auto-starts the server rooted at THIS file's project (nearest
    // marker: Cargo.toml / go.mod / tsconfig / pyproject) — a small, fast index even
    // inside a huge monorepo. An uninstalled server is a silent no-op (backend returns none).
    void lspDidOpen(path, contents, lspLang).catch(() => {});
    let ver = 1;
    let changeTimer: number | undefined;
    model.onDidChangeContent(() => {
      window.clearTimeout(changeTimer);
      changeTimer = window.setTimeout(() => {
        void lspDidChange(path, model.getValue(), ++ver).catch(() => {});
        if (path === activeTabPath) void renderSections(); // keep the Outline live as you type
      }, 250);
    });
  }
  setActiveTab(path);
}

function closeTab(path: string) {
  // Close the Explain tab: drop it, leave the split, and fall back to a file tab.
  if (path === EXPLAIN_TAB) {
    explainTab = null;
    $("#explain-panel").classList.add("hidden");
    $("#ws-editor-region").classList.remove("explain-split", "explain-full");
    if (activeTabPath === EXPLAIN_TAB) {
      activeTabPath = null;
      const next = tabs[tabs.length - 1];
      if (next) setActiveTab(next.path);
      else {
        requestAnimationFrame(() => wsEditor?.layout());
        renderTabs();
      }
    } else {
      renderTabs();
    }
    return;
  }
  const idx = tabs.findIndex((t) => t.path === path);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.model.getValue() !== tab.saved) {
    if (!confirm(`"${tab.name}" has unsaved changes. Close without saving?`)) return;
  }
  tab.model.dispose();
  tabs.splice(idx, 1);
  if (activeTabPath === path) {
    const next = tabs[idx] ?? tabs[idx - 1] ?? null;
    if (next) setActiveTab(next.path);
    else {
      activeTabPath = null;
      applyingModel = true;
      wsEditor?.setModel(monaco.editor.createModel("", "plaintext"));
      applyingModel = false;
      $("#ws-welcome").classList.toggle("hidden", rootPath != null && tabs.length > 0);
      renderTabs();
      highlightActiveRow();
    }
  } else {
    renderTabs();
  }
  saveOpenTabs();
}

async function saveActive(): Promise<boolean> {
  const tab = activeTabPath ? tabByPath(activeTabPath) : undefined;
  if (!tab) return false;
  const value = tab.model.getValue();
  try {
    await cmdWriteFile(tab.path, value);
    tab.saved = value;
    tab.savedVersionId = tab.model.getAlternativeVersionId();
    renderTabs();
    await refreshGitStatus(); // the saved file may have just become dirty/clean in git
    await renderTree();
    return true;
  } catch (err) {
    writeOutput("Save failed", String(err), "err");
    return false;
  }
}

/** Lightweight autosave for one tab: write it and drop the dirty dot, without the heavy
 *  git/tree refresh of a manual Save. Best-effort (manual Save surfaces errors). Skipped
 *  while an AI proposal is mid-stream or under review, so an un-accepted edit isn't persisted. */
async function autosaveTab(tab: Tab): Promise<void> {
  if (rangeStream || rangeReview) return; // don't persist an un-accepted agent proposal
  const value = tab.model.getValue();
  if (value === tab.saved) return; // nothing changed since the last save
  try {
    await cmdWriteFile(tab.path, value);
    tab.saved = value;
    tab.savedVersionId = tab.model.getAlternativeVersionId();
    renderTabs();
  } catch {
    /* autosave is best-effort — a manual Save will surface any real error */
  }
}

async function saveAll() {
  for (const tab of tabs) {
    const value = tab.model.getValue();
    if (value === tab.saved) continue;
    try {
      await cmdWriteFile(tab.path, value);
      tab.saved = value;
      tab.savedVersionId = tab.model.getAlternativeVersionId();
    } catch (err) {
      writeOutput("Save All failed", `${tab.name}: ${String(err)}`, "err");
      renderTabs();
      return;
    }
  }
  renderTabs();
  await refreshGitStatus();
  await renderTree();
}

async function runActive() {
  const tab = activeTabPath ? tabByPath(activeTabPath) : undefined;
  if (!tab) {
    writeOutput("Nothing to run", "Open a file first.", "info");
    return;
  }
  if (tab.model.getValue() !== tab.saved) await saveActive();
  // Clear and show the running header (with spinner) for this execution.
  $("#ws-output").innerHTML = runOutputHtml(tab.name, null, true);
  showOutput(true);
  try {
    // Agent routing: when a persistent container session is running, execute the file
    // with the CONTAINER's toolchain (devcontainer_session_run); else run on the host.
    let inContainer = false;
    if (rootPath) {
      try {
        inContainer = (
          await invoke<{ running: boolean }>("devcontainer_session_status", { root: rootPath })
        ).running;
      } catch {
        /* no session → host */
      }
    }
    if (inContainer && rootPath) {
      const r = await invoke<RunResult>("devcontainer_session_run", {
        root: rootPath,
        file: tab.path,
      });
      $("#ws-output").innerHTML = runOutputHtml(`${tab.name}  ·  in container`, r, false);
    } else {
      const r = await cmdRunPath(tab.path);
      $("#ws-output").innerHTML = runOutputHtml(tab.name, r, false);
    }
    showOutput(true);
  } catch (err) {
    writeOutput("Run failed", String(err), "err");
  }
}

// ── Create / delete / rename ──────────────────────────────────────────────────

// The directory a new entry should be created in: the selected dir (if a dir
// row is focused) else the parent of the active file, else the root.
function targetDir(): string | null {
  if (!rootPath) return null;
  const sel = document.querySelector("#ws-tree .ws-row.active") as HTMLElement | null;
  if (sel?.dataset.dir === "1" && sel.dataset.path) return sel.dataset.path;
  if (activeTabPath) return parentOf(activeTabPath);
  return rootPath;
}

async function createEntry(isDir: boolean, baseDir?: string) {
  const dir = baseDir ?? targetDir();
  if (!dir) {
    writeOutput("No folder", "Open a folder first.", "info");
    return;
  }
  const name = prompt(isDir ? "New folder name:" : "New file name:");
  if (!name || !name.trim()) return;
  const path = joinPath(dir, name.trim());
  try {
    await cmdCreatePath(path, isDir);
  } catch (err) {
    writeOutput("Create failed", String(err), "err");
    return;
  }
  if (!expanded.has(dir) && dir !== rootPath) {
    expanded.add(dir);
    saveExpanded();
  }
  await refreshDir(dir);
  if (!isDir) await openFile(path);
}

async function deleteEntry(path: string) {
  if (!confirm(`Delete "${baseName(path)}"? This cannot be undone.`)) return;
  try {
    await cmdDeletePath(path);
  } catch (err) {
    writeOutput("Delete failed", String(err), "err");
    return;
  }
  // Close any open tabs under this path.
  for (const t of [...tabs]) {
    if (t.path === path || t.path.startsWith(path + "/") || t.path.startsWith(path + "\\")) {
      t.model.dispose();
      tabs.splice(tabs.indexOf(t), 1);
      if (activeTabPath === t.path) activeTabPath = null;
    }
  }
  if (!activeTabPath && tabs.length) setActiveTab(tabs[tabs.length - 1].path);
  renderTabs();
  childrenCache.delete(path);
  await refreshDir(parentOf(path));
}

async function renameEntry(path: string) {
  const current = baseName(path);
  const name = prompt("Rename to:", current);
  if (!name || !name.trim() || name.trim() === current) return;
  const to = joinPath(parentOf(path), name.trim());
  try {
    await cmdRenamePath(path, to);
  } catch (err) {
    writeOutput("Rename failed", String(err), "err");
    return;
  }
  // Re-point any open tab(s) for the renamed path.
  for (const t of tabs) {
    if (t.path === path) {
      t.path = to;
      t.name = name.trim();
      if (activeTabPath === path) activeTabPath = to;
    }
  }
  childrenCache.delete(path);
  expanded.delete(path);
  saveExpanded();
  renderTabs();
  await refreshDir(parentOf(path));
}

// ── Context menu ──────────────────────────────────────────────────────────────

function closeContextMenu() {
  document.getElementById("ws-ctx")?.remove();
}

function openContextMenu(x: number, y: number, path: string, isDir: boolean) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.id = "ws-ctx";
  menu.className = "ws-ctx";
  const items: Array<[string, () => void]> = [];
  if (isDir) {
    items.push(["New File", () => void createEntry(false, path)]);
    items.push(["New Folder", () => void createEntry(true, path)]);
    items.push(["Explain folder (AI)", () => explainFolderHandler(path)]);
  }
  items.push(["Rename", () => void renameEntry(path)]);
  items.push(["Delete", () => void deleteEntry(path)]);
  menu.innerHTML = items
    .map((_, i) => `<button class="ws-ctx-item" data-i="${i}">${esc(items[i][0])}</button>`)
    .join("");
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  menu.querySelectorAll(".ws-ctx-item").forEach((btn) =>
    btn.addEventListener("click", () => {
      const i = Number((btn as HTMLElement).dataset.i);
      closeContextMenu();
      items[i][1]();
    }),
  );
}

// ── Open folder ───────────────────────────────────────────────────────────────

async function openFolder() {
  if (!hasTauri) {
    writeOutput(
      "Workspace unavailable",
      "The file system is only available in the desktop app (npm run tauri dev).",
      "info",
    );
    return;
  }
  let picked: string | null = null;
  try {
    picked = await cmdPickFolder();
  } catch (err) {
    writeOutput("Open Folder failed", String(err), "err");
    return;
  }
  if (!picked) return;
  await mountRoot(picked);
}

/** Clone the URL from the Welcome form into a user-picked parent folder, then mount it. */
async function cloneRepo() {
  if (!hasTauri) {
    writeOutput("Clone unavailable", "Cloning is only available in the desktop app.", "info");
    return;
  }
  const input = $("#ws-clone-url") as HTMLInputElement;
  const url = input.value.trim();
  if (!url) return;
  let parent: string | null = null;
  try {
    parent = await cmdPickFolder();
  } catch (err) {
    writeOutput("Clone failed", String(err), "err");
    return;
  }
  if (!parent) return;
  const go = $("#ws-clone-go") as HTMLButtonElement;
  go.disabled = true;
  try {
    const dir = await invoke<string>("git_clone", { url, parentDir: parent });
    input.value = "";
    $("#ws-clone-form").classList.add("hidden");
    await mountRoot(dir);
  } catch (err) {
    writeOutput("Clone failed", String(err), "err");
  } finally {
    go.disabled = false;
  }
}

async function mountRoot(path: string) {
  rootPath = path;
  localStorage.setItem(LS.folder, path);
  pushRecent(path);
  renderRecents();
  const tmuxHost = document.getElementById("tmux-host"); // real project name in the terminal strip
  if (tmuxHost) tmuxHost.textContent = baseName(path);
  childrenCache.clear();
  // Keep only expanded dirs that are under the new root.
  for (const p of [...expanded]) {
    if (p !== path && !p.startsWith(path + "/") && !p.startsWith(path + "\\")) expanded.delete(p);
  }
  saveExpanded();
  await refreshGitStatus(); // load git decorations once for this workspace
  await renderTree();
  await loadSectionData(); // Timeline + Rust deps for this workspace
  void renderSections();
  await restoreTabs(path); // reopen the files that were open last time (buffer recovery)
}

// ── Public API ─────────────────────────────────────────────────────────────

export function initWorkspace() {
  wsEditor = monaco.editor.create($("#ws-editor"), {
    value: "",
    language: "plaintext",
    theme: "dxtutor-dark", // defined by main.ts's setupEditor()
    automaticLayout: true,
    fontFamily: '"Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
    fontSize: 13,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    padding: { top: 10 },
    tabSize: 4,
    glyphMargin: true, // breakpoint dots live here
  });

  // Wire rust-analyzer onto the workspace editor: Ctrl+Click/F12 → definition,
  // Shift+F12 → references, F2 → recursive rename, hover + diagnostics.
  const lspHost: LspHost = {
    root: () => rootPath,
    pathForModel: (model) => tabs.find((tb) => tb.model === model)?.path ?? null,
    modelForPath: (p) => tabByPath(p)?.model ?? null,
    openAt: async (p, line, col) => {
      await openFile(p);
      const tab = tabByPath(p);
      if (tab && wsEditor) {
        if (wsEditor.getModel() !== tab.model) wsEditor.setModel(tab.model);
        const position = { lineNumber: line, column: col };
        wsEditor.setPosition(position);
        wsEditor.revealPositionInCenter(position);
        wsEditor.focus();
        // Gentle flash on the landed line that fades out (symbol-navigation feedback).
        const dec = wsEditor.deltaDecorations([], [
          { range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "lsp-reveal-flash" } },
        ]);
        window.setTimeout(() => wsEditor?.deltaDecorations(dec, []), 1300);
      }
    },
    readFile: (p) => cmdReadFile(p),
    writeFile: (p, text) => cmdWriteFile(p, text),
    promptRename: (current) => window.prompt("Renomear símbolo para:", current),
    notify: (msg) => writeOutput("Rust LSP", msg, "info"),
  };
  installLsp(monaco, wsEditor, lspHost);

  // Click the glyph margin / line-number to toggle a breakpoint (VSCode-style); Alt+click
  // sets a CONDITION (stop only when it holds). Debug (the tracer) stops at these lines.
  wsEditor.onMouseDown((e) => {
    const t = monaco.editor.MouseTargetType;
    if (e.target.type !== t.GUTTER_GLYPH_MARGIN && e.target.type !== t.GUTTER_LINE_NUMBERS) return;
    const line = e.target.position?.lineNumber;
    if (!line || !activeTabPath || activeTabPath === EXPLAIN_TAB) return;
    if (e.event.altKey) {
      const existing = fileBreakpoints(activeTabPath).find((b) => b.line === line)?.condition ?? "";
      const cond = window.prompt("Breakpoint condition (e.g. i == 3). Empty = unconditional:", existing);
      if (cond !== null) setBreakpointCondition(activeTabPath, line, cond.trim());
    } else {
      toggleBreakpoint(activeTabPath, line);
    }
  });

  // Ctrl+S inside the editor saves the active tab.
  wsEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveActive());

  // "Go to Definition" (F12): resolve via rust-analyzer and jump to the exact symbol;
  // fall back to the syntactic CodeMap when it can't resolve (absent/unindexed/non-Rust).
  wsEditor.addAction({
    id: "dxtutor.goToDefinition",
    label: "Go to Definition",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.4,
    keybindings: [monaco.KeyCode.F12],
    run: (ed) => void goToDefinition(ed),
  });

  // "Show in CodeMap" on the symbol under the cursor (context menu + Alt+F12).
  wsEditor.addAction({
    id: "dxtutor.showInCodeMap",
    label: "Show in CodeMap",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.5,
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F12],
    run: (ed) => {
      const pos = ed.getPosition();
      const word = pos ? ed.getModel()?.getWordAtPosition(pos)?.word : null;
      if (word && codeMapHandler) {
        // Pass the cursor position + live buffer so the CodeMap can try a resolved map.
        const ctx =
          pos && activeTabPath
            ? { file: activeTabPath, line: pos.lineNumber, col: pos.column, text: ed.getModel()?.getValue() }
            : undefined;
        codeMapHandler(word, ctx);
      }
    },
  });

  // "Show type" (Ctrl+K Ctrl+I): rust-analyzer hover for the symbol under the cursor.
  wsEditor.addAction({
    id: "dxtutor.showType",
    label: "Show type (rust-analyzer)",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.45,
    keybindings: [monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI)],
    run: (ed) => void showType(ed),
  });

  // "Edit with AI" — delegate an interruptible edit of the active file (Alt+I).
  wsEditor.addAction({
    id: "dxtutor.editWithAI",
    label: "Edit with AI",
    contextMenuGroupId: "modification",
    contextMenuOrder: 1.5,
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyI],
    run: (ed) => {
      const model = ed.getModel();
      if (activeTabPath && model && editHandler) {
        editHandler(activeTabPath, model.getValue(), model.getLanguageId());
      }
    },
  });

  // "Improve this block" (Alt+E) — localized edit of ONLY the selection: streams a
  // replacement into just that range, leaving the rest of the file untouched.
  wsEditor.addAction({
    id: "dxtutor.editSelection",
    label: "Improve this block (AI)",
    contextMenuGroupId: "modification",
    contextMenuOrder: 1.4,
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyE],
    run: (ed) => {
      const sel = ed.getSelection();
      const model = ed.getModel();
      if (!sel || sel.isEmpty() || !model || !activeTabPath || !localizedEditHandler) return;
      const selected = model.getValueInRange(sel);
      localizedEditHandler(activeTabPath, sel.startLineNumber, sel.endLineNumber, selected, model.getLanguageId());
    },
  });

  // "Add main entrypoint" — append a runnable entry (fn main / func main / __main__) if
  // the file lacks one, as a reviewed edit. Context menu.
  wsEditor.addAction({
    id: "dxtutor.addEntrypoint",
    label: "Add main entrypoint (AI)",
    contextMenuGroupId: "modification",
    contextMenuOrder: 1.46,
    run: (ed) => {
      const model = ed.getModel();
      if (activeTabPath && model && entrypointHandler) {
        entrypointHandler(activeTabPath, model.getValue(), model.getLanguageId());
      }
    },
  });

  // "Improve a method by name" — localized edit of a named Rust fn/method (no selection
  // needed); disambiguates homonyms. Context menu + command palette.
  wsEditor.addAction({
    id: "dxtutor.editMethodByName",
    label: "Improve a method by name (AI)",
    contextMenuGroupId: "modification",
    contextMenuOrder: 1.45,
    run: (ed) => {
      const model = ed.getModel();
      if (activeTabPath && model && methodEditHandler) {
        methodEditHandler(activeTabPath, model.getValue(), model.getLanguageId());
      }
    },
  });

  // Sidebar header actions.
  $("#ws-act-open").addEventListener("click", () => void openFolder());
  $("#ws-act-newfile").addEventListener("click", () => void createEntry(false));
  $("#ws-act-newfolder").addEventListener("click", () => void createEntry(true));
  $("#ws-act-refresh").addEventListener("click", () => {
    childrenCache.clear();
    void refreshGitStatus().then(() => renderTree());
  });
  $("#ws-open-folder-empty").addEventListener("click", () => void openFolder());
  $("#ws-welcome-open").addEventListener("click", () => void openFolder());

  // Welcome: Clone Repository (reveal URL field → git clone into a picked parent → mount).
  $("#ws-welcome-clone").addEventListener("click", () => {
    const form = $("#ws-clone-form");
    form.classList.toggle("hidden");
    if (!form.classList.contains("hidden")) ($("#ws-clone-url") as HTMLInputElement).focus();
  });
  $("#ws-clone-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void cloneRepo();
  });

  // Welcome: recent workspaces — click a row to mount that folder.
  renderRecents();
  $("#ws-recents-list").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".ws-recent") as HTMLElement | null;
    if (row?.dataset.path) void mountRoot(row.dataset.path);
  });

  // Topbar actions.
  $("#ws-btn-save").addEventListener("click", () => void saveActive());
  $("#ws-btn-saveall").addEventListener("click", () => void saveAll());
  $("#ws-btn-run").addEventListener("click", () => void runActive());
  $("#ws-out-close").addEventListener("click", () => showOutput(false));

  // Tree: expand/collapse dirs, open files, close tabs, context menu.
  $("#ws-tree").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".ws-row") as HTMLElement | null;
    if (!row) return;
    const path = row.dataset.path!;
    // Mark the row active (used by targetDir / create placement).
    document.querySelectorAll("#ws-tree .ws-row").forEach((el) => el.classList.remove("active"));
    row.classList.add("active");
    if (row.dataset.dir === "1") void toggleDir(path);
    else void openFile(path);
  });
  $("#ws-tree").addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest(".ws-row") as HTMLElement | null;
    if (!row) return;
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, row.dataset.path!, row.dataset.dir === "1");
  });

  $("#ws-tabs").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const closePath = target.closest(".ws-tab-close") as HTMLElement | null;
    if (closePath) {
      closeTab(closePath.dataset.close!);
      return;
    }
    const tab = target.closest(".ws-tab") as HTMLElement | null;
    if (tab) setActiveTab(tab.dataset.tab!);
  });

  // Dismiss the context menu on any outside interaction.
  window.addEventListener("click", closeContextMenu);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeContextMenu();
  });

  // Restore the last opened folder (lazily — only the root is listed now).
  const saved = localStorage.getItem(LS.folder);
  if (saved && hasTauri) {
    void mountRoot(saved);
  } else {
    void renderTree();
  }
}

// Called by main.ts when the Workspace mode becomes visible.
export function activateWorkspace() {
  requestAnimationFrame(() => {
    wsEditor?.layout();
  });
}

// The active file as a Run-and-Debug target (null if no tab is open).
function debugTarget(): DebugTarget | null {
  const tab = activeTabPath ? tabByPath(activeTabPath) : undefined;
  if (!tab) return null;
  return {
    code: tab.model.getValue(),
    title: tab.name,
    monacoLang: langForFile(tab.name),
    traceLang: traceLangForFile(tab.name),
    breakpoints: fileBreakpoints(tab.path),
  };
}

// Menu-bar actions (wired by main.ts's File / Run menus).
export const workspaceActions = {
  openFolder: () => void openFolder(),
  newFile: () => void createEntry(false),
  save: () => void saveActive(),
  saveAll: () => void saveAll(),
  run: () => void runActive(),
  debugTarget,
};

/** Absolute path of the folder currently open in the Explorer, if any. */
export function workspaceRoot(): string | null {
  return rootPath;
}

/**
 * Refresh the Explorer around a path created/changed OUTSIDE the tree UI (e.g. by a
 * Dev Assistant action) and reveal it — expanding the parent and opening a new file.
 */
export async function revealPath(abs: string, isDir: boolean): Promise<void> {
  const parent = parentOf(abs);
  if (parent && parent !== rootPath && !expanded.has(parent)) {
    expanded.add(parent);
    saveExpanded();
  }
  childrenCache.delete(parent);
  await refreshDir(parent);
  if (!isDir) await openFile(abs);
}

/** The current editor selection (active workspace tab), or "" when nothing is selected. */
export function activeSelection(): string {
  const sel = wsEditor?.getSelection();
  const model = wsEditor?.getModel();
  if (!sel || !model || sel.isEmpty()) return "";
  return model.getValueInRange(sel);
}

// ── Dev delegate: stream generated code straight INTO the editor tab ──────────────
// The assistant does not dump code in the chat — it writes it live into the file's
// buffer, so the developer watches it being built and can edit/undo it afterwards.

let editorStream: { path: string; model: monaco.editor.ITextModel } | null = null;

/**
 * Begin streaming generated code into `path`'s editor tab. Creates the file on disk if
 * missing, opens it, focuses it, and opens a single undo group so the whole generation
 * reverts with one Ctrl+Z. Returns false if the editor could not be prepared.
 */
export async function beginEditorStream(path: string): Promise<boolean> {
  if (!rootPath) return false;
  // Create on disk if it does not exist yet (ignore "already exists").
  await invoke("workspace_action", { root: rootPath, op: "createFile", path, content: "" }).catch(
    () => {},
  );
  await openFile(path);
  const tab = tabByPath(path);
  if (!wsEditor || !tab) return false;
  editorStream = { path, model: tab.model };
  wsEditor.pushUndoStop();
  return true;
}

/** Replace the streamed file's content with `text` (called per token chunk). Writes to the
 *  specific tab's model, so a tab switch mid-stream can't corrupt another file. */
export function pushEditorStream(text: string): void {
  if (!editorStream) return;
  const m = editorStream.model;
  m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null);
}

/** Finish the stream: close the undo group and reveal the end of the file. */
export function endEditorStream(): void {
  if (editorStream && wsEditor) {
    wsEditor.pushUndoStop();
    wsEditor.focus();
    const lines = editorStream.model.getLineCount();
    wsEditor.revealLine(lines);
  }
  editorStream = null;
}

/** The file currently being streamed into, or null. */
export function editorStreamPath(): string | null {
  return editorStream?.path ?? null;
}

// ── Localized edit: stream generated code into ONE block/method range ─────────────
// Unlike beginEditorStream (whole file), this replaces only the target line range, so the
// rest of the file — cursor/scroll outside, unsaved edits elsewhere — is untouched.

let rangeStream: {
  model: monaco.editor.ITextModel;
  startLine: number;
  curEndLine: number; // moves as the generated text grows/shrinks
  original: string; // the block's original text, to restore on empty/error
  deco: monaco.editor.IEditorDecorationsCollection; // live highlight on the block
  expectedVersion: number; // model version after our last edit — detects manual edits
  conflicted: boolean; // the dev edited the buffer mid-stream → stop clobbering it
} | null = null;

/** True once a manual edit was detected mid-stream (the dev's change is preserved). */
export function rangeStreamConflicted(): boolean {
  return rangeStream?.conflicted ?? false;
}

/** Paint the "AI is writing here" highlight over the block's current line range. */
function paintRangeHighlight(): void {
  if (!rangeStream) return;
  rangeStream.deco.set([
    {
      range: new monaco.Range(rangeStream.startLine, 1, rangeStream.curEndLine, 1),
      options: {
        isWholeLine: true,
        className: "dx-streaming-block", // tinted background
        linesDecorationsClassName: "dx-streaming-gutter", // animated left bar
      },
    },
  ]);
}

/** Begin streaming a replacement into lines `[startLine..endLine]` (1-based, inclusive) of
 *  `path`'s editor tab. Opens the file, clamps the range to the buffer, and opens one undo
 *  group. Returns false if the editor could not be prepared. */
export async function beginRangeStream(
  path: string,
  startLine: number,
  endLine: number,
): Promise<boolean> {
  await openFile(path);
  const tab = tabByPath(path);
  const model = wsEditor?.getModel();
  if (!wsEditor || !tab || !model) return false;
  const max = model.getLineCount();
  const sl = Math.max(1, Math.min(startLine, max));
  const el = Math.max(sl, Math.min(endLine, max));
  const original = model.getValueInRange(new monaco.Range(sl, 1, el, model.getLineMaxColumn(el)));
  rangeStream = {
    model: tab.model,
    startLine: sl,
    curEndLine: el,
    original,
    deco: wsEditor.createDecorationsCollection([]),
    expectedVersion: tab.model.getVersionId(),
    conflicted: false,
  };
  paintRangeHighlight(); // highlight the block so the dev sees where the AI is writing
  wsEditor.pushUndoStop();
  return true;
}

/** Replace the current target range with `text` (per token chunk); only the block changes.
 *  Returns false when a MANUAL edit was detected since our last write (conflict): we stop
 *  touching the buffer so the dev's change is preserved — the caller should halt the stream. */
export function pushRangeStream(text: string): boolean {
  if (!rangeStream) return false;
  if (rangeStream.conflicted) return false;
  const { model, startLine, curEndLine } = rangeStream;
  // The model version only changes on content edits; if it moved since our last write, the
  // dev typed into the buffer mid-stream → conflict. Stop, keep their edit.
  if (model.getVersionId() !== rangeStream.expectedVersion) {
    rangeStream.conflicted = true;
    rangeStream.deco.clear();
    return false;
  }
  const endCol = model.getLineMaxColumn(curEndLine);
  model.pushEditOperations([], [{ range: new monaco.Range(startLine, 1, curEndLine, endCol), text }], () => null);
  rangeStream.curEndLine = startLine + text.split("\n").length - 1; // track the moved end
  rangeStream.expectedVersion = model.getVersionId(); // our edit is the new baseline
  paintRangeHighlight(); // follow the block as it grows, live
  wsEditor?.revealLineInCenterIfOutsideViewport(rangeStream.curEndLine); // keep the edit in view
  return true;
}

/** Finish the localized stream: close the undo group, clear the highlight, reveal the block. */
export function endRangeStream(): void {
  if (rangeStream && wsEditor) {
    rangeStream.deco.clear();
    wsEditor.pushUndoStop();
    wsEditor.focus();
    wsEditor.revealLineInCenterIfOutsideViewport(rangeStream.startLine);
  }
  rangeStream = null;
}

// After a localized stream finishes with content, the block enters REVIEW: it stays in the
// buffer (so the diff is visible) but highlighted as pending; Accept keeps it, Reject
// restores the original — both one undoable edit.
let rangeReview: {
  model: monaco.editor.ITextModel;
  startLine: number;
  endLine: number;
  original: string;
  deco: monaco.editor.IEditorDecorationsCollection;
} | null = null;

/** End the stream and enter review: keep the proposed block, re-highlight it as "pending",
 *  and return {startLine, endLine, original, proposed} for the panel to diff. */
export function enterRangeReview(): { startLine: number; endLine: number; original: string; proposed: string } | null {
  if (!rangeStream || !wsEditor) return null;
  const { model, startLine, curEndLine, original, deco } = rangeStream;
  const proposed = model.getValueInRange(new monaco.Range(startLine, 1, curEndLine, model.getLineMaxColumn(curEndLine)));
  deco.set([
    {
      range: new monaco.Range(startLine, 1, curEndLine, 1),
      options: { isWholeLine: true, className: "dx-review-block", linesDecorationsClassName: "dx-review-gutter" },
    },
  ]);
  wsEditor.pushUndoStop();
  rangeReview = { model, startLine, endLine: curEndLine, original, deco };
  rangeStream = null; // streaming done; now under review
  showInlineReviewWidget(startLine); // Codex-style Accept/Reject floating on the change
  wsEditor.revealLineInCenterIfOutsideViewport(startLine);
  return { startLine, endLine: curEndLine, original, proposed };
}

/** Accept the proposed block as-is: just drop the review highlight (the buffer already
 *  holds it; it's one undo step). */
export function acceptRange(): void {
  rangeReview?.deco.clear();
  rangeReview = null;
  removeInlineReviewWidget();
}

/** Apply a developer-constructed block (from accepting SELECTED diff lines): replace the
 *  review range with `text` as one undoable edit, then drop the review. */
export function applyReviewedBlock(text: string): void {
  if (rangeReview && wsEditor) {
    const { model, startLine, endLine, deco } = rangeReview;
    model.pushEditOperations(
      [],
      [{ range: new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)), text }],
      () => null,
    );
    wsEditor.pushUndoStop();
    deco.clear();
  }
  rangeReview = null;
  removeInlineReviewWidget();
}

/** Reject the proposal: restore the original block (one undoable edit) and drop the review. */
export function rejectRange(): void {
  if (rangeReview && wsEditor) {
    const { model, startLine, endLine, original, deco } = rangeReview;
    model.pushEditOperations(
      [],
      [{ range: new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)), text: original }],
      () => null,
    );
    wsEditor.pushUndoStop();
    deco.clear();
  }
  rangeReview = null;
  removeInlineReviewWidget();
}

// ── Inline review widget (Codex-style) ─────────────────────────────────────────
// The proposed block already lives in the editor under review; instead of forcing the
// developer back to the Assistant panel to decide, float an Accept/Reject toolbar RIGHT
// on the change — like Codex/Copilot inline edits. It drives the same acceptRange/
// rejectRange, and fires `dx:range-reviewed` so the panel card stays in sync.
let inlineReviewWidget: monaco.editor.IContentWidget | null = null;

function removeInlineReviewWidget(): void {
  if (inlineReviewWidget && wsEditor) wsEditor.removeContentWidget(inlineReviewWidget);
  inlineReviewWidget = null;
}

/** Apply the inline decision AND tell the Assistant panel to clear its matching card. */
function decideInlineReview(kind: "accept" | "reject"): void {
  if (kind === "accept") acceptRange();
  else rejectRange();
  window.dispatchEvent(new CustomEvent("dx:range-reviewed", { detail: { kind } }));
}

function showInlineReviewWidget(startLine: number): void {
  if (!wsEditor) return;
  removeInlineReviewWidget();
  const node = document.createElement("div");
  node.className = "dx-inline-review";
  node.innerHTML =
    `<span class="dx-ir-tag">Proposta do Assistant</span>` +
    `<button class="dx-ir-btn dx-ir-accept" type="button" title="Aceitar — mantém a proposta (uma só edição)">✓ Aceitar</button>` +
    `<button class="dx-ir-btn dx-ir-reject" type="button" title="Rejeitar — restaura o original">✗ Rejeitar</button>`;
  node.querySelector(".dx-ir-accept")?.addEventListener("click", () => decideInlineReview("accept"));
  node.querySelector(".dx-ir-reject")?.addEventListener("click", () => decideInlineReview("reject"));
  const widget: monaco.editor.IContentWidget = {
    getId: () => "dx.inline-review",
    getDomNode: () => node,
    getPosition: () => ({
      position: { lineNumber: startLine, column: 1 },
      preference: [
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
        monaco.editor.ContentWidgetPositionPreference.BELOW,
      ],
    }),
  };
  inlineReviewWidget = widget;
  wsEditor.addContentWidget(widget);
}

/** The block's original text (to restore when a localized stream yields nothing/errors). */
export function rangeStreamOriginal(): string {
  return rangeStream?.original ?? "";
}

/** Absolute path of the file in the active workspace tab, if any. */
export function activeFilePath(): string | null {
  return activeTabPath;
}

interface ResolvedDef {
  file: string;
  line: number;
  col: number;
}

/** Go to Definition: ask rust-analyzer for the resolved location and jump there; on no
 *  answer, fall back to the syntactic CodeMap for the word under the cursor. */
async function goToDefinition(ed: monaco.editor.ICodeEditor): Promise<void> {
  const pos = ed.getPosition();
  const model = ed.getModel();
  if (!pos || !model || !rootPath || !activeTabPath) return;
  const word = model.getWordAtPosition(pos)?.word ?? null;
  try {
    const def = await invoke<ResolvedDef | null>("resolve_definition", {
      root: rootPath,
      file: activeTabPath,
      line: pos.lineNumber,
      col: pos.column,
      text: model.getValue(), // live buffer, so navigation is correct with unsaved edits
    });
    if (def) {
      await openFileAt(def.file, def.line, def.col);
      return;
    }
  } catch {
    /* rust-analyzer not available / errored — fall through to the syntactic map */
  }
  if (word && codeMapHandler) codeMapHandler(word); // honest fallback
}

/** Show type / docs for the symbol under the cursor via rust-analyzer hover. */
async function showType(ed: monaco.editor.ICodeEditor): Promise<void> {
  const pos = ed.getPosition();
  const model = ed.getModel();
  if (!pos || !model || !rootPath || !activeTabPath) return;
  const word = model.getWordAtPosition(pos)?.word ?? "symbol";
  try {
    const hover = await invoke<string | null>("resolve_hover", {
      root: rootPath,
      file: activeTabPath,
      line: pos.lineNumber,
      col: pos.column,
      text: model.getValue(),
    });
    if (hover) writeOutput(`Type · ${word}`, hover, "info");
    else writeOutput(`Type · ${word}`, "No type info (rust-analyzer couldn't resolve it).", "err");
  } catch (e) {
    writeOutput("Show type failed", String(e), "err");
  }
}

/** Register the handler that opens the CodeMap for a symbol (wired by main.ts). The
 *  optional position lets the CodeMap attempt a resolved (rust-analyzer) map. */
type CodeMapPos = { file: string; line: number; col: number; text?: string };
let codeMapHandler: ((symbol: string, pos?: CodeMapPos) => void) | null = null;
export function setCodeMapHandler(fn: (symbol: string, pos?: CodeMapPos) => void): void {
  codeMapHandler = fn;
}

/** Register the handler that starts an AI "Edit with me" on a file (wired by main.ts). */
let editHandler: ((path: string, content: string, lang: string) => void) | null = null;
export function setEditHandler(fn: (path: string, content: string, lang: string) => void): void {
  editHandler = fn;
}

/** Register the handler that starts a LOCALIZED edit of a line range (wired by main.ts). */
let localizedEditHandler:
  | ((path: string, startLine: number, endLine: number, selected: string, lang: string) => void)
  | null = null;
export function setLocalizedEditHandler(
  fn: (path: string, startLine: number, endLine: number, selected: string, lang: string) => void,
): void {
  localizedEditHandler = fn;
}

/** Register the handler that starts a localized edit of a NAMED method (wired by main.ts). */
let methodEditHandler: ((path: string, code: string, lang: string) => void) | null = null;
export function setMethodEditHandler(fn: (path: string, code: string, lang: string) => void): void {
  methodEditHandler = fn;
}

/** Register the handler that adds a main entry point (wired by main.ts). */
let entrypointHandler: ((path: string, code: string, lang: string) => void) | null = null;
export function setEntrypointHandler(fn: (path: string, code: string, lang: string) => void): void {
  entrypointHandler = fn;
}

/** Current in-editor content of `path` if a tab is open, else null (unopened). */
export function currentFileContent(path: string): string | null {
  const tab = tabByPath(path);
  return tab ? tab.model.getValue() : null;
}

/** True when `path` is open with unsaved edits (buffer differs from last-saved). */
export function isDirty(path: string): boolean {
  const tab = tabByPath(path);
  return !!tab && tab.model.getValue() !== tab.saved;
}

/** Replace the ENTIRE content of `path` with `content`, as one undoable edit. */
export async function replaceFileContent(path: string, content: string): Promise<boolean> {
  await openFileAt(path, 1, 1);
  const model = wsEditor?.getModel();
  if (!wsEditor || !model) return false;
  wsEditor.pushUndoStop();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
  wsEditor.pushUndoStop();
  wsEditor.focus();
  return true;
}

/**
 * Open `path` in the workspace editor and reveal (line, col) — both 1-based. Used
 * by the Code Review panel to jump straight to a finding's evidence.
 */
export async function openFileAt(path: string, line: number, col: number): Promise<void> {
  await openFile(path);
  if (!wsEditor) return;
  const ln = Math.max(1, line);
  const cl = Math.max(1, col);
  wsEditor.revealRangeInCenterIfOutsideViewport(new monaco.Range(ln, cl, ln, cl + 1));
  wsEditor.setPosition({ lineNumber: ln, column: cl });
  wsEditor.focus();
  requestAnimationFrame(() => wsEditor?.layout());
}

/** Create a VSCode-style `.vscode/launch.json` under the open root and open it in the
 *  editor — the "create a launch.json file" affordance of the Run and Debug view. */
export async function createLaunchJson(): Promise<void> {
  if (!rootPath) {
    writeOutput("No folder open", "Open a project folder first (Explorer → Open Folder).", "info");
    return;
  }
  const root = rootPath.replace(/\/$/, "");
  const content = `{
  // Debug configurations. See https://code.visualstudio.com/docs/editor/debugging
  "version": "0.2.0",
  "configurations": [
    {
      "type": "lldb",
      "request": "launch",
      "name": "Debug (Rust/cargo)",
      "cargo": { "args": ["build"] },
      "args": [],
      "cwd": "\${workspaceFolder}"
    },
    {
      "type": "debugpy",
      "request": "launch",
      "name": "Debug (Python: current file)",
      "program": "\${file}",
      "console": "integratedTerminal"
    }
  ]
}
`;
  try {
    await cmdCreatePath(`${root}/.vscode`, true).catch(() => {});
    const path = `${root}/.vscode/launch.json`;
    await cmdWriteFile(path, content);
    childrenCache.delete(root);
    await renderTree();
    await openFile(path);
  } catch (err) {
    writeOutput("launch.json failed", String(err), "err");
  }
}

/** Create a `.devcontainer/devcontainer.json` template under the open root and open it —
 *  the Remote view's "Create Dev Container" action. No-op (with a note) if no folder. */
export async function createDevcontainer(): Promise<void> {
  if (!rootPath) {
    writeOutput("No folder open", "Open a project folder first (Explorer → Open Folder).", "info");
    return;
  }
  const root = rootPath.replace(/\/$/, "");
  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? "project";
  const content = `{
  // Dev Container for this project. See https://containers.dev
  "name": "${name}",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {},
  "customizations": {
    "vscode": { "extensions": [] }
  },
  "postCreateCommand": ""
}
`;
  try {
    await cmdCreatePath(`${root}/.devcontainer`, true).catch(() => {});
    const path = `${root}/.devcontainer/devcontainer.json`;
    await cmdWriteFile(path, content);
    childrenCache.delete(root);
    await renderTree();
    await openFile(path);
  } catch (err) {
    writeOutput("devcontainer.json failed", String(err), "err");
  }
}

/**
 * Content-identity token for a buffer — an EXACT mirror of Rust `content_version`
 * (FNV-1a, 64-bit, hex). Same input → same token on both sides, so the frontend can
 * tell when a review result is stale for the live buffer (P0-3). Uses BigInt to keep
 * the full 64-bit width JS numbers would lose.
 */
export function contentVersion(source: string): string {
  const MASK = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  // Hash the UTF-8 bytes (matches Rust's `source.as_bytes()`).
  const bytes = new TextEncoder().encode(source);
  for (const b of bytes) {
    h = (h ^ BigInt(b)) & MASK;
    h = (h * prime) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}

/** Paint review findings as Monaco markers on `path` (owner "dxtutor-review"). */
export function setReviewMarkers(path: string, markers: monaco.editor.IMarkerData[]): void {
  const tab = tabByPath(path);
  if (tab) monaco.editor.setModelMarkers(tab.model, "dxtutor-review", markers);
}

export interface ReviewEdit {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  replacement: string;
}

/**
 * Apply ALL edits of an analyzer's machine fix to `path` as ONE undoable change.
 * STALENESS GUARD: refuses if the buffer differs from its last-saved content (i.e. it
 * was edited since the review ran) — applying stale spans would corrupt the source.
 * Edits are applied bottom-up so earlier positions stay valid. Multi-part fixes apply
 * atomically (never a partial, file-breaking apply).
 */
export async function applyReviewEdits(
  path: string,
  edits: ReviewEdit[],
  analyzedVersion?: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (edits.length === 0) return { ok: false, reason: "nothing to apply" };
  await openFileAt(path, edits[0].startLine, edits[0].startCol);
  const tab = tabByPath(path);
  const model = wsEditor?.getModel();
  if (!wsEditor || !model || !tab) return { ok: false, reason: "could not open the file" };
  // Identity gate (P0-3): the live buffer must still be the exact revision the review
  // analyzed. We compare against the analyzed content version when we have it (survives
  // a save), and always refuse if the buffer drifted — the developer's edits win, and a
  // line-addressed fix never lands on code that moved.
  const live = contentVersion(model.getValue());
  if (analyzedVersion ? live !== analyzedVersion : model.getValue() !== tab.saved) {
    return { ok: false, reason: "file changed since the review — re-run Review" };
  }
  const ops = edits
    .slice()
    .sort((a, b) => b.startLine - a.startLine || b.startCol - a.startCol)
    .map((e) => ({
      range: new monaco.Range(e.startLine, e.startCol, e.endLine, e.endCol),
      text: e.replacement,
    }));
  wsEditor.pushUndoStop();
  model.pushEditOperations([], ops, () => null);
  wsEditor.pushUndoStop();
  wsEditor.focus();
  return { ok: true };
}

/** Clear all review squiggles (owner "dxtutor-review") and the inline ghost. */
export function clearReviewMarkers(): void {
  for (const m of monaco.editor.getModels()) {
    monaco.editor.setModelMarkers(m, "dxtutor-review", []);
  }
  setReviewGhost(null, "");
}

// A single inline "what to do here" ghost (dim text after the finding's line).
let reviewGhost: monaco.editor.IEditorDecorationsCollection | null = null;

/** Show a dim ghost hint at (line) of the active editor; pass null to clear. */
export function setReviewGhost(line: number | null, text: string): void {
  if (!wsEditor) return;
  if (!reviewGhost) reviewGhost = wsEditor.createDecorationsCollection([]);
  if (line == null) {
    reviewGhost.clear();
    return;
  }
  reviewGhost.set([
    {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        after: { content: `    ⟵ ${text}`, inlineClassName: "rv-ghost" },
      },
    },
  ]);
}
