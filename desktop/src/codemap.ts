// CodeMap panel (P3) — navigate a symbol's definition, callers and references.
//
// Opened from the editor ("Show in CodeMap" on the symbol under the cursor) or from
// a review finding. Drives the `symbol_relations` backend and lists every relation
// as a clickable location that opens the file at the exact line. Relations are
// tagged resolved-vs-inferred; this slice is Rust + syntactic, hence "inferred".

import { invoke } from "@tauri-apps/api/core";
import { openFileAt, workspaceRoot } from "./workspace";

type Resolution = "resolved" | "inferred";
type SymbolKind = "function" | "method" | "struct" | "enum" | "trait" | "other";
interface SymbolRef {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  col: number;
}
interface Relations {
  symbol: string;
  resolution: Resolution;
  definitions: SymbolRef[];
  references: SymbolRef[];
  callers: SymbolRef[];
  ambiguous: boolean;
}

let ensureWorkspaceMode: () => void = () => {};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function initCodeMap(deps: { ensureWorkspaceMode: () => void }): void {
  ensureWorkspaceMode = deps.ensureWorkspaceMode;
  $("#codemap-close").addEventListener("click", () => $("#codemap-overlay").classList.add("hidden"));
}

interface ResolvedDef {
  file: string;
  line: number;
  col: number;
}

export async function openCodeMap(
  symbol: string,
  pos?: { file: string; line: number; col: number },
): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  $("#codemap-overlay").classList.remove("hidden");
  $("#codemap-title").textContent = symbol;
  $("#codemap-body").innerHTML = `<div class="cm-note">Mapping <code>${esc(symbol)}</code>…</div>`;

  // When we have a cursor position, try rust-analyzer first for a RESOLVED map; fall back
  // to the syntactic (inferred) map when it can't resolve (absent/unindexed/non-Rust).
  if (pos) {
    try {
      const resolved = await resolvedMap(symbol, root, pos);
      if (resolved) {
        render(resolved, root);
        return;
      }
    } catch {
      /* fall through to syntactic */
    }
  }
  try {
    const rel = await invoke<Relations>("symbol_relations", { root, symbol });
    render(rel, root);
  } catch (e) {
    $("#codemap-body").innerHTML = `<div class="cm-note err">CodeMap failed: ${esc(String(e))}</div>`;
  }
}

/** Build a resolved Relations from rust-analyzer's definition + references, or null when
 *  nothing resolves (so the caller uses the syntactic map). */
async function resolvedMap(
  symbol: string,
  root: string,
  pos: { file: string; line: number; col: number },
): Promise<Relations | null> {
  const toRef = (d: ResolvedDef): SymbolRef => ({
    name: symbol,
    kind: "other",
    file: d.file,
    line: d.line,
    col: d.col,
  });
  const [def, refs] = await Promise.all([
    invoke<ResolvedDef | null>("resolve_definition", { root, file: pos.file, line: pos.line, col: pos.col }),
    invoke<ResolvedDef[]>("resolve_references", { root, file: pos.file, line: pos.line, col: pos.col }),
  ]);
  if (!def && (!refs || refs.length === 0)) return null;
  return {
    symbol,
    resolution: "resolved",
    definitions: def ? [toRef(def)] : [],
    references: (refs ?? []).map(toRef),
    callers: [],
    ambiguous: false,
  };
}

function render(rel: Relations, root: string): void {
  $("#codemap-res").textContent = rel.resolution === "resolved" ? "resolved" : "inferred";
  $("#codemap-res").className = `cm-res ${rel.resolution}`;

  const section = (title: string, items: SymbolRef[], empty: string) => {
    if (items.length === 0) return `<div class="cm-sec"><div class="cm-sec-h">${title} <span>0</span></div><div class="cm-empty">${empty}</div></div>`;
    const rows = items
      .map(
        (s) =>
          `<div class="cm-row" data-file="${esc(resolvePath(s.file, root))}" data-line="${s.line}" data-col="${s.col}">
             <span class="cm-kind ${s.kind}">${s.kind}</span>
             <span class="cm-loc">${esc(relative(resolvePath(s.file, root), root))}:${s.line}</span>
           </div>`,
      )
      .join("");
    return `<div class="cm-sec"><div class="cm-sec-h">${title} <span>${items.length}</span></div>${rows}</div>`;
  };

  // Homonyms: be honest that syntactic navigation can't bind to one of several
  // same-named definitions until a semantic engine (rust-analyzer) resolves them.
  const warn = rel.ambiguous
    ? `<div class="cm-note warn">⚠ ${rel.definitions.length} definitions share this name — references and callers are inferred by name and may belong to any of them. Semantic resolution (rust-analyzer) will disambiguate.</div>`
    : "";

  $("#codemap-body").innerHTML =
    warn +
    section("Definitions", rel.definitions, "No definition found in this project.") +
    section("Callers", rel.callers, "No callers found (inferred by name).") +
    section("References", rel.references, "No references found.");

  $("#codemap-body")
    .querySelectorAll<HTMLElement>(".cm-row")
    .forEach((row) =>
      row.addEventListener("click", () => {
        ensureWorkspaceMode();
        void openFileAt(row.dataset.file!, Number(row.dataset.line), Number(row.dataset.col));
      }),
    );
}

function resolvePath(file: string, root: string): string {
  let f = file.replace(/^\.\//, "");
  if (f.startsWith("/")) return f;
  return `${root.replace(/\/$/, "")}/${f}`;
}
function relative(abs: string, root: string): string {
  const r = root.replace(/\/$/, "") + "/";
  return abs.startsWith(r) ? abs.slice(r.length) : abs;
}
