// shell/scm.ts — Fase 2 (paridade): Source Control real (git).
//
// Liga ao backend REAL (crate tutor-eval::git): estado de alterações, stage/
// unstage, commit, ramo actual e troca de ramo. Sem simulação. O grafo de
// commits (DAG) fica para a Fase 6 (Gitflow).

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { svg, hydrate } from "./icons";
import { RP, toast, goPane } from "./index";
import { workspaceRoot, openFileAt, onFolderOpened } from "./workspace";

interface GitChange { path: string; status: string; index: string; work: string }

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const base = (p: string): string => p.split("/").pop() || p;

let branch = "";

const isStaged = (c: GitChange): boolean => c.index !== " " && c.index !== "?";
const isUnstaged = (c: GitChange): boolean => c.work !== " "; // inclui não-rastreados (work "?")
function letter(c: GitChange, staged: boolean): { l: string; cls: string } {
  const ch = staged ? c.index : c.work;
  if (ch === "?" || ch === "A") return { l: "U", cls: "U" };
  if (ch === "D") return { l: "D", cls: "D" };
  return { l: "M", cls: "M" };
}

async function refreshBranch(root: string): Promise<void> {
  try { branch = (await invoke<string | null>("git_branch", { root })) || ""; }
  catch { branch = ""; }
  const el = document.getElementById("st-branch-l");
  if (el) el.textContent = branch || "—";
}

async function changes(root: string): Promise<GitChange[]> {
  return invoke<GitChange[]>("git_changes", { root });
}

function rowHtml(c: GitChange, staged: boolean, root: string): string {
  const { l, cls } = letter(c, staged);
  const rel = c.path.startsWith(root) ? c.path.slice(root.length + 1) : c.path;
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const act = staged
    ? `<button data-act="unstage" title="${esc(t("scm.unstage"))}">−</button>`
    : `<button data-act="stage" title="${esc(t("scm.stage"))}">+</button>`;
  return `<div class="scm-row${cls === "D" ? " del" : ""}" data-path="${esc(c.path)}"><span class="nm">${esc(base(c.path))}</span><span class="pth">${esc(dir)}</span><span class="ra">${act}</span><span class="g ${cls}">${l}</span></div>`;
}

async function renderScm(): Promise<void> {
  const el = document.getElementById("pane-scm"); if (!el) return;
  const root = workspaceRoot();
  const head = `<div class="side-hd"><span class="t">${esc(t("nav.scm"))}</span><span class="acts"><button data-ic="refresh" id="scm-refresh" title="${esc(t("ws.refresh"))}"></button></span></div>`;
  if (!root) { el.innerHTML = head + `<div class="sec-empty">${esc(t("scm.noFolder"))}</div>`; hydrate(el); el.querySelector<HTMLElement>("#scm-refresh")?.addEventListener("click", () => void renderScm()); return; }
  await refreshBranch(root);
  let ch: GitChange[];
  try { ch = await changes(root); }
  catch (e) { el.innerHTML = head + `<div class="sec-empty">${esc(String(e))}</div>`; hydrate(el); return; }
  const staged = ch.filter(isStaged);
  const unstaged = ch.filter(isUnstaged);
  let html = head +
    `<input class="inp" id="scm-msg" autocomplete="off" placeholder="${esc(t("scm.message"))}" />` +
    `<button class="btn" id="scm-commit">${svg("check")} ${esc(t("scm.commitOn", { branch: branch || "—" }))}</button>`;
  if (staged.length) {
    html += `<div class="scm-grp">${esc(t("scm.staged"))}<span class="cnt">${staged.length}</span></div>` + staged.map((c) => rowHtml(c, true, root)).join("");
  }
  html += `<div class="scm-grp">${esc(t("scm.changes"))}<span class="cnt">${unstaged.length}</span>` +
    (unstaged.length ? `<button class="mini" id="scm-stageall" style="margin-left:8px">${esc(t("scm.stageAll"))}</button>` : "") + `</div>`;
  html += unstaged.length ? unstaged.map((c) => rowHtml(c, false, root)).join("") : `<div class="sec-empty">${esc(t("scm.clean"))}</div>`;
  el.innerHTML = html;
  hydrate(el);
  wire(el, root);
}

function wire(el: HTMLElement, root: string): void {
  el.querySelector<HTMLElement>("#scm-refresh")?.addEventListener("click", () => void renderScm());
  el.querySelector<HTMLElement>("#scm-stageall")?.addEventListener("click", async () => {
    try { await invoke("git_stage_all", { root }); await renderScm(); } catch (e) { toast(String(e)); }
  });
  el.querySelector<HTMLElement>("#scm-commit")?.addEventListener("click", async () => {
    const msg = el.querySelector<HTMLInputElement>("#scm-msg")?.value.trim();
    if (!msg) { toast(t("scm.needMessage")); return; }
    try { await invoke("git_commit", { root, message: msg }); toast(t("scm.committed")); await renderScm(); }
    catch (e) { toast(String(e)); }
  });
  el.querySelectorAll<HTMLElement>(".scm-row").forEach((row) => {
    const path = row.dataset.path!;
    row.onclick = (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "stage") { e.stopPropagation(); void invoke("git_stage", { root, path }).then(renderScm).catch((x) => toast(String(x))); return; }
      if (act === "unstage") { e.stopPropagation(); void invoke("git_unstage", { root, path }).then(renderScm).catch((x) => toast(String(x))); return; }
      openFileAt(path, 1);
    };
  });
}

/** Troca de ramo: lista os ramos e pede a escolha (ou cria um novo). */
export async function switchBranch(): Promise<void> {
  const root = workspaceRoot(); if (!root) { goPane("scm"); return; }
  let list: string[] = [];
  try { list = await invoke<string[]>("git_branches", { root }); } catch { /* */ }
  const choice = window.prompt(t("scm.switchPrompt", { list: list.join(", ") }), branch);
  if (!choice || choice === branch) return;
  try {
    if (list.includes(choice)) await invoke("git_checkout", { root, branch: choice });
    else await invoke("git_create_branch", { root, name: choice });
    await refreshBranch(root);
    await renderScm();
    toast(t("scm.onBranch", { branch: choice }));
  } catch (e) { toast(String(e)); }
}

export function initScm(): void {
  registerStrings(SCM_STRINGS);
  RP.scm = () => { void renderScm(); };
  onFolderOpened((root) => void refreshBranch(root));
}

const SCM_STRINGS = {
  en: {
    "scm.noFolder": "Open a folder with a git repository.",
    "scm.message": "Commit message",
    "scm.commitOn": "Commit on {branch}",
    "scm.staged": "Staged", "scm.changes": "Changes", "scm.clean": "No changes.",
    "scm.stage": "Stage", "scm.unstage": "Unstage", "scm.stageAll": "Stage all",
    "scm.needMessage": "Write a commit message first.",
    "scm.committed": "Committed.", "scm.onBranch": "On branch {branch}",
    "scm.switchPrompt": "Branch to switch to (new name creates it). Existing: {list}",
  },
  ptAO: {
    "scm.noFolder": "Abre uma pasta com um repositório git.",
    "scm.message": "Mensagem de commit",
    "scm.commitOn": "Commit em {branch}",
    "scm.staged": "Em stage", "scm.changes": "Alterações", "scm.clean": "Sem alterações.",
    "scm.stage": "Pôr em stage", "scm.unstage": "Tirar de stage", "scm.stageAll": "Stage a tudo",
    "scm.needMessage": "Escreve primeiro uma mensagem de commit.",
    "scm.committed": "Commit feito.", "scm.onBranch": "No ramo {branch}",
    "scm.switchPrompt": "Ramo para onde mudar (nome novo cria-o). Existentes: {list}",
  },
};
