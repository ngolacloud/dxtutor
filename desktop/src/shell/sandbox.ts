// shell/sandbox.ts — Fase 2 (paridade, PARITY #27): selector do motor de sandbox em Settings.
//
// O motor decide ONDE corre o código do utilizador (drills, runs medidas, traces, o runner do
// Explorer): no host ou isolado em delonix/docker/podman. Liga ao backend REAL
// (get_sandbox_engine / set_sandbox_engine). Mostra os quatro motores com o actual marcado;
// escolher um aplica no runtime e reflecte a escolha. Honestidade: o backend não expõe
// detecção de disponibilidade, por isso a troca para um motor ausente FALHA com erro visível
// em vez de fingir que trocou. Montado na vista Settings via `setSandboxPanel` (index.ts),
// pelo mesmo padrão de injecção dos provedores (sem dependência circular).

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { setSandboxPanel, toast } from "./index";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// Motores aceites pelo backend (set_sandbox_engine): host|delonix|docker|podman.
const ENGINES = ["host", "delonix", "docker", "podman"] as const;
type Engine = (typeof ENGINES)[number];

/** Pinta a grelha de motores com o actual marcado. */
async function render(host: HTMLElement): Promise<void> {
  let current = "host";
  try { current = await invoke<string>("get_sandbox_engine"); }
  catch { host.innerHTML = `<div class="sec-empty">${esc(t("sandbox.loadErr"))}</div>`; return; }
  host.innerHTML =
    `<div class="pgrid">${ENGINES.map((e) => {
      const sel = e === current;
      return `<button class="pcard${sel ? " sel" : ""}" data-engine="${e}"><div class="ph">${esc(t("sandbox.engine." + e))}` +
        (sel ? `<span class="tag acc">${esc(t("sandbox.active"))}</span>` : "") + `</div>` +
        `<div class="pd">${esc(t("sandbox.engine." + e + ".d"))}</div></button>`;
    }).join("")}</div>` +
    `<div class="pd" style="margin-top:6px">${esc(t("sandbox.note"))}</div>`;
  host.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((b) => {
    b.onclick = () => void choose(b.dataset.engine as Engine, host);
  });
}

/** Aplica a escolha no backend; sucesso → repinta marcando o novo; falha → erro honesto (o
 *  motor pode não estar instalado) e o actual mantém-se. */
async function choose(engine: Engine, host: HTMLElement): Promise<void> {
  try {
    const applied = await invoke<string>("set_sandbox_engine", { engine });
    toast(t("sandbox.switched", { engine: t("sandbox.engine." + applied) }));
    await render(host);
  } catch (e) {
    toast(t("sandbox.switchErr", { e: String(e) }));
  }
}

/** Regista o painel de sandbox na vista Settings. Chamar antes de `bootShell()`. */
export function initSandbox(): void {
  registerStrings(SANDBOX_STRINGS);
  setSandboxPanel((host) => void render(host));
}

const SANDBOX_STRINGS = {
  en: {
    "settings.sandbox": "Sandbox engine",
    "sandbox.active": "active",
    "sandbox.loadErr": "Could not read the current sandbox engine.",
    "sandbox.switched": "Sandbox engine: {engine}.",
    "sandbox.switchErr": "Could not switch engine: {e}",
    "sandbox.note": "Decides where your code runs (drills, measured runs, traces, the Explorer runner). Switching to an engine that is not installed fails here rather than silently.",
    "sandbox.engine.host": "Host",
    "sandbox.engine.host.d": "Runs directly on this machine's toolchain.",
    "sandbox.engine.delonix": "Delonix",
    "sandbox.engine.delonix.d": "Isolated in the Delonix container runtime.",
    "sandbox.engine.docker": "Docker",
    "sandbox.engine.docker.d": "Isolated in Docker containers.",
    "sandbox.engine.podman": "Podman",
    "sandbox.engine.podman.d": "Isolated in Podman containers (rootless).",
  },
  ptAO: {
    "settings.sandbox": "Motor de sandbox",
    "sandbox.active": "activo",
    "sandbox.loadErr": "Não foi possível ler o motor de sandbox actual.",
    "sandbox.switched": "Motor de sandbox: {engine}.",
    "sandbox.switchErr": "Não foi possível trocar de motor: {e}",
    "sandbox.note": "Decide onde corre o teu código (drills, runs medidas, traces, o runner do Explorer). Trocar para um motor não instalado falha aqui, em vez de fingir que trocou.",
    "sandbox.engine.host": "Host",
    "sandbox.engine.host.d": "Corre directamente na toolchain desta máquina.",
    "sandbox.engine.delonix": "Delonix",
    "sandbox.engine.delonix.d": "Isolado no runtime de containers Delonix.",
    "sandbox.engine.docker": "Docker",
    "sandbox.engine.docker.d": "Isolado em containers Docker.",
    "sandbox.engine.podman": "Podman",
    "sandbox.engine.podman.d": "Isolado em containers Podman (rootless).",
  },
};
