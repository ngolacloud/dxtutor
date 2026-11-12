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

interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  refs: string[];
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
  $("#git-graph-toggle").addEventListener("click", () => void toggleGraph());
  $("#git-graph-list").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".git-commit-row") as HTMLElement | null;
    if (row?.dataset.hash) void showCommit(row.dataset.hash);
  });
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

// ── Tree decorations (reuses git_changes) ───────────────────────────────────
// The Explorer paints each file's name by its git state and a status letter at the
// right edge; folders roll up to a dot. It consumes the SAME `git_changes` command
// the SCM view uses — no new backend.

export interface GitDeco {
  letter: string; // M/U/A/D/R/C shown at the row's right edge
  cls: "git-m" | "git-u" | "git-d"; // colour bucket (name + letter/dot)
}

/** The git letter for a change: worktree column wins, falling back to the staged one. */
function decoLetter(c: GitChange): string {
  if (c.status === "??" || c.work === "?" || c.index === "?") return "U"; // untracked
  const code = (c.work.trim() || c.index.trim() || "M").toUpperCase();
  return "MADRC".includes(code) ? code : "M";
}

/** Colour bucket for a git letter: deletion red, untracked/added green, the rest gold. */
function decoClass(letter: string): GitDeco["cls"] {
  if (letter === "D") return "git-d";
  if (letter === "U" || letter === "A") return "git-u";
  return "git-m"; // M / R / C → modified (gold)
}

/**
 * Working-tree status as an ABSOLUTE-path → decoration map, for the Explorer tree.
 * Reuses `git_changes` (git status --porcelain); porcelain paths are root-relative, so
 * we prefix the root. Empty map when the folder is not a git repo (silent).
 */
export async function gitStatusMap(root: string): Promise<Map<string, GitDeco>> {
  const map = new Map<string, GitDeco>();
  try {
    const ch = await invoke<GitChange[]>("git_changes", { root });
    const base = root.replace(/[\\/]+$/, "");
    for (const c of ch) {
      const letter = decoLetter(c);
      const abs = c.path.startsWith("/") ? c.path : `${base}/${c.path}`;
      map.set(abs, { letter, cls: decoClass(letter) });
    }
  } catch {
    /* not a git repo → no decorations */
  }
  return map;
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

// ── Commit graph ───────────────────────────────────────────────────────────
let graphOpen = false;

async function toggleGraph(): Promise<void> {
  graphOpen = !graphOpen;
  $("#git-scm-view").classList.toggle("hidden", graphOpen);
  $("#git-graph-view").classList.toggle("hidden", !graphOpen);
  $("#git-graph-toggle").classList.toggle("view-open", graphOpen);
  if (graphOpen) await loadGraph();
}

async function loadGraph(): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  $("#git-graph-list").innerHTML = `<div class="tests-note">loading history…</div>`;
  let commits: GitCommit[] = [];
  try {
    commits = await invoke<GitCommit[]>("git_log", { root, max: 200 });
  } catch (e) {
    $("#git-graph-list").innerHTML = `<div class="tests-note err">log failed: ${esc(String(e))}</div>`;
    return;
  }
  if (commits.length === 0) {
    $("#git-graph-list").innerHTML = `<div class="tests-note">No commits yet.</div>`;
    return;
  }
  const rows = computeGraph(commits);
  $("#git-graph-list").innerHTML = commits.map((c, i) => commitRow(c, rows[i])).join("");
  $("#git-graph-detail").textContent = "";
}

// ── Multi-lane DAG layout ───────────────────────────────────────────────────
// Classic git-graph lane assignment: walk commits newest→oldest keeping a set of active
// lanes (each reserved for the next commit expected there). A commit takes the lane that
// was waiting for it; its first parent continues that lane, extra parents open/merge lanes.
interface GraphSeg {
  from: number; // column at the top edge
  to: number; // column at the bottom edge
  kind: "full" | "upper" | "lower"; // vertical span within the row
  lane: number; // colour key
}
interface GraphRow {
  nodeCol: number;
  merge: boolean;
  segs: GraphSeg[];
  width: number;
}

function computeGraph(commits: GitCommit[]): GraphRow[] {
  const lanes: (string | null)[] = []; // hash each active lane is waiting for
  const rows: GraphRow[] = [];
  const freeSlot = () => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const c of commits) {
    const top = lanes.slice();
    let nodeCol = lanes.indexOf(c.hash);
    if (nodeCol === -1) nodeCol = freeSlot();
    // Merge every lane that was waiting for this commit into the node.
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) lanes[i] = null;
    // Place parents: first parent keeps the node's lane; others open/merge lanes.
    const parentCols: number[] = [];
    c.parents.forEach((p, k) => {
      let col: number;
      if (k === 0) {
        col = nodeCol;
      } else {
        const existing = lanes.indexOf(p);
        col = existing !== -1 ? existing : freeSlot();
      }
      lanes[col] = p;
      parentCols.push(col);
    });
    const bottom = lanes.slice();
    const segs: GraphSeg[] = [];
    // Lanes coming from the top: either continue downward, or merge up into the node.
    for (let t = 0; t < top.length; t++) {
      const h = top[t];
      if (h == null) continue;
      if (h === c.hash) {
        segs.push({ from: t, to: nodeCol, kind: "upper", lane: t });
      } else {
        let b = bottom.indexOf(h);
        if (b === -1) b = t;
        segs.push({ from: t, to: b, kind: "full", lane: t });
      }
    }
    // Node → each parent (lower half).
    for (const b of parentCols) segs.push({ from: nodeCol, to: b, kind: "lower", lane: b });
    rows.push({
      nodeCol,
      merge: c.parents.length > 1,
      segs,
      width: Math.max(top.length, bottom.length, nodeCol + 1),
    });
  }
  return rows;
}

const LANE_W = 14;
const ROW_H = 46;
const LANE_COLORS = ["#4aa3ff", "#4ec9b0", "#e0a05a", "#c586c0", "#89d185", "#f14c4c", "#d7ba7d"];
const laneX = (col: number) => col * LANE_W + LANE_W / 2;
const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];

/** One commit row: an SVG rail drawing the DAG lanes + node, then the commit text. */
function commitRow(c: GitCommit, row: GraphRow): string {
  const w = Math.max(1, row.width) * LANE_W;
  const yTop = 0;
  const yMid = ROW_H / 2;
  const yBot = ROW_H;
  const paths = row.segs
    .map((s) => {
      const x1 = laneX(s.from);
      const x2 = laneX(s.to);
      const [ya, yb] = s.kind === "upper" ? [yTop, yMid] : s.kind === "lower" ? [yMid, yBot] : [yTop, yBot];
      // Smooth S-curve when the lane shifts columns; straight line otherwise.
      const d =
        x1 === x2
          ? `M${x1} ${ya}L${x2} ${yb}`
          : `M${x1} ${ya}C${x1} ${(ya + yb) / 2} ${x2} ${(ya + yb) / 2} ${x2} ${yb}`;
      return `<path d="${d}" stroke="${laneColor(s.lane)}" stroke-width="1.6" fill="none"/>`;
    })
    .join("");
  const cx = laneX(row.nodeCol);
  const node = row.merge
    ? `<circle cx="${cx}" cy="${yMid}" r="4.5" fill="var(--bg-sidebar)" stroke="${laneColor(row.nodeCol)}" stroke-width="2"/>`
    : `<circle cx="${cx}" cy="${yMid}" r="4.5" fill="${laneColor(row.nodeCol)}"/>`;
  const chips = c.refs
    .map((r) => {
      const tag = r.startsWith("tag:");
      const name = tag ? r.slice(4).trim() : r;
      return `<span class="git-ref${tag ? " tag" : ""}">${esc(name)}</span>`;
    })
    .join("");
  return `<div class="git-commit-row" data-hash="${esc(c.hash)}" title="${esc(c.hash)}">
      <svg class="git-graph-svg" width="${w}" height="${ROW_H}" viewBox="0 0 ${w} ${ROW_H}" style="flex:0 0 ${w}px">${paths}${node}</svg>
      <span class="git-commit-main">
        <span class="git-commit-subject">${chips}${esc(c.subject)}</span>
        <span class="git-commit-meta">${esc(c.short)} · ${esc(c.author)} · ${esc(c.date)}</span>
      </span>
    </div>`;
}

async function showCommit(hash: string): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  document.querySelectorAll("#git-graph-list .git-commit-row").forEach((el) =>
    el.classList.toggle("sel", (el as HTMLElement).dataset.hash === hash),
  );
  $("#git-graph-detail").textContent = "loading…";
  try {
    const patch = await invoke<string>("git_show", { root, hash });
    renderDiffInto("#git-graph-detail", patch || "(no changes)");
  } catch (e) {
    $("#git-graph-detail").textContent = `show failed: ${String(e)}`;
  }
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
  renderDiffInto("#git-diff", diff);
}

/** Colourise unified-diff lines (additions, deletions, hunk headers) into `sel`. */
function renderDiffInto(sel: string, diff: string): void {
  $(sel).innerHTML = diff
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
