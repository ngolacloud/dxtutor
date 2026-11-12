// Global search panel (section 5 — daily work). Finds literal text across the open
// project (backend `search_project`) and opens a hit's location on click. Offline.

import { invoke } from "@tauri-apps/api/core";
import { openFileAt, workspaceRoot } from "./workspace";

interface SearchHit {
  file: string;
  line: number;
  col: number;
  text: string;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let ensureWorkspaceMode: () => void = () => {};
let lastRoot = "";
let timer: ReturnType<typeof setTimeout> | null = null;

export function initSearch(deps: { ensureWorkspaceMode: () => void }): void {
  ensureWorkspaceMode = deps.ensureWorkspaceMode;
  $("#search-close").addEventListener("click", () => $("#search-overlay").classList.add("hidden"));
  const input = $("#search-input") as HTMLInputElement;
  // Debounced live search as the developer types; Enter searches immediately.
  input.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(input.value), 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (timer) clearTimeout(timer);
      void run(input.value);
    }
  });
  // Case-sensitivity toggle re-runs the current query.
  $("#search-case").addEventListener("change", () => void run(input.value));
  // Click a result → open the file at its location.
  $("#search-results").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".search-row") as HTMLElement | null;
    if (!row) return;
    void openFileAt(resolve(row.dataset.file!), Number(row.dataset.line), Number(row.dataset.col));
  });
}

export function openSearch(): void {
  $("#review-overlay")?.classList.add("hidden");
  $("#assistant-overlay")?.classList.add("hidden");
  $("#codemap-overlay")?.classList.add("hidden");
  $("#tests-overlay")?.classList.add("hidden");
  $("#search-overlay").classList.remove("hidden");
  ensureWorkspaceMode();
  lastRoot = workspaceRoot() ?? "";
  ($("#search-input") as HTMLInputElement).focus();
}

function resolve(file: string): string {
  return file.startsWith("/") ? file : `${lastRoot.replace(/\/$/, "")}/${file}`;
}

async function run(query: string): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    $("#search-results").innerHTML = `<div class="tests-note">Open a project folder to search it.</div>`;
    $("#search-count").textContent = "";
    return;
  }
  lastRoot = root;
  const q = query.trim();
  if (!q) {
    $("#search-results").innerHTML = "";
    $("#search-count").textContent = "";
    return;
  }
  try {
    const caseSensitive = ($("#search-case") as HTMLInputElement).checked;
    const hits = await invoke<SearchHit[]>("search_project", {
      root,
      query: q,
      max: 500,
      ignoreCase: !caseSensitive,
    });
    render(hits, q);
  } catch (e) {
    $("#search-results").innerHTML = `<div class="tests-note err">Search failed: ${esc(String(e))}</div>`;
  }
}

function render(hits: SearchHit[], q: string): void {
  $("#search-count").textContent = hits.length ? `${hits.length}${hits.length >= 500 ? "+" : ""} hits` : "0 hits";
  if (hits.length === 0) {
    $("#search-results").innerHTML = `<div class="tests-note">No matches.</div>`;
    return;
  }
  $("#search-results").innerHTML = hits
    .map((h) => {
      // Highlight the matched substring within the (escaped) line.
      const safe = esc(h.text);
      const needle = esc(q);
      const hl = safe.split(needle).join(`<mark>${needle}</mark>`);
      return `<div class="search-row" data-file="${esc(h.file)}" data-line="${h.line}" data-col="${h.col}" title="${esc(h.file)}:${h.line}">
          <span class="test-loc">${esc(h.file)}:${h.line}</span>
          <code class="search-text">${hl}</code>
        </div>`;
    })
    .join("");
}
