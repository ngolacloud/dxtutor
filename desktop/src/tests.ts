// Tests panel (section 5 — run and test). Lists the #[test] functions discovered in the
// open project (backend `list_tests`) and runs one at a time (`run_test`), showing its
// pass/fail and captured output. Works offline; no model involved.

import { invoke } from "@tauri-apps/api/core";
import { openFileAt, workspaceRoot } from "./workspace";

interface TestItem {
  name: string;
  path: string;
  file: string;
  line: number;
  ignored: boolean;
}
interface TestRun {
  ran: boolean;
  passed: boolean;
  output: string;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let ensureWorkspaceMode: () => void = () => {};
let items: TestItem[] = [];
let lastRoot = "";
const status = new Map<string, "running" | "passed" | "failed">();

export function initTests(deps: { ensureWorkspaceMode: () => void }): void {
  ensureWorkspaceMode = deps.ensureWorkspaceMode;
  $("#tests-close").addEventListener("click", () => $("#tests-overlay").classList.add("hidden"));
  $("#tests-refresh").addEventListener("click", () => void scan());
  // Row actions: click a test → open its location; "Run" → run it.
  $("#tests-list").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button.test-run") as HTMLButtonElement | null;
    const row = (e.target as HTMLElement).closest(".test-row") as HTMLElement | null;
    if (btn) {
      void runOne(btn.dataset.path!);
      return;
    }
    if (row) {
      const it = items.find((t) => t.path === row.dataset.path);
      if (it) void openFileAt(resolve(it.file), it.line, 1);
    }
  });
}

export function openTests(): void {
  $("#review-overlay")?.classList.add("hidden");
  $("#assistant-overlay")?.classList.add("hidden");
  $("#codemap-overlay")?.classList.add("hidden");
  $("#tests-overlay").classList.remove("hidden");
  void scan();
}

function resolve(file: string): string {
  const root = lastRoot || workspaceRoot() || "";
  const f = file.replace(/^\.\//, "");
  return f.startsWith("/") ? f : `${root.replace(/\/$/, "")}/${f}`;
}

async function scan(): Promise<void> {
  ensureWorkspaceMode();
  const root = workspaceRoot();
  if (!root) {
    $("#tests-list").innerHTML = `<div class="tests-note">Open a project folder to discover its tests.</div>`;
    $("#tests-count").textContent = "";
    return;
  }
  lastRoot = root;
  $("#tests-list").innerHTML = `<div class="tests-note">Scanning…</div>`;
  try {
    items = await invoke<TestItem[]>("list_tests", { root });
    render();
  } catch (e) {
    $("#tests-list").innerHTML = `<div class="tests-note err">Discovery failed: ${esc(String(e))}</div>`;
  }
}

function render(): void {
  $("#tests-count").textContent = items.length ? `${items.length} test${items.length === 1 ? "" : "s"}` : "";
  if (items.length === 0) {
    $("#tests-list").innerHTML = `<div class="tests-note">No #[test] functions found in this project.</div>`;
    return;
  }
  $("#tests-list").innerHTML = items
    .map((t) => {
      const st = status.get(t.path);
      const dot = st === "passed" ? "ok" : st === "failed" ? "fail" : st === "running" ? "run" : "";
      const rel = relative(resolve(t.file));
      return `<div class="test-row" data-path="${esc(t.path)}" title="${esc(t.path)}">
          <span class="test-dot ${dot}"></span>
          <span class="test-name">${esc(t.name)}${t.ignored ? ' <span class="test-ign">ignored</span>' : ""}</span>
          <span class="test-loc">${esc(rel)}:${t.line}</span>
          <button class="test-run" data-path="${esc(t.path)}" ${st === "running" ? "disabled" : ""}>Run</button>
        </div>`;
    })
    .join("");
}

function relative(abs: string): string {
  const r = (lastRoot || "").replace(/\/$/, "") + "/";
  return abs.startsWith(r) ? abs.slice(r.length) : abs;
}

async function runOne(path: string): Promise<void> {
  const root = lastRoot || workspaceRoot();
  if (!root) return;
  status.set(path, "running");
  render();
  $("#tests-output").textContent = `$ cargo test ${path} -- --exact\nrunning…`;
  try {
    const res = await invoke<TestRun>("run_test", { root, path });
    status.set(path, res.ran && res.passed ? "passed" : "failed");
    const verdict = !res.ran ? "⚠ did not run" : res.passed ? "✓ passed" : "✗ failed";
    $("#tests-output").textContent = `$ cargo test ${path} -- --exact   ${verdict}\n\n${res.output}`;
  } catch (e) {
    status.set(path, "failed");
    $("#tests-output").textContent = `run failed: ${String(e)}`;
  }
  render();
}
