// shell/problems.ts — Fase 2 (paridade): painel Problems a partir dos markers.
//
// Os diagnósticos reais chegam do LSP (evento lsp://diagnostics → markers Monaco,
// em lsp.ts). Aqui agregamos monaco.editor.getModelMarkers() para o painel
// Problems e para os contadores da barra de estado. Sem simulação: se não há
// markers, mostra «sem problemas».

import { monaco } from "../monaco";
import { t, registerStrings } from "../i18n";
import { openFileAt } from "./workspace";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const base = (p: string): string => p.split("/").pop() || p;

function refresh(): void {
  const all = monaco.editor.getModelMarkers({}).filter((mk) => mk.severity >= monaco.MarkerSeverity.Warning);
  const errors = all.filter((mk) => mk.severity === monaco.MarkerSeverity.Error).length;
  const warnings = all.length - errors;

  const st = document.getElementById("st-prob");
  if (st) st.innerHTML = `<span style="color:var(--red)">✖ ${errors}</span> <span style="color:var(--yellow)">⚠ ${warnings}</span>`;
  const pb = document.getElementById("pb-prob");
  if (pb) pb.textContent = String(all.length);

  const panel = document.getElementById("pc-problems");
  if (!panel) return;
  if (!all.length) { panel.innerHTML = `<div class="sec-empty">${esc(t("problems.none"))}</div>`; return; }
  all.sort((a, b) => b.severity - a.severity || String(a.resource.path).localeCompare(String(b.resource.path)) || a.startLineNumber - b.startLineNumber);
  panel.innerHTML = all.map((mk) => {
    const err = mk.severity === monaco.MarkerSeverity.Error;
    const path = mk.resource.path;
    return `<div class="prob" data-file="${esc(path)}" data-line="${mk.startLineNumber}"><span class="pi ${err ? "e" : "w"}">${err ? "✖" : "⚠"}</span><span>${esc(mk.message)}</span><span class="ploc">${esc(base(path))}:${mk.startLineNumber}</span></div>`;
  }).join("");
  panel.querySelectorAll<HTMLElement>(".prob").forEach((row) => {
    row.onclick = () => openFileAt(row.dataset.file!, Number(row.dataset.line));
  });
}

export function initProblems(): void {
  registerStrings(PROBLEMS_STRINGS);
  monaco.editor.onDidChangeMarkers(() => refresh());
  refresh();
}

const PROBLEMS_STRINGS = {
  en: { "problems.none": "No problems detected." },
  ptAO: { "problems.none": "Nenhum problema detectado." },
};
