// shell/tests.ts — Fase 2 (paridade): descoberta e execução de testes.
//
// Liga ao backend REAL (crate tutor-eval::testnav): list_tests descobre os testes
// (Rust/Go/Python), run_test corre um e run_all_tests corre a suite. A saída real
// (stdout+stderr) vai para o painel Output; o resultado actualiza a barra de estado.
// Sem simulação: o veredicto vem do runner, nunca de um modelo.

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { hydrate } from "./icons";
import { RP, setPanelTab, toast } from "./index";
import { workspaceRoot, openFileAt } from "./workspace";

interface TestItem { name: string; path: string; file: string; line: number; ignored: boolean; lang: string }
interface TestRun { ran: boolean; passed: boolean; output: string }

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const relbase = (p: string, root: string): string => (p.startsWith(root) ? p.slice(root.length + 1) : p);

let items: TestItem[] = [];

function showOutput(title: string, run: TestRun): void {
  const out = document.getElementById("pc-output");
  if (out) {
    const cls = !run.ran ? "warn" : run.passed ? "ok" : "er";
    out.innerHTML = `<div class="${cls}" style="margin-bottom:6px">${esc(title)} — ${run.ran ? (run.passed ? t("tests.passed") : t("tests.failed")) : t("tests.didNotRun")}</div><pre style="white-space:pre-wrap;margin:0">${esc(run.output || "")}</pre>`;
  }
  setPanelTab("output");
  const st = document.getElementById("st-tests");
  if (st) st.innerHTML = run.ran ? (run.passed ? `<span style="color:var(--git-u)">✓ ${esc(t("tests.ok"))}</span>` : `<span style="color:var(--red)">✗ ${esc(t("tests.fail"))}</span>`) : "";
}

async function runOne(it: TestItem, row: HTMLElement): Promise<void> {
  const root = workspaceRoot(); if (!root) return;
  const ind = row.querySelector(".t-ind"); if (ind) ind.innerHTML = '<span class="spin"></span>';
  try {
    const run = await invoke<TestRun>("run_test", { root, path: it.path, lang: it.lang });
    if (ind) ind.textContent = !run.ran ? "•" : run.passed ? "✓" : "✗";
    if (ind) (ind as HTMLElement).style.color = run.passed ? "var(--git-u)" : run.ran ? "var(--red)" : "var(--fg-muted)";
    showOutput(it.name, run);
  } catch (e) { if (ind) ind.textContent = "✗"; toast(String(e)); }
}

async function runAll(): Promise<void> {
  const root = workspaceRoot(); if (!root) return;
  toast(t("tests.running"));
  try { showOutput(t("tests.all"), await invoke<TestRun>("run_all_tests", { root })); }
  catch (e) { toast(String(e)); }
}

async function renderTests(): Promise<void> {
  const el = document.getElementById("pane-test"); if (!el) return;
  const root = workspaceRoot();
  const head = `<div class="side-hd"><span class="t">${esc(t("nav.test"))}</span><span class="acts"><button data-ic="runcircle" id="t-runall" title="${esc(t("tests.runAll"))}"></button><button data-ic="refresh" id="t-refresh" title="${esc(t("ws.refresh"))}"></button></span></div>`;
  if (!root) { el.innerHTML = head + `<div class="sec-empty">${esc(t("tests.noFolder"))}</div>`; hydrate(el); return; }
  el.innerHTML = head + `<div class="sec-empty">${esc(t("tests.discovering"))}</div>`;
  hydrate(el);
  el.querySelector<HTMLElement>("#t-refresh")?.addEventListener("click", () => void renderTests());
  el.querySelector<HTMLElement>("#t-runall")?.addEventListener("click", () => void runAll());
  try { items = await invoke<TestItem[]>("list_tests", { root }); }
  catch (e) { el.querySelector(".sec-empty")!.textContent = String(e); return; }
  if (!items.length) { el.querySelector(".sec-empty")!.textContent = t("tests.none"); return; }

  const byFile = new Map<string, TestItem[]>();
  for (const it of items) { const a = byFile.get(it.file) || []; a.push(it); byFile.set(it.file, a); }
  let html = "";
  for (const [file, fit] of byFile) {
    html += `<div class="scm-grp" style="text-transform:none">${esc(relbase(file, root))}<span class="cnt">${fit.length}</span></div>`;
    for (const it of fit) {
      html += `<div class="scm-row" data-path="${esc(it.path)}" data-lang="${esc(it.lang)}" data-file="${esc(it.file)}" data-line="${it.line}"><span class="t-ind" style="width:14px;text-align:center;color:var(--fg-muted);flex:none">▸</span><span class="nm">${esc(it.name)}</span>${it.ignored ? '<span class="tag warn" style="margin-left:6px">ignored</span>' : ""}<span class="pth" style="margin-left:auto">${esc(it.lang)}</span></div>`;
    }
  }
  el.querySelector(".sec-empty")!.outerHTML = `<div class="sections" id="t-list">${html}</div>`;
  const list = el.querySelector<HTMLElement>("#t-list")!;
  list.querySelectorAll<HTMLElement>(".scm-row").forEach((row) => {
    const it = items.find((x) => x.path === row.dataset.path && x.file === row.dataset.file)!;
    row.onclick = (e) => {
      if ((e.target as HTMLElement).closest(".nm")) { void runOne(it, row); return; }
      openFileAt(it.file, it.line);
    };
    const ind = row.querySelector<HTMLElement>(".t-ind");
    if (ind) ind.onclick = (e) => { e.stopPropagation(); void runOne(it, row); };
  });
}

export function initTests(): void {
  registerStrings(TESTS_STRINGS);
  RP.test = () => { void renderTests(); };
}

const TESTS_STRINGS = {
  en: {
    "tests.noFolder": "Open a folder with tests.", "tests.discovering": "Discovering tests…",
    "tests.none": "No tests found.", "tests.runAll": "Run all tests", "tests.running": "Running tests…",
    "tests.all": "All tests", "tests.passed": "passed", "tests.failed": "failed",
    "tests.didNotRun": "did not run", "tests.ok": "Tests pass", "tests.fail": "Tests fail",
  },
  ptAO: {
    "tests.noFolder": "Abre uma pasta com testes.", "tests.discovering": "A descobrir testes…",
    "tests.none": "Nenhum teste encontrado.", "tests.runAll": "Correr todos os testes", "tests.running": "A correr os testes…",
    "tests.all": "Todos os testes", "tests.passed": "passou", "tests.failed": "falhou",
    "tests.didNotRun": "não correu", "tests.ok": "Testes passam", "tests.fail": "Testes falham",
  },
};
