// shell/workspace.ts — Fase 2 (paridade): núcleo do workspace na nova casca.
//
// Liga ao backend REAL (comandos Tauri fsops): abrir pasta, árvore de ficheiros,
// abrir ficheiro num editor Monaco multi-aba, guardar (autosave). Sem simulação.
// Regista `VIEW.file` e `RP.explorer`, substituindo os placeholders da Fase 1.

import { monaco } from "../monaco";
import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { svg, hydrate } from "./icons";
import { onThemeChange, currentTheme } from "./theme";
import { VIEW, RP, openTab, toast, activeTabId, type Tab } from "./index";

interface EntryDto { name: string; path: string; is_dir: boolean }

let rootPath: string | null = null;
const expanded = new Set<string>();
const childCache = new Map<string, EntryDto[]>();

// Um único editor Monaco, reutilizado entre separadores de ficheiro. O seu
// contentor vive fora do fluxo e é re-anexado ao host da vista a cada `show`.
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let editorHost: HTMLDivElement | null = null;
const models = new Map<string, monaco.editor.ITextModel>();
const saveTimers = new Map<string, number>();

const base = (p: string): string => p.split("/").pop() || p;
const extOf = (name: string): string => { const i = name.lastIndexOf("."); return i < 0 ? "" : name.slice(i + 1).toLowerCase(); };

const LANGS: Record<string, string> = {
  rs: "rust", go: "go", py: "python", js: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", json: "json", toml: "ini", ini: "ini",
  cfg: "ini", md: "markdown", yaml: "yaml", yml: "yaml", sh: "shell", bash: "shell",
  html: "html", htm: "html", css: "css", scss: "scss", java: "java", kt: "kotlin",
  rb: "ruby", php: "php", sql: "sql", xml: "xml", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
};
export function langForFile(name: string): string { return LANGS[extOf(name)] || "plaintext"; }

function iconFor(entry: EntryDto): string {
  if (entry.is_dir) return `<span class="ic folder">${svg(expanded.has(entry.path) ? "folderOpen" : "folder")}</span>`;
  const e = extOf(entry.name);
  const cls = ["rs", "css", "json", "toml", "md"].includes(e) ? e : "file";
  return `<span class="ic ${cls}">${svg(e === "rs" ? "rust" : "file")}</span>`;
}

// ─────────────────────────── Monaco ───────────────────────────
function monacoTheme(): string { return currentTheme() === "Papel claro" ? "vs" : "vs-dark"; }

function ensureEditor(): monaco.editor.IStandaloneCodeEditor {
  if (editor) return editor;
  editorHost = document.createElement("div");
  // #ebody já é absolute inset:0 (tem altura definida); o host preenche-o a 100%.
  editorHost.style.cssText = "width:100%;height:100%";
  editor = monaco.editor.create(editorHost, {
    model: null, theme: monacoTheme(), automaticLayout: true,
    fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13, minimap: { enabled: true }, scrollBeyondLastLine: false,
    renderWhitespace: "selection", tabSize: 4,
  });
  editor.onDidChangeCursorPosition((e) => {
    const el = document.getElementById("st-pos");
    if (el) el.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });
  editor.onDidChangeModelContent(() => {
    const path = (editor?.getModel() as monaco.editor.ITextModel & { _dxPath?: string })?._dxPath;
    if (path) scheduleSave(path);
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    const m = editor?.getModel() as (monaco.editor.ITextModel & { _dxPath?: string }) | null;
    if (m?._dxPath) saveNow(m._dxPath, m.getValue(), true);
  });
  return editor;
}

function modelFor(path: string, content: string): monaco.editor.ITextModel {
  let m = models.get(path);
  if (!m) {
    m = monaco.editor.createModel(content, langForFile(base(path)), monaco.Uri.file(path));
    (m as monaco.editor.ITextModel & { _dxPath?: string })._dxPath = path;
    models.set(path, m);
  }
  return m;
}

function scheduleSave(path: string): void {
  const prev = saveTimers.get(path); if (prev) clearTimeout(prev);
  saveTimers.set(path, window.setTimeout(() => {
    const m = models.get(path); if (m) saveNow(path, m.getValue(), false);
  }, 700));
}
async function saveNow(path: string, contents: string, announce: boolean): Promise<void> {
  try { await invoke("write_text_file", { path, contents }); if (announce) toast(t("ws.saved")); }
  catch (e) { toast(t("ws.saveError", { e: String(e) })); }
}

// ─────────────────────────── VIEW.file ───────────────────────────
const fileView = (tab: Tab, host: HTMLElement): void => {
  const ed = ensureEditor();
  host.appendChild(editorHost!);
  invoke<string>("read_text_file", { path: tab.path! }).then((content) => {
    const m = modelFor(tab.path!, content);
    // Se o ficheiro mudou no disco e não há edições pendentes, actualiza.
    if (m.getValue() !== content && !saveTimers.has(tab.path!)) m.setValue(content);
    ed.setModel(m);
    const lang = document.getElementById("st-lang"); if (lang) lang.textContent = m.getLanguageId();
    ed.layout();
    ed.focus();
  }).catch((e) => {
    host.innerHTML = `<div class="empty"><div>${t("ws.openError", { e: String(e) })}</div></div>`;
  });
};

// ─────────────────────────── Explorer ───────────────────────────
async function listDir(path: string): Promise<EntryDto[]> {
  const cached = childCache.get(path); if (cached) return cached;
  const entries = await invoke<EntryDto[]>("list_dir", { path });
  entries.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
  childCache.set(path, entries);
  return entries;
}

async function renderTreeInto(container: HTMLElement, path: string, depth: number): Promise<void> {
  let entries: EntryDto[];
  try { entries = await listDir(path); } catch (e) { container.insertAdjacentHTML("beforeend", `<div class="sec-empty">${t("ws.openError", { e: String(e) })}</div>`); return; }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "row" + (entry.is_dir && expanded.has(entry.path) ? " open" : "");
    row.style.paddingLeft = 6 + depth * 12 + "px";
    row.innerHTML = `<span class="chev${entry.is_dir ? "" : " leaf"}">${svg("chev")}</span>${iconFor(entry)}<span class="nm">${entry.name}</span>`;
    row.onclick = async () => {
      if (entry.is_dir) {
        if (expanded.has(entry.path)) expanded.delete(entry.path); else expanded.add(entry.path);
        await renderExplorer();
      } else {
        openFile(entry.path);
      }
    };
    container.appendChild(row);
    hydrate(row);
    if (entry.is_dir && expanded.has(entry.path)) {
      await renderTreeInto(container, entry.path, depth + 1);
    }
  }
}

async function renderExplorer(): Promise<void> {
  const el = document.getElementById("pane-explorer"); if (!el) return;
  const hd = `<div class="side-hd"><span class="t">${t("nav.explorer")}</span><span class="acts">` +
    `<button data-ic="new-file" id="ws-newfile" title="${t("ws.newFile")}"></button>` +
    `<button data-ic="new-folder" id="ws-newfolder" title="${t("ws.newFolder")}"></button>` +
    `<button data-ic="refresh" id="ws-refresh" title="${t("ws.refresh")}"></button>` +
    `<button data-ic="collapse" id="ws-collapse" title="${t("ws.collapse")}"></button></span></div>`;
  if (!rootPath) {
    el.innerHTML = hd + `<div class="sec-empty">${t("ws.noFolder")}</div>` +
      `<button class="btn" id="ws-open">${t("ws.openFolder")}</button>`;
    hydrate(el);
    el.querySelector<HTMLButtonElement>("#ws-open")!.onclick = openFolder;
    wireExplorerHeader(el);
    return;
  }
  el.innerHTML = hd + `<div class="sections"><div class="sec-hd open"><span class="chev">${svg("chev")}</span><span class="lbl">${base(rootPath)}</span></div><div class="sec-body show"><div class="tree" id="ws-tree"></div></div></div>`;
  hydrate(el);
  wireExplorerHeader(el);
  const tree = el.querySelector<HTMLElement>("#ws-tree")!;
  await renderTreeInto(tree, rootPath, 0);
}

function wireExplorerHeader(el: HTMLElement): void {
  const q = (id: string) => el.querySelector<HTMLButtonElement>(id);
  q("#ws-refresh")?.addEventListener("click", () => { childCache.clear(); renderExplorer(); });
  q("#ws-collapse")?.addEventListener("click", () => { expanded.clear(); renderExplorer(); });
  q("#ws-newfile")?.addEventListener("click", () => newEntry(false));
  q("#ws-newfolder")?.addEventListener("click", () => newEntry(true));
}

async function newEntry(isDir: boolean): Promise<void> {
  if (!rootPath) { toast(t("ws.noFolder")); return; }
  const name = window.prompt(isDir ? t("ws.newFolder") : t("ws.newFile"));
  if (!name) return;
  const path = rootPath + "/" + name;
  try {
    await invoke("create_path", { path, isDir });
    childCache.delete(rootPath);
    await renderExplorer();
    if (!isDir) openFile(path);
  } catch (e) { toast(t("ws.createError", { e: String(e) })); }
}

export async function openFolder(): Promise<void> {
  const path = await invoke<string | null>("pick_folder");
  if (!path) return;
  rootPath = path; expanded.clear(); childCache.clear();
  await renderExplorer();
}

export function openFile(path: string): void {
  openTab({ id: path, title: base(path), kind: "file", path });
}

/** Regista as vistas/panes reais do workspace (chamar antes de bootShell). */
export function initWorkspace(): void {
  registerStrings(WS_STRINGS);
  VIEW.file = fileView;
  RP.explorer = () => { void renderExplorer(); };
  onThemeChange(() => { if (editor) monaco.editor.setTheme(monacoTheme()); });
}

/** Caminho da raiz aberta, ou null. */
export const workspaceRoot = (): string | null => rootPath;
/** Caminho do ficheiro activo (se o separador activo for um ficheiro). */
export function activeFile(): string | null {
  const id = activeTabId();
  return id && models.has(id) ? id : null;
}

const WS_STRINGS = {
  en: {
    "ws.openFolder": "Open Folder", "ws.noFolder": "No folder opened",
    "ws.newFile": "New File", "ws.newFolder": "New Folder", "ws.refresh": "Refresh",
    "ws.collapse": "Collapse Folders", "ws.saved": "Saved",
    "ws.saveError": "Save failed: {e}", "ws.openError": "Cannot open: {e}",
    "ws.createError": "Create failed: {e}",
  },
  ptAO: {
    "ws.openFolder": "Abrir pasta", "ws.noFolder": "Nenhuma pasta aberta",
    "ws.newFile": "Novo ficheiro", "ws.newFolder": "Nova pasta", "ws.refresh": "Actualizar",
    "ws.collapse": "Colapsar pastas", "ws.saved": "Guardado",
    "ws.saveError": "Falha ao guardar: {e}", "ws.openError": "Não foi possível abrir: {e}",
    "ws.createError": "Falha ao criar: {e}",
  },
};
