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
} as const;

let wsEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let rootPath: string | null = null;

// Lazily loaded children, keyed by directory path.
const childrenCache = new Map<string, EntryDto[]>();
// Directories the user has expanded (persisted so the tree re-opens as left).
const expanded = new Set<string>(loadExpanded());

interface Tab {
  path: string;
  name: string;
  model: monaco.editor.ITextModel;
  saved: string; // last persisted content, for the dirty indicator
}
const tabs: Tab[] = [];
let activeTabPath: string | null = null;
let applyingModel = false; // guard: suppress dirty updates during programmatic swaps

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

function fileGlyph(name: string): string {
  // Lightweight, font-independent icons keyed by broad file family.
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["rs"].includes(ext)) return "\u{1F980}"; // crab
  if (["py"].includes(ext)) return "\u{1F40D}"; // snake
  if (["md", "markdown", "txt"].includes(ext)) return "\u{1F4C4}"; // page
  if (["json", "toml", "yml", "yaml", "ini", "cfg", "xml"].includes(ext)) return "⚙"; // gear
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "\u{1F5BC}"; // frame
  return "\u{1F4C4}";
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

function rowHtml(entry: EntryDto, depth: number): string {
  const pad = 8 + depth * 12;
  if (entry.isDir) {
    const open = expanded.has(entry.path);
    const caret = open ? "▾" : "▸";
    const folder = open ? "\u{1F4C2}" : "\u{1F4C1}";
    return (
      `<div class="ws-row ws-dir" role="treeitem" data-path="${esc(entry.path)}" data-dir="1" ` +
      `style="padding-left:${pad}px" title="${esc(entry.path)}">` +
      `<span class="ws-caret">${caret}</span>` +
      `<span class="ws-icon">${folder}</span>` +
      `<span class="ws-name">${esc(entry.name)}</span></div>`
    );
  }
  return (
    `<div class="ws-row ws-file" role="treeitem" data-path="${esc(entry.path)}" ` +
    `style="padding-left:${pad + 14}px" title="${esc(entry.path)}">` +
    `<span class="ws-icon">${fileGlyph(entry.name)}</span>` +
    `<span class="ws-name">${esc(entry.name)}</span></div>`
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

// Refresh a directory's listing from disk and re-render.
async function refreshDir(dir: string) {
  childrenCache.delete(dir);
  if (dir === rootPath || expanded.has(dir)) await loadChildren(dir);
  await renderTree();
}

// ── Tabs + editor ─────────────────────────────────────────────────────────────

function renderTabs() {
  const host = $("#ws-tabs");
  if (!tabs.length) {
    host.innerHTML = "";
    $("#ws-welcome").classList.toggle("hidden", rootPath != null);
    return;
  }
  $("#ws-welcome").classList.add("hidden");
  host.innerHTML = tabs
    .map((t) => {
      const dirty = t.model.getValue() !== t.saved;
      const active = t.path === activeTabPath;
      const mark = dirty
        ? `<span class="ws-tab-dot" title="Unsaved changes">●</span>`
        : `<span class="ws-tab-close" data-close="${esc(t.path)}" title="Close">✕</span>`;
      return (
        `<div class="tab ws-tab${active ? " active" : ""}" data-tab="${esc(t.path)}" title="${esc(t.path)}">` +
        `<span class="file-icon">${fileGlyph(t.name)}</span>` +
        `<span class="ws-tab-name">${esc(t.name)}</span>${mark}</div>`
      );
    })
    .join("");
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
  const tab = tabByPath(path);
  if (!tab || !wsEditor) return;
  activeTabPath = path;
  applyingModel = true;
  wsEditor.setModel(tab.model);
  applyingModel = false;
  $("#ws-welcome").classList.add("hidden");
  saveOpenTabs();
  renderTabs();
  highlightActiveRow();
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
  model.onDidChangeContent(() => {
    if (!applyingModel) renderTabs();
  });
  tabs.push({ path, name, model, saved: contents });
  setActiveTab(path);
}

function closeTab(path: string) {
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
    renderTabs();
    return true;
  } catch (err) {
    writeOutput("Save failed", String(err), "err");
    return false;
  }
}

async function saveAll() {
  for (const tab of tabs) {
    const value = tab.model.getValue();
    if (value === tab.saved) continue;
    try {
      await cmdWriteFile(tab.path, value);
      tab.saved = value;
    } catch (err) {
      writeOutput("Save All failed", `${tab.name}: ${String(err)}`, "err");
      renderTabs();
      return;
    }
  }
  renderTabs();
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
    const r = await cmdRunPath(tab.path);
    $("#ws-output").innerHTML = runOutputHtml(tab.name, r, false);
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

async function mountRoot(path: string) {
  rootPath = path;
  localStorage.setItem(LS.folder, path);
  childrenCache.clear();
  // Keep only expanded dirs that are under the new root.
  for (const p of [...expanded]) {
    if (p !== path && !p.startsWith(path + "/") && !p.startsWith(path + "\\")) expanded.delete(p);
  }
  saveExpanded();
  await renderTree();
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

  // Sidebar header actions.
  $("#ws-act-open").addEventListener("click", () => void openFolder());
  $("#ws-act-newfile").addEventListener("click", () => void createEntry(false));
  $("#ws-act-newfolder").addEventListener("click", () => void createEntry(true));
  $("#ws-act-refresh").addEventListener("click", () => {
    childrenCache.clear();
    void renderTree();
  });
  $("#ws-open-folder-empty").addEventListener("click", () => void openFolder());
  $("#ws-welcome-open").addEventListener("click", () => void openFolder());

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
