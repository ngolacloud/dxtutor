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

export function initRemote(deps: { ensureWorkspaceMode: () => void }): void {
  ensureWorkspaceMode = deps.ensureWorkspaceMode;
  $("#remote-close").addEventListener("click", () => $("#remote-overlay").classList.add("hidden"));
  $("#remote-refresh").addEventListener("click", () => void scan());
  $("#remote-body").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLElement | null;
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "create") void create();
    else if (act === "open" && btn.dataset.path) void openFileAt(btn.dataset.path, 1, 1);
    else if (act === "reopen") void reopenInContainer();
  });
}

/** "Reopen in Container": switch the sandbox engine to Delonix so this project's code runs
 *  inside the container, mirroring VSCode's Dev Containers reopen. */
async function reopenInContainer(): Promise<void> {
  try {
    await invoke<string>("set_sandbox_engine", { engine: "delonix" });
  } catch {
    /* keep going — scan reflects the real state */
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
  const inContainer = engine !== "host";
  body.innerHTML = `
    ${engineBlock(engine)}
    <div class="remote-group">Dev Containers</div>
    ${
      dc.present
        ? `<div class="remote-card">
             <div class="remote-card-top">
               <span class="remote-dot ok"></span>
               <span class="remote-name">${esc(dc.name ?? "devcontainer")}</span>
               <button class="remote-link" data-act="open" data-path="${esc(dc.path ?? "")}">config</button>
             </div>
             ${dc.image ? `<div class="remote-card-sub">${esc(dc.image)}</div>` : ""}
             <button class="remote-reopen${inContainer ? " done" : ""}" data-act="reopen">
               ${inContainer ? "✓ Running in container" : "⟲ Reopen in Container"}
             </button>
           </div>
           <div class="remote-note">${
             inContainer
               ? `Your code runs inside the <b>${esc(engine)}</b> sandbox.`
               : "Reopen to run this project's code inside the Delonix container defined above."
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
