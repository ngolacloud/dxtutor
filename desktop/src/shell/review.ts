// shell/review.ts — Fase 2 (paridade): revisão de código (analisadores offline).
//
// Liga ao backend REAL `review_code` (clippy/rustc/go vet/ruff via tutor-eval::
// review). Mostra os achados reais (read-only) com salto para a localização. A
// APLICAÇÃO de correcções automáticas fica pendente: tem de respeitar o contrato
// de identidade de revisão (version/content_version), feito à parte. Sem simulação.

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { hydrate } from "./icons";
import { VIEW, openTab, addCommand, toast, type Tab } from "./index";
import { workspaceRoot, openFileAt, activeFile } from "./workspace";

interface Span { file: string; start_line: number; start_col: number; end_line: number; end_col: number; label?: string }
interface Finding { analyzer: string; rule?: string; class: string; severity: string; message: string; primary: Span; evidence?: string; consequence?: string }
interface ReviewReport { findings: Finding[]; analyzers: unknown[]; version?: string }

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const base = (p: string): string => p.split("/").pop() || p;

let report: ReviewReport | null = null;
let scopeLabel = "";

const sevClass = (s: string): string => (s === "Error" ? "bad" : s === "Warning" ? "warn" : "acc");
const classTag = (c: string): string => (c === "Bug" ? "bad" : c === "Risk" ? "warn" : "acc");

async function openReview(scope: "file" | "changes" | "project", path?: string): Promise<void> {
  const root = workspaceRoot(); if (!root) { toast(t("review.noFolder")); return; }
  if (scope === "file" && !path) { toast(t("review.noFile")); return; }
  scopeLabel = t("review.scope." + scope);
  toast(t("review.running"));
  try {
    report = await invoke<ReviewReport>("review_code", { root, scope, path });
    openTab({ id: "analysis", title: t("review.title"), kind: "analysis" });
  } catch (e) { toast(String(e)); }
}

const analysisView = (_tab: Tab, host: HTMLElement): void => {
  if (!report) { host.innerHTML = `<div class="page"><h1>${esc(t("review.title"))}</h1><div class="sub">${esc(t("review.empty"))}</div></div>`; return; }
  const f = report.findings;
  let html = `<div class="page"><h1>${esc(t("review.title"))}</h1><div class="sub">${esc(scopeLabel)} · ${esc(t("review.count", { n: f.length }))} · ${esc(t("review.honesty"))}</div>`;
  if (!f.length) {
    html += `<div class="pcard" style="max-width:520px;margin-top:14px"><div class="ph">${esc(t("review.clean"))}</div><div class="pd">${esc(t("review.cleanNote"))}</div></div>`;
  } else {
    html += '<div class="tbl-wrap" style="margin-top:12px">';
    for (const fi of f) {
      html += `<div class="rowline" data-file="${esc(fi.primary.file)}" data-line="${fi.primary.start_line}" style="cursor:pointer;align-items:flex-start">
        <span class="tag ${sevClass(fi.severity)}" style="flex:none;margin-top:2px">${esc(fi.severity)}</span>
        <span class="tag ${classTag(fi.class)}" style="flex:none;margin-top:2px">${esc(fi.class)}</span>
        <span style="flex:1"><b>${esc(fi.message)}</b>${fi.consequence ? `<span style="display:block;color:var(--fg-muted);font-size:11.5px;margin-top:2px">${esc(fi.consequence)}</span>` : ""}
          <span style="display:block;color:var(--fg-dim);font-size:11px;font-family:var(--font-mono);margin-top:2px">${esc(fi.analyzer)}${fi.rule ? " · " + esc(fi.rule) : ""} — ${esc(base(fi.primary.file))}:${fi.primary.start_line}</span></span></div>`;
    }
    html += "</div>";
  }
  html += "</div>";
  host.innerHTML = html;
  hydrate(host);
  host.querySelectorAll<HTMLElement>(".rowline[data-file]").forEach((row) => {
    row.onclick = () => openFileAt(row.dataset.file!, Number(row.dataset.line));
  });
};

export function initReview(): void {
  registerStrings(REVIEW_STRINGS);
  VIEW.analysis = analysisView;
  addCommand({ id: "review:file", label: () => t("cmd.reviewFile"), run: () => void openReview("file", activeFile() ?? undefined) });
  addCommand({ id: "review:changes", label: () => t("cmd.reviewChanges"), run: () => void openReview("changes") });
}

const REVIEW_STRINGS = {
  en: {
    "review.title": "Code Review", "review.running": "Running analyzers…",
    "review.noFolder": "Open a folder first.", "review.noFile": "Open a file to review it.",
    "review.empty": "Run a review from the command palette (Review: current file).",
    "review.count": "{n} findings", "review.clean": "No findings.",
    "review.cleanNote": "The analyzers that ran reported nothing on this scope.",
    "review.honesty": "tied to the analyzed revision",
    "review.scope.file": "Current file", "review.scope.changes": "Working changes", "review.scope.project": "Project",
    "cmd.reviewFile": "Review: current file", "cmd.reviewChanges": "Review: working changes",
  },
  ptAO: {
    "review.title": "Revisão de código", "review.running": "A correr os analisadores…",
    "review.noFolder": "Abre primeiro uma pasta.", "review.noFile": "Abre um ficheiro para o rever.",
    "review.empty": "Corre uma revisão na paleta de comandos (Revisão: ficheiro actual).",
    "review.count": "{n} achados", "review.clean": "Sem achados.",
    "review.cleanNote": "Os analisadores que correram não encontraram nada neste âmbito.",
    "review.honesty": "atada à revisão analisada",
    "review.scope.file": "Ficheiro actual", "review.scope.changes": "Alterações em curso", "review.scope.project": "Projecto",
    "cmd.reviewFile": "Revisão: ficheiro actual", "cmd.reviewChanges": "Revisão: alterações em curso",
  },
};
