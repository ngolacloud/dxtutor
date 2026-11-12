// Source Control panel (section 5 — daily work). A real SCM view (VSCode / GitLens style):
// groups Staged vs Changes, stages/unstages/commits via git_* commands, and shows a
// unified, colourised diff for the selected file.

import { invoke } from "@tauri-apps/api/core";
import { openFileAt, workspaceRoot } from "./workspace";

interface GitChange {
  path: string;
  status: string;
  index: string; // X column (staged)
  work: string; // Y column (worktree)
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let ensureWorkspaceMode: () => void = () => {};
let changes: GitChange[] = [];
let lastRoot = "";
let curBranch: string | null = null;

export function initGit(deps: { ensureWorkspaceMode: () => void }): void {
  ensureWorkspaceMode = deps.ensureWorkspaceMode;
  $("#git-close").addEventListener("click", () => $("#git-overlay").classList.add("hidden"));
  $("#git-refresh").addEventListener("click", () => void scan());
  $("#git-stageall").addEventListener("click", () => void stageAll());
  $("#git-commit-btn").addEventListener("click", () => void commit());
  $("#git-branch").addEventListener("click", () => void toggleBranches());
  $("#git-branches").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".git-branch-new")) {
      void createBranch();
      return;
    }
    const item = t.closest(".git-branch-item") as HTMLElement | null;
    if (item?.dataset.name) void checkout(item.dataset.name);
  });
  $("#git-message").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void commit();
    }
  });
  document.querySelector("#status-git")?.addEventListener("click", () => openGit());
  $("#git-list").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest(".git-row") as HTMLElement | null;
    if (!row) return;
    const path = row.dataset.path!;
    if (t.closest(".git-stage")) void stage(path);
    else if (t.closest(".git-unstage")) void unstage(path);
    else if (t.closest(".git-open")) void openFileAt(resolve(path), 1, 1);
    else void showDiff(path, row.dataset.staged === "1");
  });
}

/** Update the status-bar branch indicator (shown only inside a git repo). */
export async function refreshGitBranch(): Promise<void> {
  const el = document.querySelector<HTMLElement>("#status-git");
  if (!el) return;
  const root = workspaceRoot();
  if (!root) {
    el.classList.add("hidden");
    return;
  }
  try {
    const b = await invoke<string | null>("git_branch", { root });
    if (b) {
      el.textContent = `⎇ ${b}`;
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  } catch {
    el.classList.add("hidden");
  }
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
    const [branch, ch] = await Promise.all([
      invoke<string | null>("git_branch", { root }),
      invoke<GitChange[]>("git_changes", { root }),
    ]);
    changes = ch;
    render(branch);
  } catch (e) {
    $("#git-list").innerHTML = `<div class="tests-note err">Git failed: ${esc(String(e))}</div>`;
  }
}

/** A file is staged when its index column is a real code (not space, not untracked "?"). */
const isStaged = (c: GitChange) => c.index !== " " && c.index !== "?" && c.index !== "";
/** A file has worktree changes when its work column is a real code (incl. untracked "?"). */
const isUnstaged = (c: GitChange) => c.work !== " " && c.work !== "";

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function row(c: GitChange, staged: boolean): string {
  const code = staged ? c.index : c.work;
  const dir = dirname(c.path);
  const action = staged
    ? `<button class="git-unstage" title="Unstage">&#8722;</button>`
    : `<button class="git-stage" title="Stage">&#43;</button>`;
  return `<div class="git-row" data-path="${esc(c.path)}" data-staged="${staged ? 1 : 0}" title="${esc(c.path)}">
      <span class="git-name">${esc(basename(c.path))}</span>
      ${dir ? `<span class="git-dir">${esc(dir)}</span>` : ""}
      <span class="git-actions">${action}<button class="git-open" title="Open file">&#8599;</button></span>
      <span class="git-status s-${esc((code || "?").trim() || "?")}">${esc((code || "?").trim() || "?")}</span>
    </div>`;
}

function group(title: string, rows: string[], extra = ""): string {
  if (rows.length === 0) return "";
  return `<div class="git-group-hdr">${esc(title)}<span class="git-group-count">${rows.length}</span>${extra}</div>${rows.join("")}`;
}

function render(branch?: string | null): void {
  curBranch = branch ?? null;
  $("#git-branch").textContent = `⎇ ${branch ?? "—"}`;
  $("#git-count").textContent = changes.length ? `${changes.length} changed` : "clean";
  const staged = changes.filter(isStaged);
  const unstaged = changes.filter(isUnstaged);
  ($("#git-commit-btn") as HTMLButtonElement).disabled = staged.length === 0;
  if (changes.length === 0) {
    $("#git-list").innerHTML = `<div class="tests-note">No changes (working tree clean, or not a git repo).</div>`;
    $("#git-diff").textContent = "";
    return;
  }
  $("#git-list").innerHTML =
    group(
      "Staged Changes",
      staged.map((c) => row(c, true)),
    ) +
    group(
      "Changes",
      unstaged.map((c) => row(c, false)),
    );
}

async function toggleBranches(): Promise<void> {
  const panel = $("#git-branches");
  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  let names: string[] = [];
  try {
    names = await invoke<string[]>("git_branches", { root });
  } catch {
    /* not a repo */
  }
  panel.innerHTML =
    names
      .map(
        (n) =>
          `<div class="git-branch-item${n === curBranch ? " current" : ""}" data-name="${esc(n)}" role="option">${n === curBranch ? "● " : ""}${esc(n)}</div>`,
      )
      .join("") + `<div class="git-branch-new">＋ Create new branch…</div>`;
  panel.classList.remove("hidden");
}

async function checkout(branch: string): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root || branch === curBranch) {
    $("#git-branches").classList.add("hidden");
    return;
  }
  try {
    await invoke("git_checkout", { root, branch });
    $("#git-branches").classList.add("hidden");
    await scan();
  } catch (e) {
    flash(String(e));
  }
}

async function createBranch(): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  const name = window.prompt("New branch name:")?.trim();
  $("#git-branches").classList.add("hidden");
  if (!name) return;
  try {
    await invoke("git_create_branch", { root, name });
    await scan();
  } catch (e) {
    flash(String(e));
  }
}

async function stage(path: string): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  try {
    await invoke("git_stage", { root, path });
    await scan();
  } catch (e) {
    flash(String(e));
  }
}
async function unstage(path: string): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  try {
    await invoke("git_unstage", { root, path });
    await scan();
  } catch (e) {
    flash(String(e));
  }
}
async function stageAll(): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  try {
    await invoke("git_stage_all", { root });
    await scan();
  } catch (e) {
    flash(String(e));
  }
}
async function commit(): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  const msg = ($("#git-message") as HTMLTextAreaElement).value.trim();
  if (!msg) {
    flash("Write a commit message first.");
    return;
  }
  try {
    await invoke("git_commit", { root, message: msg });
    ($("#git-message") as HTMLTextAreaElement).value = "";
    $("#git-diff").textContent = "";
    await scan();
  } catch (e) {
    flash(String(e));
  }
}
function flash(msg: string): void {
  $("#git-count").textContent = msg;
}

async function showDiff(path: string, staged: boolean): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  $("#git-diff").textContent = "loading diff…";
  try {
    const diff = await invoke<string>("git_diff", { root, file: path, staged });
    renderDiff(diff || "No changes to show for this file.");
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
