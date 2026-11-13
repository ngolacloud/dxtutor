// shell/debug.ts — Fase 2 (paridade): pane «Run and Debug» ligado ao backend REAL.
//
// Correr: `run_path(path, args?)` executa o ficheiro/projecto activo e a saída real
// (stdout+stderr) vai para o painel Output — nada simulado, o veredicto vem do runner.
// `run_measured(code)` acrescenta telemetria medida pelo kernel (só Rust). Trace (Python):
// `trace_execution(language, code)` devolve o percurso passo-a-passo da execução REAL.
// Capacidades de debug: `debug_capabilities()` diz a VERDADE — só há breakpoints reais
// quando existe um adaptador DAP no host; caso contrário aponta honestamente para o tracer
// (Visualize). Breakpoints no gutter do Monaco exigem acoplamento ao workspace.ts (que não
// tocamos aqui), por isso ficam VISÍVEIS mas desactivados com «not implemented yet».

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { svg, hydrate } from "./icons";
import { RP, setPanelTab, toast, addCommand } from "./index";
import { workspaceRoot, activeFile } from "./workspace";

// ── Formas dos DTO do backend (camelCase, tal como serializadas em main.rs) ──────
interface RunResult { ok: boolean; stdout: string; stderr: string }
interface Sample { tMs: number; rssKb: number }
interface Telemetry {
  wallMs: number; cpuUserMs: number; cpuSysMs: number; peakRssKb: number;
  ioReadBlocks: number; ioWriteBlocks: number; exitCode: number; samples: Sample[];
}
interface MeasuredRun { run: RunResult; telemetry: Telemetry }
interface TraceVar { name: string; value: string; ty: string }
interface TraceStep { line: number; event: string; func: string; depth: number; locals: TraceVar[]; stdoutLen: number }
interface ExecutionTrace { supported: boolean; notes: string; steps: TraceStep[]; stdout: string }
interface DebugCapability { available: boolean; adapter: string | null; engine: string | null; note: string }

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const base = (p: string): string => p.split("/").pop() || p;
const extOf = (p: string): string => { const b = base(p); const i = b.lastIndexOf("."); return i >= 0 ? b.slice(i + 1).toLowerCase() : ""; };

// Última capacidade de debug detectada (preenchida de forma assíncrona ao pintar o pane).
let caps: DebugCapability | null = null;

// ── Saída no painel Output ───────────────────────────────────────────────────

/** Escreve o resultado de um `run_path`/`run_measured` no painel Output (nada simulado). */
function showRun(title: string, run: RunResult): void {
  const out = document.getElementById("pc-output");
  if (out) {
    const cls = run.ok ? "ok" : "er";
    const body = [run.stdout, run.stderr].filter((s) => s && s.length).join("\n");
    out.innerHTML =
      `<div class="${cls}" style="margin-bottom:6px">${esc(title)} — ${run.ok ? esc(t("debug.ok")) : esc(t("debug.fail"))}</div>` +
      `<pre style="white-space:pre-wrap;margin:0">${esc(body || t("debug.noOutput"))}</pre>`;
  }
  setPanelTab("output");
}

/** Acrescenta à saída um bloco de telemetria medida pelo kernel (só Rust). */
function showTelemetry(tel: Telemetry): void {
  const out = document.getElementById("pc-output");
  if (!out) return;
  const lines = [
    `${t("debug.wall")}: ${tel.wallMs.toFixed(1)} ms`,
    `${t("debug.cpu")}: ${tel.cpuUserMs.toFixed(1)} / ${tel.cpuSysMs.toFixed(1)} ms`,
    `${t("debug.peakRss")}: ${tel.peakRssKb} KB`,
    `${t("debug.io")}: ${tel.ioReadBlocks} / ${tel.ioWriteBlocks}`,
    `${t("debug.exit")}: ${tel.exitCode}`,
    `${t("debug.samples")}: ${tel.samples.length}`,
  ];
  out.insertAdjacentHTML(
    "beforeend",
    `<div style="margin-top:8px;color:var(--accent-hover)">${esc(t("debug.telemetry"))}</div>` +
      `<pre style="white-space:pre-wrap;margin:0">${esc(lines.join("\n"))}</pre>`,
  );
}

/** Pinta o trace passo-a-passo da execução REAL no painel Output. */
function showTrace(tr: ExecutionTrace): void {
  const out = document.getElementById("pc-output");
  if (out) {
    if (!tr.supported) {
      out.innerHTML = `<div class="warn" style="margin-bottom:6px">${esc(t("debug.traceUnsupported"))}</div>` +
        `<pre style="white-space:pre-wrap;margin:0">${esc(tr.notes || "")}</pre>`;
    } else {
      const rows = tr.steps.map((s) => {
        const vars = s.locals.map((v) => `${v.name}=${v.value}:${v.ty}`).join(", ");
        const pad = "  ".repeat(Math.max(0, s.depth));
        return `${pad}L${s.line} ${s.event} ${s.func}${vars ? "  {" + vars + "}" : ""}`;
      });
      out.innerHTML =
        `<div class="ok" style="margin-bottom:6px">${esc(t("debug.traceDone", { n: tr.steps.length }))}</div>` +
        (tr.notes ? `<div class="warn" style="margin-bottom:6px">${esc(tr.notes)}</div>` : "") +
        `<pre style="white-space:pre-wrap;margin:0">${esc(rows.join("\n") || t("debug.noOutput"))}</pre>` +
        (tr.stdout ? `<div style="margin-top:8px;color:var(--accent-hover)">stdout</div><pre style="white-space:pre-wrap;margin:0">${esc(tr.stdout)}</pre>` : "");
    }
  }
  setPanelTab("output");
}

// ── Acções (todas delegam no backend real) ──────────────────────────────────

/** Corre o ficheiro activo (ou com argumentos) via `run_path`. */
async function runActive(args?: string): Promise<void> {
  const path = activeFile();
  if (!path) { toast(t("debug.noActive")); return; }
  toast(t("debug.running", { name: base(path) }));
  try { showRun(base(path), await invoke<RunResult>("run_path", { path, args: args ?? null })); }
  catch (e) { toast(String(e)); }
}

/** Corre o entrypoint do projecto (detectado pelo manifesto de build), via `run_path`. */
async function runProject(): Promise<void> {
  const root = workspaceRoot();
  if (!root) { toast(t("debug.noFolder")); return; }
  let entry: string | null = null;
  try { entry = await invoke<string | null>("project_entrypoint", { root }); }
  catch (e) { toast(String(e)); return; }
  if (!entry) { toast(t("debug.noEntry")); return; }
  toast(t("debug.running", { name: base(entry) }));
  try { showRun(base(entry), await invoke<RunResult>("run_path", { path: entry, args: null })); }
  catch (e) { toast(String(e)); }
}

/** Corre o ficheiro Rust activo com telemetria medida pelo kernel (`run_measured`). */
async function runMeasured(): Promise<void> {
  const path = activeFile();
  if (!path) { toast(t("debug.noActive")); return; }
  if (extOf(path) !== "rs") { toast(t("debug.measuredRustOnly")); return; }
  let code: string;
  try { code = await invoke<string>("read_text_file", { path }); }
  catch (e) { toast(String(e)); return; }
  toast(t("debug.running", { name: base(path) }));
  try {
    const m = await invoke<MeasuredRun>("run_measured", { code });
    showRun(base(path), m.run);
    showTelemetry(m.telemetry);
  } catch (e) { toast(String(e)); }
}

/** Trace passo-a-passo da execução REAL do ficheiro activo (só Python). */
async function traceActive(): Promise<void> {
  const path = activeFile();
  if (!path) { toast(t("debug.noActive")); return; }
  const language = extOf(path) === "py" ? "python" : extOf(path);
  let code: string;
  try { code = await invoke<string>("read_text_file", { path }); }
  catch (e) { toast(String(e)); return; }
  toast(t("debug.tracing", { name: base(path) }));
  try { showTrace(await invoke<ExecutionTrace>("trace_execution", { language, code })); }
  catch (e) { toast(String(e)); }
}

// ── Pintura do pane ──────────────────────────────────────────────────────────

function configRow(act: string, label: string, hint: string, enabled: boolean, icon = "run"): string {
  const dim = enabled ? "" : ' style="opacity:.5;cursor:default"';
  return `<div class="scm-row" data-act="${enabled ? act : ""}"${dim}>` +
    `<span class="ic" style="color:var(--green);flex:none;display:grid;place-items:center;width:16px">${svg(icon)}</span>` +
    `<span class="nm">${esc(label)}</span><span class="pth" style="margin-left:auto">${esc(hint)}</span></div>`;
}

function capsHtml(): string {
  if (!caps) return `<div class="sec-empty">${esc(t("debug.detecting"))}</div>`;
  const tag = caps.available
    ? `<span class="tag live">DAP</span>`
    : `<span class="tag warn">${esc(t("debug.tracerFallback"))}</span>`;
  const kv = (k: string, v: string): string => `<div class="kv"><span>${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  return (
    `<div class="kv"><span>${esc(t("debug.realDebugger"))}</span><span class="v">${tag}</span></div>` +
    kv(t("debug.adapter"), caps.adapter || "—") +
    kv(t("debug.engine"), caps.engine || "—") +
    `<div class="sec-empty">${esc(caps.note)}</div>`
  );
}

function renderDebug(): void {
  const el = document.getElementById("pane-run"); if (!el) return;
  const root = workspaceRoot();
  const active = activeFile();
  const ext = active ? extOf(active) : "";
  const head = `<div class="side-hd"><span class="t">${esc(t("nav.run"))}</span>` +
    `<span class="acts"><button data-ic="run" id="d-run" title="${esc(t("debug.runActive"))}"></button>` +
    `<button data-ic="refresh" id="d-refresh" title="${esc(t("ws.refresh"))}"></button></span></div>`;

  // Configurações de arranque — todas ligadas a run_path/run_measured/trace_execution.
  const configs =
    `<div class="scm-grp">${esc(t("debug.launch"))}</div>` +
    configRow("active", t("debug.runActive"), active ? base(active) : t("debug.noActive"), !!active) +
    configRow("project", t("debug.runProject"), root ? t("debug.entrypoint") : t("debug.noFolder"), !!root) +
    configRow("args", t("debug.runArgs"), t("debug.argsHint"), !!active) +
    configRow("measured", t("debug.runMeasured"), ext === "rs" ? t("debug.rust") : t("debug.measuredRustOnly"), ext === "rs", "runcircle") +
    configRow("trace", t("debug.trace"), ext === "py" ? "python" : t("debug.traceRust"), ext === "py", "debug");

  // Capacidades de debug (honestas).
  const capsSection = `<div class="scm-grp">${esc(t("debug.capabilities"))}</div><div id="d-caps">${capsHtml()}</div>`;

  // Breakpoints desactivados («not implemented yet») — gutter exige workspace.ts.
  const bp =
    `<div class="scm-grp">${esc(t("debug.breakpoints"))}</div>` +
    `<div class="scm-row" style="opacity:.5;cursor:default" title="${esc(t("debug.bpNyi"))}">` +
    `<span class="ic" style="flex:none;display:grid;place-items:center;width:16px;color:var(--fg-muted)">${svg("debug")}</span>` +
    `<span class="nm">${esc(t("debug.bpGutter"))}</span><span class="tag warn" style="margin-left:auto">not implemented yet</span></div>` +
    `<div class="sec-empty">${esc(t("debug.bpNote"))}</div>`;

  el.innerHTML = head + `<div class="sections">` + configs + capsSection + bp + `</div>`;
  hydrate(el);

  el.querySelector<HTMLElement>("#d-run")?.addEventListener("click", () => void runActive());
  el.querySelector<HTMLElement>("#d-refresh")?.addEventListener("click", () => renderDebug());
  el.querySelectorAll<HTMLElement>(".scm-row[data-act]").forEach((row) => {
    const act = row.dataset.act;
    if (!act) return;
    row.onclick = () => {
      if (act === "active") void runActive();
      else if (act === "project") void runProject();
      else if (act === "args") { const a = window.prompt(t("debug.argsPrompt"), "") ?? undefined; if (a !== undefined) void runActive(a || undefined); }
      else if (act === "measured") void runMeasured();
      else if (act === "trace") void traceActive();
    };
  });

  // Detecta as capacidades de debug sem bloquear a pintura; actualiza o bloco quando chega.
  void invoke<DebugCapability>("debug_capabilities")
    .then((c) => { caps = c; const box = document.getElementById("d-caps"); if (box) box.innerHTML = capsHtml(); })
    .catch(() => { /* detecção total e sem panics no backend; silêncio se o host falhar */ });
}

export function initDebug(): void {
  registerStrings(DEBUG_STRINGS);
  RP.run = () => { renderDebug(); };
  addCommand({ id: "debug:runActive", label: () => t("debug.runActive"), run: () => void runActive() });
  addCommand({ id: "debug:runProject", label: () => t("debug.runProject"), run: () => void runProject() });
  addCommand({ id: "debug:runMeasured", label: () => t("debug.runMeasured"), run: () => void runMeasured() });
  addCommand({ id: "debug:trace", label: () => t("debug.trace"), run: () => void traceActive() });
}

const DEBUG_STRINGS = {
  en: {
    "debug.launch": "Launch configurations",
    "debug.capabilities": "Debug capabilities",
    "debug.breakpoints": "Breakpoints",
    "debug.runActive": "Run active file",
    "debug.runProject": "Run project",
    "debug.runArgs": "Run with arguments…",
    "debug.runMeasured": "Run measured (telemetry)",
    "debug.trace": "Trace execution (Python)",
    "debug.argsHint": "prompts for arguments",
    "debug.argsPrompt": "Arguments to pass to the program",
    "debug.entrypoint": "project entry point",
    "debug.rust": "rust",
    "debug.traceRust": "Python only",
    "debug.measuredRustOnly": "Rust only",
    "debug.realDebugger": "Real debugger",
    "debug.tracerFallback": "tracer fallback",
    "debug.adapter": "DAP adapter",
    "debug.engine": "Debug engine",
    "debug.detecting": "Detecting debug capabilities…",
    "debug.running": "Running {name}…",
    "debug.tracing": "Tracing {name}…",
    "debug.noActive": "Open a file to run.",
    "debug.noFolder": "Open a folder first.",
    "debug.noEntry": "No runnable project entry point found.",
    "debug.ok": "ran ok",
    "debug.fail": "exited with error",
    "debug.noOutput": "(no output)",
    "debug.telemetry": "Kernel-measured telemetry",
    "debug.wall": "wall clock",
    "debug.cpu": "cpu user/sys",
    "debug.peakRss": "peak RSS",
    "debug.io": "io read/write blocks",
    "debug.exit": "exit code",
    "debug.samples": "memory samples",
    "debug.traceDone": "Trace: {n} steps (real execution)",
    "debug.traceUnsupported": "Step-through trace not supported for this language.",
    "debug.bpGutter": "Gutter breakpoints (Monaco)",
    "debug.bpNyi": "Not implemented yet — needs editor gutter coupling.",
    "debug.bpNote": "Breakpoints require coupling to the Monaco editor gutter in workspace.ts; not wired yet. Until a DAP adapter is installed, step through with Trace (Visualize).",
  },
  ptAO: {
    "debug.launch": "Configurações de arranque",
    "debug.capabilities": "Capacidades de depuração",
    "debug.breakpoints": "Pontos de paragem",
    "debug.runActive": "Correr o ficheiro activo",
    "debug.runProject": "Correr o projecto",
    "debug.runArgs": "Correr com argumentos…",
    "debug.runMeasured": "Correr medido (telemetria)",
    "debug.trace": "Rastrear execução (Python)",
    "debug.argsHint": "pede os argumentos",
    "debug.argsPrompt": "Argumentos a passar ao programa",
    "debug.entrypoint": "ponto de entrada do projecto",
    "debug.rust": "rust",
    "debug.traceRust": "só Python",
    "debug.measuredRustOnly": "só Rust",
    "debug.realDebugger": "Depurador real",
    "debug.tracerFallback": "recorre ao tracer",
    "debug.adapter": "adaptador DAP",
    "debug.engine": "motor de depuração",
    "debug.detecting": "A detectar capacidades de depuração…",
    "debug.running": "A correr {name}…",
    "debug.tracing": "A rastrear {name}…",
    "debug.noActive": "Abre um ficheiro para correr.",
    "debug.noFolder": "Abre primeiro uma pasta.",
    "debug.noEntry": "Não há ponto de entrada executável no projecto.",
    "debug.ok": "correu bem",
    "debug.fail": "terminou com erro",
    "debug.noOutput": "(sem saída)",
    "debug.telemetry": "Telemetria medida pelo kernel",
    "debug.wall": "relógio de parede",
    "debug.cpu": "cpu utilizador/sistema",
    "debug.peakRss": "RSS máximo",
    "debug.io": "blocos io leitura/escrita",
    "debug.exit": "código de saída",
    "debug.samples": "amostras de memória",
    "debug.traceDone": "Trace: {n} passos (execução real)",
    "debug.traceUnsupported": "Rastreio passo-a-passo não suportado para esta linguagem.",
    "debug.bpGutter": "Pontos de paragem no gutter (Monaco)",
    "debug.bpNyi": "Ainda não implementado — exige acoplamento ao gutter do editor.",
    "debug.bpNote": "Os pontos de paragem exigem acoplamento ao gutter do editor Monaco em workspace.ts; ainda não está ligado. Até instalar um adaptador DAP, rastreia com o Trace (Visualize).",
  },
};
