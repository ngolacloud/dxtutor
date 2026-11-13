// shell/manager.ts — Fase 4: Gestor de missões (VIEW.manager) sobre o ciclo REAL de tarefas
// isoladas do backend (agent_task_submit → agent_task_status → agent_task_cancel).
//
// Uma «missão» delega uma mudança a um WORKTREE git isolado de HEAD, sem tocar na árvore de
// trabalho (RF-AG-01/05): o backend aplica os ficheiros lá e devolve o diff unificado, que o
// humano revê antes de qualquer coisa aterrar. A primeira fonte real de alterações da nova casca
// é o scaffold do desenho do Studio — obtido por `arch_scaffold_preview` (não escreve nada) e
// injectado via `getArch`. Nada é simulado: sem pasta/backend, estado honesto.
//
// Isolado dos ficheiros em edição concorrente (index.ts/codev.ts/app.ts/policy.rs): só IMPORTA
// de index/workspace e é inicializado a partir de studio.ts.

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { VIEW, addCommand, openTab, toast, activeTabId, type Tab } from "./index";
import { workspaceRoot } from "./workspace";

/** Espelha o `AgentTask` de main.rs (serde camelCase). */
interface AgentTask { id: string; status: "running" | "done" | "error"; patch: string; error: string }

type MissionState = "running" | "done" | "error" | "cancelled";
interface Mission { id: number; title: string; taskId: string | null; state: MissionState; files: number; patch: string; error: string; at: number }

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const hhmm = (): string => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; };

const MISSIONS: Mission[] = [];
let seq = 0;
let getArch: () => unknown = () => ({ components: [], connections: [] });

function open(): void { openTab({ id: "manager", title: t("manager.title"), kind: "manager" }); }

// ── Delegação de uma missão (scaffold → patch isolado) ──────────────────────────────
async function delegateScaffold(): Promise<void> {
  const root = workspaceRoot();
  if (!root) { toast(t("manager.noFolder")); return; }
  let preview: [string, string][] = [];
  try { preview = await invoke<[string, string][]>("arch_scaffold_preview", { arch: getArch() }); }
  catch (e) { toast(String(e)); return; }
  if (!preview.length) { toast(t("manager.invalid")); return; }

  const m: Mission = { id: ++seq, title: t("manager.scaffoldTitle", { n: preview.length }), taskId: null, state: "running", files: preview.length, patch: "", error: "", at: Date.now() };
  MISSIONS.unshift(m);
  if (activeTabId() !== "manager") open();
  render();
  try { m.taskId = await invoke<string>("agent_task_submit", { root, writes: preview }); }
  catch (e) { m.state = "error"; m.error = String(e); render(); return; }
  void poll(m, 0);
}

async function poll(m: Mission, tries: number): Promise<void> {
  if (m.state !== "running" || !m.taskId) return;
  let task: AgentTask | null = null;
  try { task = await invoke<AgentTask | null>("agent_task_status", { id: m.taskId }); }
  catch (e) { m.state = "error"; m.error = String(e); render(); return; }
  if (task && task.status !== "running") {
    m.state = task.status === "done" ? "done" : "error";
    m.patch = task.patch; m.error = task.error;
    render(); return;
  }
  if (tries > 60) { m.state = "error"; m.error = t("manager.timeout"); render(); return; }
  window.setTimeout(() => void poll(m, tries + 1), 300);
}

function cancel(id: number): void {
  const m = MISSIONS.find((x) => x.id === id);
  if (!m) return;
  if (m.taskId) void invoke("agent_task_cancel", { id: m.taskId }).catch(() => { /* já não existe */ });
  if (m.state === "running") m.state = "cancelled";
  render();
}
function forget(id: number): void {
  const i = MISSIONS.findIndex((x) => x.id === id);
  if (i >= 0) { const m = MISSIONS[i]; if (m.taskId) void invoke("agent_task_cancel", { id: m.taskId }).catch(() => { /* */ }); MISSIONS.splice(i, 1); }
  render();
}

// ── Render ──────────────────────────────────────────────────────────────────────────
const STC: Record<MissionState, string> = { running: "var(--yellow)", done: "var(--green)", error: "var(--red)", cancelled: "var(--fg-muted)" };

function render(): void {
  if (activeTabId() !== "manager") return; // só repinta se a vista está aberta
  const host = el("manager-body"); if (!host) return;
  host.innerHTML = MISSIONS.length
    ? MISSIONS.map((m) => {
        const label = t("manager.state." + m.state);
        const body = m.state === "done"
          ? (m.patch ? `<pre style="font-family:var(--font-mono);font-size:11.5px;background:var(--bg-base);border:1px solid var(--border);border-radius:7px;padding:8px 10px;overflow:auto;max-height:420px;white-space:pre">${esc(m.patch)}</pre>` : `<div class="sec-empty">${esc(t("manager.noChanges"))}</div>`)
          : m.state === "error" ? `<div class="st-f e"><span>✖</span><div>${esc(m.error)}</div></div>` : "";
        const actions = m.state === "running"
          ? `<button class="mini" data-cancel="${m.id}">${esc(t("manager.cancel"))}</button>`
          : `<button class="mini" data-forget="${m.id}">${esc(t("manager.forget"))}</button>`;
        return `<div class="pcard" style="margin-top:10px"><div style="display:flex;align-items:center;gap:8px">`
          + `<span class="pdot" style="background:${STC[m.state]}"></span><b>${esc(m.title)}</b>`
          + `<span style="color:${STC[m.state]};font-family:var(--font-mono);font-size:11px">${esc(label)}</span>`
          + `<span style="flex:1"></span><span style="color:var(--fg-muted);font-family:var(--font-mono);font-size:10.5px">${hhmm()}</span>${actions}</div>${body}</div>`;
      }).join("")
    : `<div class="sec-empty">${esc(t("manager.empty"))}</div>`;
  host.querySelectorAll<HTMLElement>("[data-cancel]").forEach((b) => (b.onclick = () => cancel(Number(b.dataset.cancel))));
  host.querySelectorAll<HTMLElement>("[data-forget]").forEach((b) => (b.onclick = () => forget(Number(b.dataset.forget))));
}

const managerView = (_tab: Tab, host: HTMLElement): void => {
  host.innerHTML = `<div class="page" style="max-width:860px">
    <h1>${esc(t("manager.title"))}</h1>
    <div class="sub">${esc(t("manager.sub"))}</div>
    <div style="margin:12px 0"><button class="btn" id="mgr-delegate">${esc(t("manager.delegate"))}</button></div>
    <div id="manager-body"></div></div>`;
  const d = el("mgr-delegate"); if (d) d.onclick = () => void delegateScaffold();
  render();
};

/** Liga o gestor de missões. `arch` fornece o desenho actual do Studio (sem acoplar módulos). */
export function initManager(arch?: () => unknown): void {
  if (arch) getArch = arch;
  registerStrings(MANAGER_STRINGS);
  VIEW.manager = managerView;
  addCommand({ id: "manager:open", label: () => t("manager.cmdOpen"), run: open });
  addCommand({ id: "manager:delegate", label: () => t("manager.cmdDelegate"), run: () => void delegateScaffold() });
}

const MANAGER_STRINGS = {
  en: {
    "manager.title": "Mission manager",
    "manager.cmdOpen": "Mission manager: open",
    "manager.cmdDelegate": "Mission: delegate scaffold (isolated patch)",
    "manager.sub": "Delegate a change to an isolated git worktree of HEAD. The backend applies it there and returns the diff — nothing touches your working tree until you review it.",
    "manager.delegate": "Delegate Studio scaffold (isolated patch) →",
    "manager.scaffoldTitle": "Scaffold the Studio design ({n} files)",
    "manager.empty": "No missions yet. Delegate the Studio scaffold to run one in isolation.",
    "manager.noFolder": "Open a folder first.",
    "manager.invalid": "The design has errors — fix them in the Studio before delegating.",
    "manager.noChanges": "No changes (the files already exist on HEAD).",
    "manager.timeout": "Timed out waiting for the isolated task.",
    "manager.cancel": "Cancel",
    "manager.forget": "Forget",
    "manager.state.running": "running (isolated)",
    "manager.state.done": "ready to review",
    "manager.state.error": "error",
    "manager.state.cancelled": "cancelled",
  },
  ptAO: {
    "manager.title": "Gestor de missões",
    "manager.cmdOpen": "Gestor de missões: abrir",
    "manager.cmdDelegate": "Missão: delegar scaffold (patch isolado)",
    "manager.sub": "Delega uma mudança a um worktree git isolado de HEAD. O backend aplica-a lá e devolve o diff — nada toca na tua árvore de trabalho até revisares.",
    "manager.delegate": "Delegar o scaffold do Studio (patch isolado) →",
    "manager.scaffoldTitle": "Scaffold do desenho do Studio ({n} ficheiros)",
    "manager.empty": "Ainda sem missões. Delega o scaffold do Studio para correr uma em isolamento.",
    "manager.noFolder": "Abre primeiro uma pasta.",
    "manager.invalid": "O desenho tem erros — corrige-os no Studio antes de delegar.",
    "manager.noChanges": "Sem alterações (os ficheiros já existem em HEAD).",
    "manager.timeout": "Esgotou o tempo à espera da tarefa isolada.",
    "manager.cancel": "Cancelar",
    "manager.forget": "Esquecer",
    "manager.state.running": "a correr (isolado)",
    "manager.state.done": "pronta a rever",
    "manager.state.error": "erro",
    "manager.state.cancelled": "cancelada",
  },
};
