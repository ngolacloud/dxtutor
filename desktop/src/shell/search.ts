// shell/search.ts — Fase 2 (paridade): pesquisa em todos os ficheiros.
//
// Liga ao backend REAL `search_project` (crate tutor-eval::search). Resultados
// agrupados por ficheiro; clicar salta para a linha no editor Monaco. Sem simulação.

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { svg, hydrate } from "./icons";
import { RP } from "./index";
import { workspaceRoot, openFileAt } from "./workspace";

interface SearchHit { file: string; line: number; col: number; text: string }

let lastQuery = "";
let timer: number | undefined;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const short = (p: string, root: string): string => (p.startsWith(root) ? p.slice(root.length + 1) : p);

function highlight(text: string, query: string): string {
  if (!query) return esc(text);
  const re = new RegExp(reEscape(query), "gi");
  let out = "", last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out + esc(text.slice(last));
}

async function doSearch(): Promise<void> {
  const el = document.getElementById("pane-search"); if (!el) return;
  const input = el.querySelector<HTMLInputElement>("#s-q");
  const res = el.querySelector<HTMLElement>("#s-res");
  if (!input || !res) return;
  const query = input.value.trim();
  lastQuery = query;
  const root = workspaceRoot();
  if (!root) { res.innerHTML = `<div class="sec-empty">${esc(t("search.noFolder"))}</div>`; return; }
  if (!query) { res.innerHTML = ""; return; }
  let hits: SearchHit[];
  try { hits = await invoke<SearchHit[]>("search_project", { root, query, ignoreCase: true }); }
  catch (e) { res.innerHTML = `<div class="sec-empty">${esc(String(e))}</div>`; return; }
  if (!hits.length) { res.innerHTML = `<div class="sec-empty">${esc(t("search.noResults"))}</div>`; return; }

  const byFile = new Map<string, SearchHit[]>();
  for (const h of hits) { const a = byFile.get(h.file) || []; a.push(h); byFile.set(h.file, a); }
  const files = byFile.size;
  let html = `<div class="scm-grp">${esc(t("search.results", { n: hits.length, f: files }))}</div>`;
  for (const [file, fhits] of byFile) {
    html += `<div class="sec-hd open"><span class="chev">${svg("chev")}</span><span class="lbl" style="text-transform:none">${esc(short(file, root))}</span><span class="cnt" style="margin-left:auto;font-family:var(--font-mono);font-size:10px;color:var(--fg-muted)">${fhits.length}</span></div>`;
    for (const h of fhits) {
      html += `<div class="s-hit" data-file="${esc(file)}" data-line="${h.line}"><span class="n">${h.line}</span><span style="overflow:hidden;text-overflow:ellipsis">${highlight(h.text.slice(0, 200), query)}</span></div>`;
    }
  }
  res.innerHTML = html;
  hydrate(res);
  res.querySelectorAll<HTMLElement>(".s-hit").forEach((row) => {
    row.onclick = () => openFileAt(row.dataset.file!, Number(row.dataset.line));
  });
}

function renderSearchPane(): void {
  const el = document.getElementById("pane-search"); if (!el) return;
  if (!el.dataset.built) {
    el.dataset.built = "1";
    el.innerHTML = `<div class="side-hd"><span class="t">${esc(t("nav.search"))}</span></div>` +
      `<input class="inp" id="s-q" autocomplete="off" spellcheck="false" placeholder="${esc(t("search.placeholder"))}" />` +
      `<div class="sections" id="s-res"></div>`;
    hydrate(el);
    const q = el.querySelector<HTMLInputElement>("#s-q")!;
    q.value = lastQuery;
    q.oninput = () => { clearTimeout(timer); timer = window.setTimeout(() => void doSearch(), 250); };
    q.onkeydown = (e) => { if (e.key === "Enter") { clearTimeout(timer); void doSearch(); } };
  }
  el.querySelector<HTMLInputElement>("#s-q")?.focus();
  if (lastQuery) void doSearch();
}

export function initSearch(): void {
  registerStrings(SEARCH_STRINGS);
  RP.search = renderSearchPane;
}

const SEARCH_STRINGS = {
  en: {
    "search.placeholder": "Search in all files",
    "search.noFolder": "Open a folder to search.",
    "search.noResults": "No results.",
    "search.results": "{n} results in {f} files",
  },
  ptAO: {
    "search.placeholder": "Procurar em todos os ficheiros",
    "search.noFolder": "Abre uma pasta para pesquisar.",
    "search.noResults": "Sem resultados.",
    "search.results": "{n} resultados em {f} ficheiros",
  },
};
