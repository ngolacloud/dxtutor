// Quick-open palette (section 5 — daily work). Ctrl/Cmd+P opens a file by name;
// Ctrl/Cmd+Shift+O opens a symbol by name (backend list_files / list_symbols). Both
// fuzzy-filter and open the chosen target at its location.

import { invoke } from "@tauri-apps/api/core";
import { openFileAt, workspaceRoot } from "./workspace";

interface SymbolRef {
  name: string;
  kind: string;
  file: string;
  line: number;
  col: number;
}
interface QOItem {
  key: string; // fuzzy-matched against
  primary: string; // bold label
  secondary: string; // dim detail
  file: string; // absolute path
  line: number;
  col: number;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let ensureWorkspaceMode: () => void = () => {};
let items: QOItem[] = [];
let shown: QOItem[] = [];
let sel = 0;
let lastRoot = "";

export function initQuickOpen(deps: { ensureWorkspaceMode: () => void }): void {
  ensureWorkspaceMode = deps.ensureWorkspaceMode;
  const input = $("#qo-input") as HTMLInputElement;
  input.addEventListener("input", () => filter(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(sel);
    } else if (e.key === "Escape") {
      close();
    }
  });
  $("#qo-list").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".qo-row") as HTMLElement | null;
    if (row) choose(Number(row.dataset.i));
  });
  $("#quickopen-overlay").addEventListener("click", (e) => {
    if (e.target === $("#quickopen-overlay")) close();
  });
  // Capture phase on `window`: this runs BEFORE Monaco (which consumes keydown events on
  // its own element) and before the webview's default Ctrl+P (print), so the global
  // palette shortcuts fire even while the editor has focus.
  window.addEventListener(
    "keydown",
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "p" || e.key === "P") && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void openPalette("file");
      } else if (mod && e.shiftKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        e.stopPropagation();
        void openPalette("symbol");
      }
    },
    true,
  );
}

export const openQuickOpen = () => openPalette("file");
export const openSymbols = () => openPalette("symbol");

async function openPalette(mode: "file" | "symbol"): Promise<void> {
  ensureWorkspaceMode();
  const root = workspaceRoot();
  const input = $("#qo-input") as HTMLInputElement;
  $("#quickopen-overlay").classList.remove("hidden");
  input.value = "";
  input.placeholder = mode === "file" ? "Go to file…" : "Go to symbol…";
  input.focus();
  if (!root) {
    items = [];
    $("#qo-list").innerHTML = `<div class="qo-note">Open a project folder first.</div>`;
    return;
  }
  lastRoot = root;
  try {
    items = mode === "file" ? await loadFiles(root) : await loadSymbols(root);
  } catch {
    items = [];
  }
  filter("");
}

async function loadFiles(root: string): Promise<QOItem[]> {
  const files = await invoke<string[]>("list_files", { root, max: 5000 });
  return files.map((f) => {
    const slash = f.lastIndexOf("/");
    return {
      key: f,
      primary: slash >= 0 ? f.slice(slash + 1) : f,
      secondary: slash >= 0 ? f.slice(0, slash + 1) : "",
      file: abs(f),
      line: 1,
      col: 1,
    };
  });
}

async function loadSymbols(root: string): Promise<QOItem[]> {
  const syms = await invoke<SymbolRef[]>("list_symbols", { root, max: 5000 });
  return syms.map((s) => ({
    key: s.name,
    primary: s.name,
    secondary: `${s.kind} · ${s.file}:${s.line}`,
    file: abs(s.file),
    line: s.line,
    col: s.col,
  }));
}

function abs(rel: string): string {
  return rel.startsWith("/") ? rel : `${lastRoot.replace(/\/$/, "")}/${rel}`;
}

function close(): void {
  $("#quickopen-overlay").classList.add("hidden");
}

/** Subsequence fuzzy score, or null if `q` is not a subsequence of `key`. */
function score(key: string, q: string): number | null {
  const p = key.toLowerCase();
  let i = 0;
  for (let k = 0; k < p.length && i < q.length; k++) if (p[k] === q[i]) i++;
  if (i < q.length) return null;
  let s = 0;
  if (p.includes(q)) s += 60;
  if (p.startsWith(q)) s += 40;
  return s - key.length * 0.02;
}

function filter(query: string): void {
  const q = query.trim().toLowerCase();
  if (!q) {
    shown = items.slice(0, 60);
  } else {
    shown = items
      .map((it) => [it, score(it.key, q)] as const)
      .filter((x): x is readonly [QOItem, number] => x[1] !== null)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map((x) => x[0]);
  }
  sel = 0;
  render();
}

function move(d: number): void {
  if (shown.length === 0) return;
  sel = (sel + d + shown.length) % shown.length;
  render();
}

function choose(i: number): void {
  const it = shown[i];
  if (!it) return;
  close();
  void openFileAt(it.file, it.line, it.col);
}

function render(): void {
  const list = $("#qo-list");
  if (shown.length === 0) {
    list.innerHTML = `<div class="qo-note">No matches.</div>`;
    return;
  }
  list.innerHTML = shown
    .map(
      (it, i) =>
        `<div class="qo-row${i === sel ? " sel" : ""}" data-i="${i}"><span class="qo-base">${esc(it.primary)}</span><span class="qo-dir">${esc(it.secondary)}</span></div>`,
    )
    .join("");
  (list.querySelector(".qo-row.sel") as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
}
