// Remote view (VSCode Remote Explorer style). Surfaces the Dev Container config for the
// open folder and the active sandbox engine, with actions to create/open devcontainer.json.

import { invoke } from "@tauri-apps/api/core";
import { workspaceRoot, openFileAt, createDevcontainer } from "./workspace";

interface DevcontainerInfo {
  present: boolean;
  name: string | null;
  image: string | null;
  path: string | null;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let ensureWorkspaceMode: () => void = () => {};
let openSessionTerminal: (root: string) => void = () => {};

export function initRemote(deps: {
  ensureWorkspaceMode: () => void;
  openSessionTerminal?: (root: string) => void;
}): void {
  ensureWorkspaceMode = deps.ensureWorkspaceMode;
  if (deps.openSessionTerminal) openSessionTerminal = deps.openSessionTerminal;
  $("#remote-close").addEventListener("click", () => $("#remote-overlay").classList.add("hidden"));
  $("#remote-refresh").addEventListener("click", () => void scan());
  $("#remote-body").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLElement | null;
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "create") void create();
    else if (act === "open" && btn.dataset.path) void openFileAt(btn.dataset.path, 1, 1);
    else if (act === "reopen") void reopenInContainer();
    else if (act === "exec") void execInContainer();
    else if (act === "stop") void stopSession();
    else if (act === "terminal") {
      const root = workspaceRoot();
      if (root) openSessionTerminal(root);
    }
  });
  $("#remote-body").addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.id === "remote-exec-input" && (e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void execInContainer();
    }
  });
}

/** Exec a shell line inside the devcontainer image with the workspace mounted — the
 *  practical "attached session": run commands in the project's container environment. */
async function execInContainer(): Promise<void> {
  const input = document.getElementById("remote-exec-input") as HTMLInputElement | null;
  const cmd = input?.value.trim();
  if (!cmd) return;
  const log = $("#remote-log");
  log.classList.remove("hidden");
  log.textContent = `$ ${cmd}\n⟳ running in container…`;
  try {
    const r = await invoke<DevcontainerUp>("devcontainer_session_exec", {
      root: workspaceRoot(),
      cmd,
    });
    log.textContent =
      `${r.ok ? "✓" : "✗"} $ ${r.ran}\n` + (r.stdout || "") + (r.stderr ? `\n[stderr]\n${r.stderr}` : "");
    if (input) input.value = "";
  } catch (e) {
    log.textContent = `✗ ${String(e)}`;
  }
}

interface DevcontainerUp {
  ok: boolean;
  image: string;
  built: boolean;
  ran: string;
  stdout: string;
  stderr: string;
}

/** "Reopen in Container": switch to Delonix AND start a PERSISTENT session — a long-lived
 *  container with the workspace mounted (building the image first if needed). State then
 *  persists across the exec commands you run below. */
async function reopenInContainer(): Promise<void> {
  const log = $("#remote-log");
  log.classList.remove("hidden");
  log.textContent = "⟳ Switching to the Delonix sandbox…";
  try {
    await invoke<string>("set_sandbox_engine", { engine: "delonix" });
  } catch {
    /* keep going — scan reflects the real state */
  }
  log.textContent = "⟳ Starting a persistent container session (build/pull + run)…";
  try {
    const r = await invoke<DevcontainerUp>("devcontainer_session_up", { root: workspaceRoot() });
    log.textContent =
      `${r.ok ? "✓" : "✗"} ${r.image}${r.built ? " (built)" : ""}\n` +
      (r.stdout || "") +
      (r.stderr ? `\n[stderr]\n${r.stderr}` : "");
  } catch (e) {
    log.textContent = `✗ ${String(e)}`;
  }
  await scan(); // #remote-log is a sibling of #remote-body, so it survives the rebuild
}

/** Stop and remove the persistent session container. */
async function stopSession(): Promise<void> {
  const log = $("#remote-log");
  log.classList.remove("hidden");
  log.textContent = "⟳ Stopping the session…";
  try {
    await invoke("devcontainer_session_down", { root: workspaceRoot() });
    log.textContent = "✓ Session stopped.";
  } catch (e) {
    log.textContent = `✗ ${String(e)}`;
  }
  await scan();
}

export function openRemote(): void {
  $("#remote-overlay").classList.remove("hidden");
  void scan();
}

async function create(): Promise<void> {
  await createDevcontainer();
  await scan();
}

async function scan(): Promise<void> {
  ensureWorkspaceMode();
  const body = $("#remote-body");
  const root = workspaceRoot();
  let engine = "host";
  try {
    engine = await invoke<string>("get_sandbox_engine");
  } catch {
    /* keep default */
  }
  if (!root) {
    body.innerHTML = `
      ${engineBlock(engine)}
      <div class="remote-group">Dev Containers</div>
      <div class="remote-note">Open a folder to detect its Dev Container.</div>`;
    return;
  }
  let dc: DevcontainerInfo = { present: false, name: null, image: null, path: null };
  try {
    dc = await invoke<DevcontainerInfo>("devcontainer_info", { root });
  } catch {
    /* treat as absent */
  }
  let running = false;
  try {
    running = (await invoke<{ running: boolean }>("devcontainer_session_status", { root })).running;
  } catch {
    /* no session */
  }
  body.innerHTML = `
    ${engineBlock(engine)}
    <div class="remote-group">Dev Containers</div>
    ${
      dc.present
        ? `<div class="remote-card">
             <div class="remote-card-top">
               <span class="remote-dot ${running ? "ok" : ""}"></span>
               <span class="remote-name">${esc(dc.name ?? "devcontainer")}</span>
               <button class="remote-link" data-act="open" data-path="${esc(dc.path ?? "")}">config</button>
             </div>
             <div class="remote-card-sub">${esc(dc.image ?? "builds from Dockerfile")}</div>
             ${
               running
                 ? `<div class="remote-session-row">
                      <span class="remote-session-badge">● session running</span>
                      <button class="remote-session-term" data-act="terminal" title="Open an interactive shell in the container">⌨ Terminal</button>
                      <button class="remote-session-stop" data-act="stop">Stop</button>
                    </div>
                    <div class="remote-exec">
                      <input id="remote-exec-input" class="remote-exec-input" type="text" autocomplete="off" placeholder="run a command in the session…" aria-label="Command to run in container" />
                      <button class="remote-exec-go" data-act="exec" title="Run in session">▸</button>
                    </div>`
                 : `<button class="remote-reopen" data-act="reopen">⟲ Reopen in Container</button>`
             }
           </div>
           <div class="remote-note">${
             running
               ? "A persistent container session is running — commands you run share its state (installed packages, files)."
               : "Reopen to build/pull the image and start a persistent session with the workspace mounted."
           }</div>`
        : `<div class="remote-empty">
             <p class="remote-note">No Dev Container yet. Add one to run this project in a reproducible, isolated environment.</p>
             <button class="remote-reopen" data-act="create">＋ Create Dev Container</button>
           </div>`
    }`;
}

function engineBlock(engine: string): string {
  const label = engine === "host" ? "Host (no container)" : `${engine} sandbox`;
  const ok = engine !== "host";
  return `<div class="remote-group">Sandbox engine</div>
    <div class="remote-row">
      <span class="remote-dot ${ok ? "ok" : ""}"></span>
      <span class="remote-name">${esc(label)}</span>
    </div>`;
}
