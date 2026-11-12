// Quick-open palette (section 5 — daily work). Ctrl/Cmd+P opens a centered palette that
// fuzzy-filters the project's files (backend `list_files`) and opens the chosen one.

import { invoke } from "@tauri-apps/api/core";
import { openFileAt, workspaceRoot } from "./workspace";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let ensureWorkspaceMode: () => void = () => {};
let files: string[] = [];
let shown: string[] = [];
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
  // Dismiss on backdrop click.
  $("#quickopen-overlay").addEventListener("click", (e) => {
    if (e.target === $("#quickopen-overlay")) close();
  });
  // Global shortcut: Ctrl/Cmd+P.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P") && !e.shiftKey) {
      e.preventDefault();
      void openQuickOpen();
    }
  });
}

export async function openQuickOpen(): Promise<void> {
  ensureWorkspaceMode();
  const root = workspaceRoot();
  const overlay = $("#quickopen-overlay");
  const input = $("#qo-input") as HTMLInputElement;
  overlay.classList.remove("hidden");
  input.value = "";
  input.focus();
  if (!root) {
    files = [];
    $("#qo-list").innerHTML = `<div class="qo-note">Open a project folder first.</div>`;
    return;
  }
  lastRoot = root;
  try {
    files = await invoke<string[]>("list_files", { root, max: 5000 });
  } catch {
    files = [];
  }
  filter("");
}

function close(): void {
  $("#quickopen-overlay").classList.add("hidden");
}

/** Subsequence fuzzy score, or null if `q` is not a subsequence of `path`. */
function score(path: string, q: string): number | null {
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  let i = 0;
  for (let k = 0; k < p.length && i < q.length; k++) if (p[k] === q[i]) i++;
  if (i < q.length) return null;
  let s = 0;
  if (base.includes(q)) s += 100;
  if (base.startsWith(q)) s += 50;
  if (p.includes(q)) s += 20;
  return s - path.length * 0.02; // prefer shorter paths
}

function filter(query: string): void {
  const q = query.trim().toLowerCase();
  if (!q) {
    shown = files.slice(0, 50);
  } else {
    shown = files
      .map((f) => [f, score(f, q)] as const)
      .filter((x): x is readonly [string, number] => x[1] !== null)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
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
  const f = shown[i];
  if (!f) return;
  close();
  const abs = f.startsWith("/") ? f : `${lastRoot.replace(/\/$/, "")}/${f}`;
  void openFileAt(abs, 1, 1);
}

function render(): void {
  const list = $("#qo-list");
  if (shown.length === 0) {
    list.innerHTML = `<div class="qo-note">No files match.</div>`;
    return;
  }
  list.innerHTML = shown
    .map((f, i) => {
      const slash = f.lastIndexOf("/");
      const dir = slash >= 0 ? f.slice(0, slash + 1) : "";
      const base = slash >= 0 ? f.slice(slash + 1) : f;
      return `<div class="qo-row${i === sel ? " sel" : ""}" data-i="${i}"><span class="qo-base">${esc(base)}</span><span class="qo-dir">${esc(dir)}</span></div>`;
    })
    .join("");
  const selEl = list.querySelector(".qo-row.sel") as HTMLElement | null;
  selEl?.scrollIntoView({ block: "nearest" });
}
