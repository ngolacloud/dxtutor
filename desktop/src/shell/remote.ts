// shell/remote.ts — Fase 2 (paridade): Remote Explorer + Dev Containers.
//
// Liga ao backend REAL: detect_projects (sub-projectos no workspace) e
// devcontainer_* (detectar devcontainer.json, reabrir no contentor, estado da
// sessão). O que NÃO tem backend (remotos SSH, `docker ps`) aparece como nota
// honesta, nunca simulado (ver PENDING.md).

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { svg, hydrate } from "./icons";
import { RP, toast } from "./index";
import { workspaceRoot } from "./workspace";

interface ProjectInfo { name: string; path: string; kind: string }
interface DevcontainerInfo { present: boolean; name?: string; image?: string; path?: string }
interface SessionStatus { running: boolean; name: string }

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const base = (p: string): string => p.split("/").pop() || p;
const grp = (label: string): string => `<div class="scm-grp">${esc(label)}</div>`;

// ─────────────────────────── Remote Explorer ───────────────────────────
async function renderRemote(): Promise<void> {
  const el = document.getElementById("pane-remote"); if (!el) return;
  const root = workspaceRoot();
  const head = `<div class="side-hd"><span class="t">${esc(t("nav.remote"))}</span><span class="acts"><button data-ic="refresh" id="rm-refresh" title="${esc(t("ws.refresh"))}"></button></span></div>`;
  if (!root) { el.innerHTML = head + `<div class="sec-empty">${esc(t("remote.noFolder"))}</div>`; hydrate(el); return; }
  el.innerHTML = head +
    grp(t("remote.local")) +
    `<div class="scm-row"><span class="pdot" style="background:var(--git-u)"></span><span class="nm">dxtutor · ${esc(base(root))}</span><span class="pth" style="margin-left:auto">${esc(t("remote.connected"))}</span></div>` +
    grp(t("remote.projects")) + `<div id="rm-projects"><div class="sec-empty">${esc(t("remote.scanning"))}</div></div>` +
    `<div class="sec-empty">${esc(t("remote.sshNote"))}</div>`;
  hydrate(el);
  el.querySelector<HTMLElement>("#rm-refresh")?.addEventListener("click", () => void renderRemote());
  try {
    const projects = await invoke<ProjectInfo[]>("detect_projects", { root });
    const box = document.getElementById("rm-projects"); if (!box) return;
    box.innerHTML = projects.length
      ? projects.map((p) => `<div class="scm-row"><span class="nm">${esc(p.name)}</span><span class="pth" style="margin-left:auto">${esc(p.kind)}</span></div>`).join("")
      : `<div class="sec-empty">${esc(t("remote.noProjects"))}</div>`;
  } catch (e) { const box = document.getElementById("rm-projects"); if (box) box.innerHTML = `<div class="sec-empty">${esc(String(e))}</div>`; }
}

// ─────────────────────────── Dev Containers ───────────────────────────
async function renderContainers(): Promise<void> {
  const el = document.getElementById("pane-containers"); if (!el) return;
  const root = workspaceRoot();
  const head = `<div class="side-hd"><span class="t">${esc(t("nav.containers"))}</span><span class="acts"><button data-ic="refresh" id="dc-refresh" title="${esc(t("ws.refresh"))}"></button></span></div>`;
  if (!root) { el.innerHTML = head + `<div class="sec-empty">${esc(t("remote.noFolder"))}</div>`; hydrate(el); return; }
  el.innerHTML = head + `<div class="sec-empty">${esc(t("containers.checking"))}</div>`;
  hydrate(el);
  el.querySelector<HTMLElement>("#dc-refresh")?.addEventListener("click", () => void renderContainers());
  let info: DevcontainerInfo;
  try { info = await invoke<DevcontainerInfo>("devcontainer_info", { root }); }
  catch (e) { el.querySelector(".sec-empty")!.textContent = String(e); return; }
  let status: SessionStatus | null = null;
  try { status = await invoke<SessionStatus>("devcontainer_session_status", { root }); } catch { /* */ }

  if (!info.present) {
    el.querySelector(".sec-empty")!.outerHTML =
      `<div class="sec-empty">${esc(t("containers.none"))}</div><div class="sec-empty">${esc(t("containers.noneNote"))}</div>`;
    return;
  }
  const running = status?.running ?? false;
  el.querySelector(".sec-empty")!.outerHTML =
    grp(t("containers.devcontainer")) +
    `<div class="kv"><span>${esc(t("containers.name"))}</span><span class="v">${esc(info.name || "—")}</span></div>` +
    `<div class="kv"><span>${esc(t("containers.image"))}</span><span class="v">${esc(info.image || "—")}</span></div>` +
    `<div class="kv"><span>${esc(t("containers.status"))}</span><span class="v"><span class="pdot" style="background:${running ? "var(--git-u)" : "var(--fg-muted)"}"></span> ${esc(running ? t("containers.running") : t("containers.stopped"))}</span></div>` +
    `<button class="btn" id="dc-up">${svg("container")} ${esc(running ? t("containers.reconnect") : t("containers.reopen"))}</button>` +
    (running ? `<button class="btn ghost" id="dc-down">${esc(t("containers.stop"))}</button>` : "") +
    `<div class="sec-empty">${esc(t("containers.dockerNote"))}</div>`;
  hydrate(el);
  el.querySelector<HTMLElement>("#dc-up")?.addEventListener("click", async () => {
    toast(t("containers.opening"));
    try { await invoke("devcontainer_session_up", { root }); toast(t("containers.opened")); await renderContainers(); }
    catch (e) { toast(String(e)); }
  });
  el.querySelector<HTMLElement>("#dc-down")?.addEventListener("click", async () => {
    try { await invoke("devcontainer_session_down", { root }); await renderContainers(); } catch (e) { toast(String(e)); }
  });
}

export function initRemote(): void {
  registerStrings(REMOTE_STRINGS);
  RP.remote = () => { void renderRemote(); };
  RP.containers = () => { void renderContainers(); };
}

const REMOTE_STRINGS = {
  en: {
    "remote.noFolder": "Open a folder first.", "remote.local": "Local", "remote.connected": "connected",
    "remote.projects": "Projects in this workspace", "remote.scanning": "Scanning…",
    "remote.noProjects": "No sub-projects detected.",
    "remote.sshNote": "SSH remotes are not configured in this build.",
    "containers.checking": "Checking for a dev container…", "containers.none": "No devcontainer.json found.",
    "containers.noneNote": "Add one to develop inside a container.",
    "containers.devcontainer": "Dev Container", "containers.name": "Name", "containers.image": "Image",
    "containers.status": "Status", "containers.running": "running", "containers.stopped": "stopped",
    "containers.reopen": "Reopen in Container", "containers.reconnect": "Reconnect", "containers.stop": "Stop container",
    "containers.opening": "Starting the container…", "containers.opened": "Container session is up.",
    "containers.dockerNote": "A plain `docker ps` listing is not available in this build.",
  },
  ptAO: {
    "remote.noFolder": "Abre primeiro uma pasta.", "remote.local": "Local", "remote.connected": "ligado",
    "remote.projects": "Projectos neste workspace", "remote.scanning": "A analisar…",
    "remote.noProjects": "Nenhum sub-projecto detectado.",
    "remote.sshNote": "Os remotos SSH não estão configurados nesta build.",
    "containers.checking": "A procurar um dev container…", "containers.none": "Não há devcontainer.json.",
    "containers.noneNote": "Cria um para desenvolver dentro de um contentor.",
    "containers.devcontainer": "Dev Container", "containers.name": "Nome", "containers.image": "Imagem",
    "containers.status": "Estado", "containers.running": "a correr", "containers.stopped": "parado",
    "containers.reopen": "Reabrir no contentor", "containers.reconnect": "Religar", "containers.stop": "Parar contentor",
    "containers.opening": "A arrancar o contentor…", "containers.opened": "Sessão do contentor activa.",
    "containers.dockerNote": "Uma listagem `docker ps` simples não está disponível nesta build.",
  },
};
