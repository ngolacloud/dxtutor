// shell/edit.ts — Fase 2 (paridade, PARITY #21): edição ancorada (`dxpatch`) na nova casca.
//
// Quando o Co-Dev devolve um bloco ```dxpatch, resolvemos cada hunk {old,new} a uma
// localização ÚNICA no buffer vivo (nunca por número de linha vindo do modelo), via o
// resolvedor PURO de ../patch. O conjunto é resolvido ATOMICAMENTE: se algum trecho não
// ancora de forma única (0 ou >1 ocorrências), ou um caminho escapa ao workspace, recusamos
// o conjunto inteiro e não aplicamos nada. O que ancora abre num separador `diff` (Monaco,
// só as regiões alteradas) com Aceitar/Rejeitar. Aceitar grava como UMA edição desfazível;
// antes disso, se o ficheiro mudou desde a proposta (conflito), pede confirmação. Rejeitar
// descarta e interrompe o resto do conjunto. Nada é simulado nem aplicado em silêncio.

import { invoke } from "@tauri-apps/api/core";
import { monaco } from "../monaco";
import { t, registerStrings } from "../i18n";
import { VIEW, openTab, closeTab, toast, type Tab } from "./index";
import { workspaceRoot, currentFileContent, replaceFileContent, langForFile } from "./workspace";
import { currentTheme } from "./theme";
import { parsePatchDirective, resolveAnchoredEdits } from "../patch";

const base = (p: string): string => p.split("/").pop() || p;

/** Um ficheiro do conjunto já resolvido e pronto a rever. `before` é o conteúdo contra o qual
 *  resolvemos (para detectar conflito no Aceitar); `proposedFull` é o ficheiro inteiro depois
 *  de aplicar os hunks ao mínimo span. */
interface ResolvedFile {
  abs: string;
  rel: string;
  before: string;
  proposedFull: string;
  lang: string;
}

/** Resultado de `offerAnchoredPatch`, para o chamador (Co-Dev) narrar honestamente. */
export type PatchOutcome =
  | { kind: "none" }
  | { kind: "refused"; reason: string }
  | { kind: "review"; total: number };

// Fila do conjunto por rever (o primeiro já está aberto; os restantes seguem ao Aceitar).
let queue: ResolvedFile[] = [];
let total = 0;
let ordinal = 0;

// Editor de diff reutilizado; recriado a cada render da vista (a casca limpa o host).
let diffEd: monaco.editor.IStandaloneDiffEditor | null = null;
let origModel: monaco.editor.ITextModel | null = null;
let propModel: monaco.editor.ITextModel | null = null;

// Callback opcional para registar o desfecho no painel Output·Co-Dev.
let patchLog: ((msg: string) => void) | null = null;
/** O Co-Dev regista aqui como quer registar o desfecho de um patch (evita dependência circular). */
export function setPatchLog(fn: (msg: string) => void): void { patchLog = fn; }
function log(msg: string): void { if (patchLog) patchLog(msg); }

const DIFF_TAB = "diff:anchored";

/** Reconstrói o ficheiro inteiro substituindo o span [startLine..endLine] (1-based, linhas
 *  inteiras) pelo texto proposto. */
function rebuildFile(code: string, startLine: number, endLine: number, proposed: string): string {
  const lines = code.split("\n");
  return [...lines.slice(0, startLine - 1), ...proposed.split("\n"), ...lines.slice(endLine)].join("\n");
}

/** Detecta e prepara a revisão de um `dxpatch` presente no texto da resposta. Resolve o
 *  conjunto ATOMICAMENTE contra o buffer vivo (ou o disco) e, se tudo ancora, abre o primeiro
 *  ficheiro num diff para revisão; os restantes ficam em fila. NÃO aplica nada aqui — a
 *  aplicação acontece no Aceitar de cada diff. */
export async function offerAnchoredPatch(replyText: string): Promise<PatchOutcome> {
  const dir = parsePatchDirective(replyText);
  if (!dir) return { kind: "none" };
  const root = workspaceRoot();
  if (!root) return { kind: "refused", reason: t("edit.noFolder") };

  const resolved: ResolvedFile[] = [];
  for (const pf of dir.files) {
    // Contenção (segurança): o backend recusa qualquer escape `../`. Um caminho proposto pelo
    // modelo nunca pode tocar fora do workspace (defesa contra prompt-injection).
    let abs: string;
    try { abs = await invoke<string>("workspace_resolve", { root, path: pf.file }); }
    catch { return { kind: "refused", reason: t("edit.pathRefused", { file: pf.file }) }; }
    // Buffer vivo manda (edições por gravar são a verdade); senão lê o disco.
    let code = currentFileContent(abs);
    if (code == null) {
      try { code = await invoke<string>("read_text_file", { path: abs }); }
      catch { return { kind: "refused", reason: t("edit.readFailed", { file: pf.file }) }; }
    }
    const res = resolveAnchoredEdits(code, pf.edits);
    if (!res.ok) {
      const where = dir.files.length > 1 ? ` (${pf.file})` : "";
      return { kind: "refused", reason: t("edit.refused", { where, reason: res.reason }) };
    }
    resolved.push({
      abs,
      rel: pf.file,
      before: code,
      proposedFull: rebuildFile(code, res.startLine, res.endLine, res.proposed),
      lang: langForFile(base(abs)),
    });
  }

  // Tudo ancorou. Abre o primeiro para revisão; enfileira os restantes.
  queue = resolved;
  total = resolved.length;
  ordinal = 0;
  openNextForReview();
  return { kind: "review", total };
}

/** Abre o próximo ficheiro da fila num separador `diff` para revisão (ou termina). */
function openNextForReview(): void {
  const next = queue.shift();
  if (!next) { total = 0; ordinal = 0; return; }
  ordinal++;
  pending = next;
  openTab({ id: DIFF_TAB, title: `⇄ ${base(next.abs)}`, kind: "diff", path: next.abs });
}

// O ficheiro cuja proposta está a ser revista agora (lido pela VIEW.diff).
let pending: ResolvedFile | null = null;

/** Liberta o editor de diff e os seus modelos. */
function disposeDiff(): void {
  diffEd?.dispose(); diffEd = null;
  origModel?.dispose(); origModel = null;
  propModel?.dispose(); propModel = null;
}

function monacoTheme(): string { return currentTheme() === "Papel claro" ? "vs" : "vs-dark"; }

/** Render da vista `diff`: barra (ficheiro, posição no conjunto, Aceitar/Rejeitar) + editor de
 *  diff Monaco mostrando só as regiões alteradas. */
const diffView = (_tab: Tab, host: HTMLElement): void => {
  const pf = pending;
  if (!pf) {
    host.innerHTML = `<div class="empty"><div>${t("edit.gone")}</div></div>`;
    return;
  }
  const tag = total > 1 ? ` · ${t("edit.ordinal", { n: ordinal, total })}` : "";
  host.innerHTML =
    `<div style="display:flex;flex-direction:column;height:100%">
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);flex:none">
        <span style="font-family:var(--font-mono);font-size:12px">${pf.rel}${tag}</span>
        <span style="flex:1"></span>
        <button class="btn" id="edit-reject">${t("edit.reject")}</button>
        <button class="btn primary" id="edit-accept">${t("edit.accept")}</button>
      </div>
      <div id="edit-diff-host" style="flex:1;min-height:0"></div>
    </div>`;
  const dhost = host.querySelector<HTMLElement>("#edit-diff-host")!;
  disposeDiff();
  diffEd = monaco.editor.createDiffEditor(dhost, {
    theme: monacoTheme(),
    automaticLayout: true,
    renderSideBySide: true,
    readOnly: true,
    originalEditable: false,
    fontSize: 12,
    minimap: { enabled: false },
    // Colapsa o que não mudou — uma correcção de uma linha lê-se como uma linha.
    hideUnchangedRegions: { enabled: true, revealLineCount: 3, minimumLineCount: 3, contextLineCount: 3 },
  });
  origModel = monaco.editor.createModel(pf.before, pf.lang);
  propModel = monaco.editor.createModel(pf.proposedFull, pf.lang);
  diffEd.setModel({ original: origModel, modified: propModel });
  host.querySelector<HTMLButtonElement>("#edit-accept")!.onclick = () => void acceptPending();
  host.querySelector<HTMLButtonElement>("#edit-reject")!.onclick = () => rejectPending();
};

/** Aceita a proposta do ficheiro em revisão: verifica conflito (o ficheiro mudou desde a
 *  proposta?), aplica como UMA edição desfazível e grava; depois avança a fila. */
async function acceptPending(): Promise<void> {
  const pf = pending;
  if (!pf) return;
  // Conflito: relê o estado vivo (ou o disco) e compara com o `before` contra o qual resolvemos.
  let live = currentFileContent(pf.abs);
  if (live == null) {
    try { live = await invoke<string>("read_text_file", { path: pf.abs }); }
    catch { live = pf.before; }
  }
  if (live !== pf.before) {
    if (!window.confirm(t("edit.conflict", { file: pf.rel }))) return; // fica em revisão
  }
  const ok = await replaceFileContent(pf.abs, pf.proposedFull);
  if (!ok) { toast(t("edit.applyFailed", { file: pf.rel })); return; }
  log(t("edit.applied", { file: pf.rel }));
  toast(t("edit.applied", { file: pf.rel }));
  finishCurrent(/* accepted */ true);
}

/** Rejeita a proposta e interrompe o resto do conjunto (um conjunto parcial raramente é o que
 *  se quer; o que já foi aceite fica como passos de desfazer independentes). */
function rejectPending(): void {
  const pf = pending;
  if (!pf) return;
  log(t("edit.rejected", { file: pf.rel }));
  finishCurrent(/* accepted */ false);
}

/** Fecha o diff actual e decide o próximo passo: ao aceitar, avança a fila; ao rejeitar,
 *  descarta o resto e reporta quantos ficheiros ficaram por aplicar. */
function finishCurrent(accepted: boolean): void {
  pending = null;
  disposeDiff();
  closeTab(DIFF_TAB);
  if (accepted) {
    if (queue.length > 0) { openNextForReview(); return; }
    total = 0; ordinal = 0;
    return;
  }
  // Rejeição interrompe o conjunto.
  if (queue.length > 0) {
    log(t("edit.halted", { n: queue.length }));
    toast(t("edit.halted", { n: queue.length }));
  }
  queue = []; total = 0; ordinal = 0;
}

/** Regista a vista `diff` e as strings. Chamar antes de `bootShell()`. */
export function initEdit(): void {
  registerStrings(EDIT_STRINGS);
  VIEW.diff = diffView;
}

const EDIT_STRINGS = {
  en: {
    "edit.accept": "Accept",
    "edit.reject": "Reject",
    "edit.ordinal": "file {n}/{total}",
    "edit.noFolder": "patch refused — open a folder first.",
    "edit.pathRefused": "patch refused — path is outside the workspace: {file}",
    "edit.readFailed": "patch refused — could not read {file}.",
    "edit.refused": "patch refused{where} — {reason}",
    "edit.conflict": "{file} changed since the proposal. Apply anyway (overwriting those changes)?",
    "edit.applyFailed": "could not apply the change to {file}.",
    "edit.applied": "applied anchored edit to {file}.",
    "edit.rejected": "rejected the proposed edit to {file}.",
    "edit.halted": "rejection halted the changeset — {n} remaining file(s) discarded.",
    "edit.gone": "This proposal is no longer available.",
  },
  ptAO: {
    "edit.accept": "Aceitar",
    "edit.reject": "Rejeitar",
    "edit.ordinal": "ficheiro {n}/{total}",
    "edit.noFolder": "patch recusado — abre primeiro uma pasta.",
    "edit.pathRefused": "patch recusado — caminho fora do workspace: {file}",
    "edit.readFailed": "patch recusado — não consegui ler {file}.",
    "edit.refused": "patch recusado{where} — {reason}",
    "edit.conflict": "{file} mudou desde a proposta. Aplicar mesmo assim (sobrepõe essas alterações)?",
    "edit.applyFailed": "não consegui aplicar a alteração a {file}.",
    "edit.applied": "edição ancorada aplicada a {file}.",
    "edit.rejected": "proposta de edição a {file} rejeitada.",
    "edit.halted": "a rejeição interrompeu o conjunto — {n} ficheiro(s) restante(s) descartado(s).",
    "edit.gone": "Esta proposta já não está disponível.",
  },
};
