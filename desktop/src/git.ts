// Git panel (section 5 — daily work). Lists the working-tree changes (git_changes) and
// shows a unified, colourised diff for the selected file (git_diff). Read-only.

import { invoke } from "@tauri-apps/api/core";
import { openFileAt, workspaceRoot } from "./workspace";

interface GitChange {
  path: string;
  status: string;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let ensureWorkspaceMode: () => void = () => {};
let changes: GitChange[] = [];
let lastRoot = "";

export function initGit(deps: { ensureWorkspaceMode: () => void }): void {
  ensureWorkspaceMode = deps.ensureWorkspaceMode;
  $("#git-close").addEventListener("click", () => $("#git-overlay").classList.add("hidden"));
  $("#git-refresh").addEventListener("click", () => void scan());
  $("#git-list").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".git-row") as HTMLElement | null;
    const open = (e.target as HTMLElement).closest(".git-open");
    if (!row) return;
    if (open) void openFileAt(resolve(row.dataset.path!), 1, 1);
    else void showDiff(row.dataset.path!);
  });
}

export function openGit(): void {
  $("#review-overlay")?.classList.add("hidden");
  $("#assistant-overlay")?.classList.add("hidden");
  $("#codemap-overlay")?.classList.add("hidden");
  $("#tests-overlay")?.classList.add("hidden");
  $("#search-overlay")?.classList.add("hidden");
  $("#git-overlay").classList.remove("hidden");
  void scan();
}

function resolve(path: string): string {
  return path.startsWith("/") ? path : `${lastRoot.replace(/\/$/, "")}/${path}`;
}

async function scan(): Promise<void> {
  ensureWorkspaceMode();
  const root = workspaceRoot();
  if (!root) {
    $("#git-list").innerHTML = `<div class="tests-note">Open a project folder to see its Git changes.</div>`;
    $("#git-count").textContent = "";
    $("#git-diff").textContent = "";
    return;
  }
  lastRoot = root;
  try {
    changes = await invoke<GitChange[]>("git_changes", { root });
    render();
  } catch (e) {
    $("#git-list").innerHTML = `<div class="tests-note err">Git failed: ${esc(String(e))}</div>`;
  }
}

function render(): void {
  $("#git-count").textContent = changes.length ? `${changes.length} changed` : "clean";
  if (changes.length === 0) {
    $("#git-list").innerHTML = `<div class="tests-note">No working-tree changes (or not a git repo).</div>`;
    $("#git-diff").textContent = "";
    return;
  }
  $("#git-list").innerHTML = changes
    .map(
      (c) =>
        `<div class="git-row" data-path="${esc(c.path)}" title="${esc(c.path)}">
          <span class="git-status s-${esc(c.status || "?")}">${esc(c.status || "?")}</span>
          <span class="test-name">${esc(c.path)}</span>
          <button class="git-open" title="Open file">open</button>
        </div>`,
    )
    .join("");
}

async function showDiff(path: string): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  $("#git-diff").textContent = "loading diff…";
  try {
    const diff = await invoke<string>("git_diff", { root, file: path });
    renderDiff(diff || "No tracked changes vs HEAD (the file may be untracked).");
  } catch (e) {
    $("#git-diff").textContent = `diff failed: ${String(e)}`;
  }
}

function renderDiff(diff: string): void {
  // Colourise unified-diff lines: additions, deletions, hunk headers.
  $("#git-diff").innerHTML = diff
    .split("\n")
    .map((l) => {
      const cls =
        l.startsWith("+") && !l.startsWith("+++")
          ? "d-add"
          : l.startsWith("-") && !l.startsWith("---")
            ? "d-del"
            : l.startsWith("@@")
              ? "d-hunk"
              : l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("+++") || l.startsWith("---")
                ? "d-meta"
                : "";
      return `<span class="${cls}">${esc(l)}</span>`;
    })
    .join("\n");
}
