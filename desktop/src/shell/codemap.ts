// shell/codemap.ts — Fase 2 (paridade): CodeMap (defs/refs/callers de um símbolo).
//
// Liga ao backend REAL `symbol_relations` (tutor-eval::codemap, sintáctico Rust).
// Mostra definições, referências e chamadores no painel Output, com salto para a
// localização. Sinaliza honestamente a ambiguidade (homónimos) quando o matcher
// sintáctico não consegue atribuir referências a uma definição. Sem simulação.

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { setPanelTab, toast, addCommand } from "./index";
import { workspaceRoot, openFileAt } from "./workspace";

interface SymbolRef { name: string; kind: string; file: string; line: number; col: number }
interface Relations { symbol: string; resolution: string; definitions: SymbolRef[]; references: SymbolRef[]; callers: SymbolRef[]; ambiguous: boolean }

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const base = (p: string): string => p.split("/").pop() || p;

function group(title: string, refs: SymbolRef[], root: string): string {
  if (!refs.length) return `<div class="scm-grp">${esc(title)}<span class="cnt">0</span></div>`;
  return `<div class="scm-grp">${esc(title)}<span class="cnt">${refs.length}</span></div>` +
    refs.map((r) => {
      const rel = r.file.startsWith(root) ? r.file.slice(root.length + 1) : base(r.file);
      return `<div class="s-hit" data-file="${esc(r.file)}" data-line="${r.line}"><span class="n">${r.line}</span><span>${esc(r.name)} <span class="dim" style="color:var(--fg-muted)">${esc(rel)}</span></span></div>`;
    }).join("");
}

async function runCodemap(): Promise<void> {
  const root = workspaceRoot(); if (!root) { toast(t("codemap.noFolder")); return; }
  const symbol = window.prompt(t("codemap.prompt"));
  if (!symbol) return;
  const out = document.getElementById("pc-output");
  if (out) out.innerHTML = `<div class="dim">${esc(t("codemap.searching", { s: symbol }))}</div>`;
  setPanelTab("output");
  let rel: Relations;
  try { rel = await invoke<Relations>("symbol_relations", { root, symbol }); }
  catch (e) { if (out) out.innerHTML = `<div class="er">${esc(String(e))}</div>`; return; }
  if (!out) return;
  const total = rel.definitions.length + rel.references.length + rel.callers.length;
  if (!total) { out.innerHTML = `<div class="sec-empty">${esc(t("codemap.none", { s: symbol }))}</div>`; return; }
  out.innerHTML =
    `<div style="padding:8px 14px;font-weight:600">${esc(t("codemap.title", { s: symbol }))}</div>` +
    (rel.ambiguous ? `<div class="warn" style="padding:0 14px 6px">${esc(t("codemap.ambiguous"))}</div>` : "") +
    group(t("codemap.definitions"), rel.definitions, root) +
    group(t("codemap.references"), rel.references, root) +
    group(t("codemap.callers"), rel.callers, root);
  out.querySelectorAll<HTMLElement>(".s-hit").forEach((row) => {
    row.onclick = () => openFileAt(row.dataset.file!, Number(row.dataset.line));
  });
}

export function initCodemap(): void {
  registerStrings(CODEMAP_STRINGS);
  addCommand({ id: "codemap:symbol", label: () => t("cmd.codemap"), run: () => void runCodemap() });
}

const CODEMAP_STRINGS = {
  en: {
    "cmd.codemap": "Code Map: find a symbol…",
    "codemap.noFolder": "Open a folder first.", "codemap.prompt": "Symbol name (function, struct, …)",
    "codemap.searching": "Mapping “{s}”…", "codemap.none": "No occurrences of “{s}”.",
    "codemap.title": "Code Map — {s}", "codemap.definitions": "Definitions",
    "codemap.references": "References", "codemap.callers": "Callers",
    "codemap.ambiguous": "Ambiguous: more than one definition shares this name; references cannot be attributed to one until a semantic engine binds them.",
  },
  ptAO: {
    "cmd.codemap": "Code Map: encontrar um símbolo…",
    "codemap.noFolder": "Abre primeiro uma pasta.", "codemap.prompt": "Nome do símbolo (função, struct, …)",
    "codemap.searching": "A mapear «{s}»…", "codemap.none": "Sem ocorrências de «{s}».",
    "codemap.title": "Code Map — {s}", "codemap.definitions": "Definições",
    "codemap.references": "Referências", "codemap.callers": "Chamadores",
    "codemap.ambiguous": "Ambíguo: mais do que uma definição partilha este nome; as referências não podem ser atribuídas a uma até um motor semântico as ligar.",
  },
};
