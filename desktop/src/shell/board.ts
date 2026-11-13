// shell/board.ts — Fase 7: Board / kanban (planeamento + teste real).
//
// Porta a secção «Board» de docs/prototype/index.html (VIEW.board, BL, STAGES,
// dropIssue, approveIssue, rejectIssue, runSprint) para um módulo real. Seis
// colunas de kanban com cartões arrastáveis; o MODELO das issues é estado do
// cliente, persistido em localStorage, semeado com um backlog de exemplo.
//
// Regra de honestidade (ver docs/ui-rewrite/PLAN.md):
//   • O TESTE AUTOMÁTICO é REAL: ao entrar na coluna «Teste automático» dispara
//     `run_all_tests(root)` (crate tutor-eval::testnav::run_suite). Se falhar, o
//     cartão volta a «Em desenvolvimento». Sem pasta aberta → estado honesto.
//   • GERAR o backlog a partir do desenho do Studio é FASE 8 (precisa de
//     arch_scaffold/orquestração) — o botão aparece VISÍVEL mas DESACTIVADO.
//   • «Executar sprint» move e TESTA as issues existentes, mas NÃO implementa
//     código (também orquestração de Fase 8); o botão é honesto sobre isso.
// Nada é simulado em silêncio: o veredicto vem sempre do runner, nunca de um modelo.

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { VIEW, openTab, toast, note, addCommand, setPanelTab, type Tab } from "./index";
import { workspaceRoot } from "./workspace";

// ───────────────────────────── formas do backend (tutor-eval::testnav) ─────────
// Espelha EXACTAMENTE o struct TestRun de crates/tutor-eval/src/testnav.rs
// (serde camelCase). `run_all_tests(root)` devolve um TestRun para a suite toda.
interface TestRun { ran: boolean; passed: boolean; output: string }

// ───────────────────────────── modelo do cliente ──────────────────────────────
type Stage = "backlog" | "todo" | "dev" | "test" | "func" | "done";
type IssueType = "feature" | "fix";
interface Issue {
  id: string;            // DX-NN
  type: IssueType;
  title: string;
  pts: number;
  stage: Stage;
  sprint: number;        // 0 ou 1
  agent: string;         // chave em AGENTS (só apresentação)
  model: string | null;  // chave em PROV (só apresentação)
  branch: string | null;
  note: string;
  res: TestRun | null;   // último resultado REAL de run_all_tests para esta issue
}
interface Board { issues: Issue[]; seq: number; view: number } // view: -1=tudo, 0/1=sprint

// Ordem e rótulos das colunas (os rótulos vêm do i18n em render).
const STAGE_KEYS: Stage[] = ["backlog", "todo", "dev", "test", "func", "done"];

// Catálogo de apresentação (cor/nome do assistente e nome do provedor). Só visual:
// a atribuição real de trabalho a assistentes é orquestração de Fase 8.
const AGENTS: Record<string, { n: string; col: string }> = {
  lead: { n: "Co-Dev", col: "#e06c3b" },
  be: { n: "Backend", col: "#dea584" },
  db: { n: "Base de dados", col: "#5cc9a7" },
  fe: { n: "Frontend", col: "#6ea8ff" },
  qa: { n: "QA", col: "#e0b64a" },
  ops: { n: "Plataforma", col: "#c678dd" },
};
const PROV: Record<string, string> = { claude: "Claude", gemini: "Gemini", codex: "Codex", ollama: "Ollama" };

// ───────────────────────────── estado do módulo ──────────────────────────────
const LS_KEY = "dxtutor.board";

function seed(): Issue[] {
  const mk = (id: string, type: IssueType, title: string, pts: number, stage: Stage, sprint: number,
    agent: string, model: string | null, branch: string | null, res: TestRun | null): Issue =>
    ({ id, type, title, pts, stage, sprint, agent, model, branch, note: "", res });
  return [
    mk("DX-1", "feature", "Gateway: encaminhamento e TLS", 3, "done", 0, "ops", "claude", "feature/gateway", { ran: true, passed: true, output: "" }),
    mk("DX-2", "feature", "Orders API: esqueleto Axum", 5, "func", 0, "be", "claude", "feature/orders-api", { ran: true, passed: true, output: "" }),
    mk("DX-3", "feature", "Orders DB: esquema e migração", 3, "dev", 0, "db", "gemini", "feature/orders-db", null),
    mk("DX-4", "fix", "Session Cache: expiração de chaves", 2, "todo", 0, "be", "codex", null, null),
    mk("DX-5", "feature", "Billing Worker: consumo de eventos", 5, "backlog", 1, "be", "claude", null, null),
    mk("DX-6", "feature", "Invoices Bucket: carregamento S3", 3, "backlog", 1, "ops", "ollama", null, null),
    mk("DX-7", "feature", "Web: página de pedidos", 3, "dev", 1, "fe", "gemini", "feature/web-orders", null),
  ];
}

function nextSeq(issues: Issue[]): number {
  let m = 0;
  for (const it of issues) { const n = Number(it.id.replace(/^DX-/, "")); if (Number.isFinite(n) && n > m) m = n; }
  return m + 1;
}

function load(): Board {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const d = JSON.parse(raw) as Partial<Board>;
      if (d && Array.isArray(d.issues)) {
        const issues = d.issues as Issue[];
        const view = typeof d.view === "number" ? d.view : -1;
        const seq = typeof d.seq === "number" && d.seq >= nextSeq(issues) ? d.seq : nextSeq(issues);
        return { issues, seq, view };
      }
    }
  } catch { /* localStorage indisponível ou corrompido — cai no seed */ }
  const issues = seed();
  return { issues, seq: nextSeq(issues), view: -1 };
}

const state: Board = load();
let boardHost: HTMLElement | null = null;

function save(): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* ignora */ }
}

// ───────────────────────────── ajudantes ──────────────────────────────
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const byId = (id: string): Issue | undefined => state.issues.find((i) => i.id === id);
const agentOf = (k: string): { n: string; col: string } => AGENTS[k] ?? { n: k, col: "var(--fg-muted)" };
const stageLabel = (k: Stage): string => t("board." + k);

// Escreve o resultado REAL no painel Output (como faz shell/tests.ts).
function writeOutput(title: string, run: TestRun): void {
  const out = document.getElementById("pc-output");
  if (out) {
    const cls = !run.ran ? "warn" : run.passed ? "ok" : "er";
    const verdict = run.ran ? (run.passed ? t("board.testsPass") : t("board.testsFail")) : t("board.testsDidNotRun");
    out.innerHTML = `<div class="${cls}" style="margin-bottom:6px">${esc(title)} — ${esc(verdict)}</div><pre style="white-space:pre-wrap;margin:0">${esc(run.output || "")}</pre>`;
  }
  setPanelTab("output");
}

// ───────────────────────────── teste automático REAL ──────────────────────────
// Aplica o veredicto de um TestRun a uma issue: passa → «Validação funcional»,
// falha (ou não correu) → volta a «Em desenvolvimento». Não repinta nem notifica.
function applyVerdict(it: Issue, run: TestRun): void {
  it.res = run;
  const ok = run.ran && run.passed;
  it.note = ok ? "" : run.ran ? t("board.testFailed") : t("board.testDidNotRunNote");
  it.stage = ok ? "func" : "dev";
}

// Entrada na coluna «Teste automático»: corre a suite REAL para esta issue.
async function moveToTest(it: Issue): Promise<void> {
  const root = workspaceRoot();
  it.stage = "test"; it.res = null; it.note = t("board.running"); save(); render();
  if (!root) {
    it.res = { ran: false, passed: false, output: "" };
    it.note = t("board.noFolderTest"); it.stage = "dev";
    save(); render(); toast(t("board.noFolder"));
    return;
  }
  try {
    const run = await invoke<TestRun>("run_all_tests", { root });
    applyVerdict(it, run); save(); render();
    writeOutput(it.id, run);
    toast(run.ran && run.passed ? t("board.testPassedToast", { id: it.id }) : t("board.testFailedToast", { id: it.id }));
  } catch (e) {
    it.res = { ran: false, passed: false, output: String(e) };
    it.note = t("board.testError"); it.stage = "dev";
    save(); render(); toast(String(e));
  }
}

// ───────────────────────────── acções do modelo ──────────────────────────────
function dropIssue(id: string, st: Stage): void {
  const it = byId(id); if (!it || it.stage === st) return;
  if (st === "done") {
    if (it.stage !== "func") { toast(t("board.onlyAfterFunc")); return; }
    approveIssue(id); return;
  }
  if (st === "test" || st === "func") {
    // «Validação funcional» só se chega depois de os testes passarem: corre-os.
    if (st === "func") toast(t("board.testsFirst"));
    void moveToTest(it); return;
  }
  it.stage = st; save(); render();
}

// Validação funcional humana: aprovar (→ Concluído). O merge do ramo em develop é
// orquestração de Fase 8 — aqui só se marca a issue como validada.
function approveIssue(id: string): void {
  const it = byId(id); if (!it || it.stage !== "func") return;
  it.note = ""; it.stage = "done"; save(); render();
  toast(t("board.validated", { id: it.id }));
}

// Validação funcional humana: rejeitar (→ volta a desenvolvimento, com nota).
function rejectIssue(id: string): void {
  const it = byId(id); if (!it) return;
  const why = window.prompt(t("board.rejectPrompt"), "");
  if (why === null) return; // cancelado
  it.note = t("board.rejectedNote") + (why.trim() ? ": " + why.trim() : "");
  it.res = null; it.stage = "dev"; save(); render();
}

function newIssue(): void {
  const q = (window.prompt(t("board.newPrompt"), "") || "").trim();
  if (!q) return;
  const fx = /^fix:/i.test(q);
  const id = "DX-" + (state.seq++);
  state.issues.push({
    id, type: fx ? "fix" : "feature", title: q.replace(/^fix:\s*/i, ""),
    pts: 2, stage: "todo", sprint: state.view < 0 ? 0 : state.view,
    agent: "lead", model: null, branch: null, note: "", res: null,
  });
  save(); render();
}

// «Executar sprint»: move backlog→todo e corre a suite REAL para as issues do
// sprint, aplicando o veredicto a cada uma. NÃO implementa código (Fase 8).
async function runSprint(s: number): Promise<void> {
  toast(t("board.sprintInfo")); // honesto: move e testa, não implementa
  for (const it of state.issues) if (it.sprint === s && it.stage === "backlog") it.stage = "todo";
  save(); render();
  const pending = state.issues.filter((i) => i.sprint === s && (i.stage === "todo" || i.stage === "dev"));
  if (!pending.length) { toast(t("board.sprintEmpty", { s: s + 1 })); return; }
  const root = workspaceRoot();
  if (!root) { toast(t("board.noFolder")); return; }
  for (const it of pending) { it.stage = "test"; it.res = null; it.note = t("board.running"); }
  save(); render();
  let run: TestRun;
  try { run = await invoke<TestRun>("run_all_tests", { root }); }
  catch (e) {
    for (const it of pending) { it.res = { ran: false, passed: false, output: String(e) }; it.note = t("board.testError"); it.stage = "dev"; }
    save(); render(); toast(String(e)); return;
  }
  for (const it of pending) applyVerdict(it, run);
  save(); render();
  writeOutput(t("board.sprintOut", { s: s + 1 }), run);
  const f = state.issues.filter((i) => i.sprint === s && i.stage === "func").length;
  note(t("board.sprintDone", { s: s + 1, f }));
}

// ───────────────────────────── render ──────────────────────────────
function cardHtml(it: Issue): string {
  const a = agentOf(it.agent);
  const tr = it.res
    ? `<span class="${it.res.ran && it.res.passed ? "okc" : "bad"}">${it.res.ran && it.res.passed ? "✓ " + esc(t("board.testsPass")) : it.res.ran ? "✖ " + esc(t("board.testsFail")) : "• " + esc(t("board.testsDidNotRun"))}</span>`
    : "";
  const notes = tr || it.note
    ? `<div class="kc-n">${tr}${it.note ? `<span>${esc(it.note)}</span>` : ""}</div>`
    : "";
  const branch = it.branch && it.stage !== "done" ? `<div class="kc-b">⎇ ${esc(it.branch)}</div>` : "";
  const nyi = esc(t("board.nyi"));
  let btns = "";
  if (it.stage === "func") {
    btns = `<div class="kc-a"><button class="mini pri" data-approve="${it.id}">${esc(t("board.validate"))}</button><button class="mini" data-reject="${it.id}">${esc(t("board.reject"))}</button></div>`;
  } else if (it.stage === "backlog" || it.stage === "todo") {
    btns = `<button class="mini" disabled title="${nyi}" style="opacity:.5;cursor:not-allowed">▶ ${esc(t("board.delegateTo", { agent: a.n }))}</button>`;
  } else if (it.stage === "dev") {
    btns = `<button class="mini" disabled title="${nyi}" style="opacity:.5;cursor:not-allowed">▶ ${esc(t("board.resume"))}</button>`;
  }
  return `<div class="kc" draggable="true" data-id="${it.id}">`
    + `<div class="kc-h"><span class="kc-id">${esc(it.id)}</span><span class="tag ${it.type === "fix" ? "bad" : ""}">${esc(it.type)}</span><span class="kc-p">${it.pts}</span></div>`
    + `<div class="kc-t">${esc(it.title)}</div>`
    + `<div class="kc-m"><span class="av" style="background:${a.col}">${esc(a.n.charAt(0))}</span>${esc(a.n)}${it.model ? " · " + esc(PROV[it.model] ?? it.model) : ""}<span class="tag" style="margin-left:auto">S${it.sprint + 1}</span></div>`
    + branch + notes + btns + `</div>`;
}

function render(): void {
  const host = boardHost; if (!host) return;
  const v = state.view;
  const list = state.issues.filter((i) => v < 0 || i.sprint === v);
  const pts = list.reduce((a, i) => a + i.pts, 0);
  const done = list.filter((i) => i.stage === "done").reduce((a, i) => a + i.pts, 0);
  const nyi = esc(t("board.nyi"));

  const filters = [-1, 0, 1].map((s) =>
    `<button class="mini${v === s ? " pri" : ""}" data-view="${s}">${esc(s < 0 ? t("board.all") : t("board.sprint", { n: s + 1 }))}</button>`).join("");

  const bar = `<div class="kb-bar"><b style="font-size:15px">${esc(t("board.title"))}</b>${filters}`
    + `<span class="kb-prog"><i style="width:${pts ? (done / pts) * 100 : 0}%"></i></span>`
    + `<span style="color:var(--fg-muted);font-size:11.5px">${done}/${pts} pts</span>`
    + `<span class="sp"></span>`
    + `<button class="mini" id="kb-new">${esc(t("board.newIssue"))}</button>`
    + `<button class="mini" id="kb-studio">${esc(t("board.studio"))}</button>`
    + `<button class="mini" id="kb-gen" disabled title="${nyi}" style="opacity:.5;cursor:not-allowed">${esc(t("board.genFromStudio"))}</button>`
    + `<button class="mini pri" id="kb-run">${esc(t("board.runSprint"))}</button></div>`;

  let body: string;
  if (!state.issues.length) {
    body = `<div class="empty" style="height:60%"><div><b style="color:var(--fg-dim);font-size:14px">${esc(t("board.emptyTitle"))}</b><br>${esc(t("board.empty"))}</div></div>`;
  } else {
    body = `<div class="kb-cols">${STAGE_KEYS.map((k) => {
      const xs = list.filter((i) => i.stage === k);
      const desc = k === "test" ? `<div class="kcol-d">${esc(t("board.testDesc"))}</div>`
        : k === "func" ? `<div class="kcol-d">${esc(t("board.funcDesc"))}</div>` : "";
      return `<div class="kcol" data-stage="${k}"><div class="kcol-h">${esc(stageLabel(k))}<span class="cnt">${xs.length}</span></div>${desc}${xs.map(cardHtml).join("")}</div>`;
    }).join("")}</div>`;
  }

  host.innerHTML = `<div class="kb">${bar}${body}</div>`;
  wire(host);
}

function wire(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>("[data-view]").forEach((b) => (b.onclick = () => { state.view = Number(b.dataset.view); save(); render(); }));
  const nw = host.querySelector<HTMLElement>("#kb-new"); if (nw) nw.onclick = () => newIssue();
  const st = host.querySelector<HTMLElement>("#kb-studio"); if (st) st.onclick = () => openTab({ id: "studio", title: t("board.studio"), kind: "studio" });
  const run = host.querySelector<HTMLElement>("#kb-run"); if (run) run.onclick = () => {
    const s = state.view < 0
      ? (state.issues.some((i) => i.sprint === 0 && (i.stage === "todo" || i.stage === "backlog")) ? 0 : 1)
      : state.view;
    void runSprint(s);
  };
  // Arrastar-largar: cartões arrastáveis, colunas como alvos.
  host.querySelectorAll<HTMLElement>(".kc").forEach((c) => {
    c.addEventListener("dragstart", (e) => { (e as DragEvent).dataTransfer?.setData("text/plain", c.dataset.id || ""); });
  });
  host.querySelectorAll<HTMLElement>(".kcol").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", (e) => {
      e.preventDefault(); col.classList.remove("over");
      const id = (e as DragEvent).dataTransfer?.getData("text/plain");
      if (id) dropIssue(id, col.dataset.stage as Stage);
    });
  });
  host.querySelectorAll<HTMLElement>("[data-approve]").forEach((b) => (b.onclick = () => approveIssue(b.dataset.approve || "")));
  host.querySelectorAll<HTMLElement>("[data-reject]").forEach((b) => (b.onclick = () => rejectIssue(b.dataset.reject || "")));
}

// ───────────────────────────── vista ──────────────────────────────
const boardView = (_tab: Tab, host: HTMLElement): void => {
  boardHost = host;
  render();
};

// ───────────────────────────── arranque ──────────────────────────────
export function initBoard(): void {
  registerStrings(BOARD_STRINGS);
  VIEW.board = boardView;
  addCommand({ id: "board:open", label: () => t("board.cmdOpen"), run: () => openTab({ id: "board", title: t("board.title"), kind: "board" }) });
}

const BOARD_STRINGS = {
  en: {
    "board.title": "Board",
    "board.cmdOpen": "Board (kanban)",
    // colunas
    "board.backlog": "Backlog", "board.todo": "To do", "board.dev": "In progress",
    "board.test": "Automatic test", "board.func": "Functional validation", "board.done": "Done",
    "board.testDesc": "Entering here runs the tests automatically. Failure → back to development.",
    "board.funcDesc": "Only what passed the tests reaches here. The validation is yours.",
    // barra
    "board.all": "All", "board.sprint": "Sprint {n}",
    "board.newIssue": "+ Issue", "board.studio": "Studio",
    "board.genFromStudio": "Generate from Studio →", "board.runSprint": "▶ Run sprint",
    // cartão
    "board.validate": "✓ Validate", "board.reject": "✗ Reject",
    "board.delegateTo": "Delegate to {agent}", "board.resume": "Resume",
    "board.testsPass": "tests pass", "board.testsFail": "tests fail", "board.testsDidNotRun": "tests did not run",
    // mensagens
    "board.running": "running tests…",
    "board.noFolder": "Open a folder to run the tests.",
    "board.noFolderTest": "no folder open — tests did not run",
    "board.testError": "could not run the tests",
    "board.testFailed": "failed automatic test → back to development",
    "board.testDidNotRunNote": "the tests did not run → back to development",
    "board.testPassedToast": "{id}: tests passed → functional validation",
    "board.testFailedToast": "{id}: tests failed → back to development",
    "board.onlyAfterFunc": "Only reaches Done after functional validation.",
    "board.testsFirst": "Automatic tests run before functional validation.",
    "board.validated": "{id} validated.",
    "board.rejectPrompt": "Why reject? (kept as a note on the issue)",
    "board.rejectedNote": "rejected in functional validation",
    "board.newPrompt": "Issue title (prefix \"fix:\" for fixes)",
    "board.sprintInfo": "Running the sprint moves and tests the issues; it does not implement code (Phase 8).",
    "board.sprintEmpty": "No pending issues in Sprint {s}.",
    "board.sprintDone": "Sprint {s}: {f} issues awaiting functional validation.",
    "board.sprintOut": "Sprint {s} — automatic tests",
    "board.nyi": "not implemented yet (Phase 8)",
    "board.emptyTitle": "Empty backlog",
    "board.empty": "Generating the backlog from the Studio design is Phase 8. Create issues by hand with + Issue.",
  },
  ptAO: {
    "board.title": "Quadro",
    "board.cmdOpen": "Quadro (kanban)",
    // colunas
    "board.backlog": "Backlog", "board.todo": "A fazer", "board.dev": "Em desenvolvimento",
    "board.test": "Teste automático", "board.func": "Validação funcional", "board.done": "Concluído",
    "board.testDesc": "Ao entrar aqui os testes correm sozinhos. Falha → volta a desenvolvimento.",
    "board.funcDesc": "Só chega aqui o que passou nos testes. A validação é tua.",
    // barra
    "board.all": "Tudo", "board.sprint": "Sprint {n}",
    "board.newIssue": "+ Issue", "board.studio": "Studio",
    "board.genFromStudio": "Gerar a partir do Studio →", "board.runSprint": "▶ Executar sprint",
    // cartão
    "board.validate": "✓ Validar", "board.reject": "✗ Rejeitar",
    "board.delegateTo": "Delegar a {agent}", "board.resume": "Retomar",
    "board.testsPass": "testes passam", "board.testsFail": "testes falham", "board.testsDidNotRun": "testes não correram",
    // mensagens
    "board.running": "a correr os testes…",
    "board.noFolder": "Abre uma pasta para correr os testes.",
    "board.noFolderTest": "sem pasta aberta — os testes não correram",
    "board.testError": "não foi possível correr os testes",
    "board.testFailed": "reprovado no teste automático → volta a desenvolvimento",
    "board.testDidNotRunNote": "os testes não correram → volta a desenvolvimento",
    "board.testPassedToast": "{id}: testes passaram → validação funcional",
    "board.testFailedToast": "{id}: testes falharam → volta a desenvolvimento",
    "board.onlyAfterFunc": "Só passa a Concluído depois da validação funcional.",
    "board.testsFirst": "Antes da validação funcional correm os testes automáticos.",
    "board.validated": "{id} validada.",
    "board.rejectPrompt": "Porque rejeitas? (fica como nota na issue)",
    "board.rejectedNote": "rejeitada na validação funcional",
    "board.newPrompt": "Título da issue (prefixo \"fix:\" para correcções)",
    "board.sprintInfo": "Executar o sprint move e testa as issues; não implementa código (Fase 8).",
    "board.sprintEmpty": "Não há issues por fazer no Sprint {s}.",
    "board.sprintDone": "Sprint {s}: {f} issues à espera de validação funcional.",
    "board.sprintOut": "Sprint {s} — testes automáticos",
    "board.nyi": "ainda não implementado (Fase 8)",
    "board.emptyTitle": "Backlog vazio",
    "board.empty": "Gerar o backlog a partir do desenho do Studio é a Fase 8. Cria issues à mão com + Issue.",
  },
};
