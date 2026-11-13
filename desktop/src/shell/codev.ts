// shell/codev.ts — Fase 2→4 (base): liga o chat do dock Co-Dev ao backend REAL.
//
// A casca (index.ts) ligou os controlos do dock a um aviso «not implemented».
// Aqui reassumimos #ag-send e o Enter de #ag-input e fazemos o chat de verdade:
// assistant_chat_stream + streaming pelos eventos Tauri llm://token / llm://done /
// llm://error. O modelo activo vem de list_providers()/assistant_models(). Sem
// provedor, estado honesto — nunca se inventa uma resposta.
//
// A orquestração completa (matriz de modos Manual/Assistido/Auto, conselho de
// modelos, auto-avaliação/juiz e checkpoints) é Fase 4 e NÃO está aqui — ver
// PENDING.md. O #modebar já mostra os modos (só visual) e não é tocado.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t, registerStrings } from "../i18n";
import { activeFile, workspaceRoot } from "./workspace";
import { toast, setPanelTab, setProvidersPanel, currentMode } from "./index";
import { offerAnchoredPatch, setPatchLog } from "./edit";

/** Bloco ```dxpatch — removido da bolha para nunca despejar um patch como texto cru (é
 *  aplicado como edição revista no diff). */
const DXPATCH_RE = /```dxpatch\s*\n[\s\S]*?```/;
/** Bloco ```dxplan — a lista de passos de uma tarefa multi-passo; vive no cartão de plano, não
 *  como texto cru na bolha. */
const DXPLAN_RE = /```dxplan\s*\n[\s\S]*?```/;

/** Espelha `tutor_llm::chat::ProvidersConfig` (crates/tutor-llm/src/chat.rs). */
interface ProvidersConfig {
  provider: string;
  anthropicKey: string;
  anthropicWorkspaceId: string;
  openaiKey: string;
  geminiKey: string;
  ollamaHost: string;
  ollamaModel: string;
  assistantModel: string;
}

/** Um turno de conversa — espelha `tutor_llm::chat::ChatMsg { role, content }`. */
interface ChatMsg { role: string; content: string }

/** Subconjunto de `ProviderInfo` que o dock precisa (ver crates/tutor-llm). */
interface ProviderInfo { id: string; name: string; available: boolean; models: string[] }

/** Formas dos eventos emitidos por `assistant_chat_stream` (ver main.rs). */
interface TokenEvt { requestId: string; delta: string }
interface DoneEvt { requestId: string; model: string }
interface ErrorEvt { requestId: string; error: string }

// ── Estado do módulo ──────────────────────────────────────────────────────────────
const history: ChatMsg[] = [];
let activeProvider: string | null = null; // id do provedor escolhido (ou null = nenhum)
let activeModel: string | null = null; // modelo a usar (pode ser null → backend decide)
let ctxOn = false; // incluir o ficheiro activo como contexto?
let busy = false; // há um stream em curso?
let seq = 0; // gera ids de pedido únicos

const hhmm = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

const $ = <T extends HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// ── Render das bolhas ───────────────────────────────────────────────────────────
/** Remove a intro (se existir) antes de acrescentar a primeira bolha. */
function dropIntro(): void { $("#ag-intro")?.remove(); }

/** Acrescenta uma bolha de utilizador (texto escapado via textContent). */
function pushUserBubble(text: string): void {
  const msgs = $("#ag-msgs"); if (!msgs) return;
  dropIntro();
  const el = document.createElement("div");
  el.className = "m user";
  el.innerHTML = `<div class="bub"><div class="bh"><span class="br2">${t("codev.you")}</span><span class="bt">${hhmm()}</span></div><div class="bd"></div></div>`;
  const bd = el.querySelector<HTMLElement>(".bd");
  if (bd) bd.textContent = text; // textContent evita injecção de HTML
  msgs.appendChild(el);
  scrollMsgs();
}

/** Cria uma bolha vazia do assistente e devolve o elemento `.bd` para o streaming. */
function newAiBubble(): HTMLElement | null {
  const msgs = $("#ag-msgs"); if (!msgs) return null;
  dropIntro();
  const el = document.createElement("div");
  el.className = "m ai";
  el.innerHTML = `<div class="bub"><div class="bh"><span class="br2">${t("codev.assistant")}</span><span class="bt">${hhmm()}</span></div><div class="bd"></div></div>`;
  const bd = el.querySelector<HTMLElement>(".bd");
  if (bd) bd.textContent = t("codev.thinking"); // substituído pelo primeiro token
  msgs.appendChild(el);
  scrollMsgs();
  return bd;
}

function scrollMsgs(): void {
  const m = $("#ag-msgs"); if (!m) return;
  m.scrollTop = $("#ag-intro") ? 0 : m.scrollHeight;
}

/** Repõe a intro curta (nova conversa / arranque). */
function renderIntro(): void {
  const msgs = $("#ag-msgs"); if (!msgs) return;
  msgs.innerHTML = `<div class="intro" id="ag-intro"><div class="i-t">Co-Dev</div><div class="i-s"></div></div>`;
  const s = msgs.querySelector<HTMLElement>(".i-s");
  if (s) s.textContent = t("codev.intro");
}

// ── Modelo / provedor ──────────────────────────────────────────────────────────
/** Lê os provedores reais e mostra o modelo activo em #ag-model-l (ou estado honesto). */
async function refreshModelLabel(): Promise<void> {
  let providers: ProviderInfo[] = [];
  try { providers = await invoke<ProviderInfo[]>("list_providers"); }
  catch { providers = []; }
  const avail = providers.filter((p) => p.available);
  if (!avail.length) {
    activeProvider = null;
    activeModel = null;
    applyModelLabel(providers);
    return;
  }
  // Restaura a escolha persistida se ainda estiver disponível; senão o 1.º disponível.
  let savedP: string | null = null, savedM: string | null = null;
  try { savedP = localStorage.getItem("dxtutor.codev.provider"); savedM = localStorage.getItem("dxtutor.codev.model"); } catch { /* */ }
  const ready = (savedP && avail.find((p) => p.id === savedP)) || avail[0];
  activeProvider = ready.id;
  // Ollama traz os modelos locais em `models`; para os restantes o backend escolhe.
  if (ready.id === "ollama" && ready.models.length === 0) {
    try { ready.models = await invoke<string[]>("assistant_models"); } catch { /* backend ausente */ }
  }
  activeModel = savedP === ready.id && savedM && ready.models.includes(savedM)
    ? savedM
    : (ready.models.length ? ready.models[0] : null);
  applyModelLabel(providers);
}

// ── Contexto (ficheiro activo) ──────────────────────────────────────────────────
/** Actualiza o visual do pill #pill-ctx conforme o estado e o ficheiro activo. */
function renderCtxPill(): void {
  const el = $("#pill-ctx"); if (!el) return;
  const file = activeFile();
  const base = file ? (file.split("/").pop() || file) : null;
  el.textContent = ctxOn && base ? `@ ${base}` : "@ " + t("codev.ctxNone");
  el.classList.toggle("on", ctxOn && !!base);
}

/** Alterna a inclusão do ficheiro activo como contexto. */
function toggleCtx(): void {
  ctxOn = !ctxOn;
  renderCtxPill();
  toast(ctxOn ? t("codev.ctxOn") : t("codev.ctxOff"));
}

/** Prefixa a mensagem com um excerto do ficheiro activo, quando o contexto está ligado. */
async function withContext(text: string): Promise<string> {
  if (!ctxOn) return text;
  const file = activeFile();
  if (!file) return text; // contexto ligado mas sem ficheiro: segue sem prefixo
  let content: string;
  try { content = await invoke<string>("read_text_file", { path: file }); }
  catch { return text; } // sem acesso ao ficheiro: honesto, segue sem contexto
  const MAX = 6000; // excerto defensivo para não estourar o contexto do modelo
  const excerpt = content.length > MAX ? content.slice(0, MAX) + "\n…" : content;
  return `${t("codev.ctxHeader", { file })}\n\n\`\`\`\n${excerpt}\n\`\`\`\n\n${text}`;
}

// ── System prompt (modo projecto: assistente do workspace, edições ancoradas) ─────
//
// O Co-Dev da IDE é assistência em MODO PROJECTO — passamos `mode:"project"` ao backend
// (o estudo tutor-constrangido vive no Learning Track, não aqui). Em modo projecto o
// backend não injecta directiva de tutor; é o cliente que fundamenta o assistente no
// projecto aberto e lhe ensina a gramática `dxpatch` (edições ancoradas por conteúdo). Sem
// pasta aberta devolvemos null → chat genérico honesto, sem oferecer edições.
const PROJECT_MODE = "project";

function dxpatchSystem(root: string): string {
  return (
    "You are the dxtutor workspace assistant, working INSIDE the user's open project — not a " +
    "generic chatbot. The developer decides what to build; you help. Ground every answer in " +
    `THIS real project by its actual paths. Project root: ${root}.\n\n` +
    "To CHANGE existing code (fix a bug, tweak a line, edit a function — ANY edit to a file " +
    "that already has content), reply with a SHORT plan (1–3 lines) then EXACTLY ONE fenced " +
    "block:\n" +
    "```dxpatch\n" +
    '{"file":"<path relative to root>","edits":[{"old":"<exact snippet copied VERBATIM from the file>","new":"<its replacement>"}]}\n' +
    "```\n" +
    "Rules that make this safe:\n" +
    "  – `old` must be copied CHARACTER-FOR-CHARACTER from the file content you were shown " +
    "(indentation and whitespace included). Do NOT retype from memory and do NOT use line numbers.\n" +
    "  – Include ENOUGH surrounding context in `old` that it appears EXACTLY ONCE in the file. " +
    "A non-unique or not-found `old` is REFUSED and nothing is applied — err on more context.\n" +
    "  – Keep each `new` MINIMAL: change only what must change. Use several {old,new} hunks for " +
    'several changes. To delete code, set `new` to "". NEVER rewrite the whole file to change part of it.\n' +
    "  – For several files in one change, use {\"files\":[{\"file\":\"…\",\"edits\":[…]}, …]} — resolved " +
    "atomically. Only edit files whose content you were shown; if you have not seen a file, ask to open it.\n\n" +
    "For a MULTI-STEP task (several edits or files), FIRST emit a plan so the developer sees the " +
    "whole execution, then carry it out step by step when asked to continue:\n" +
    "```dxplan\n" +
    '{"title":"<short goal>","steps":["<step 1>","<step 2>","…"]}\n' +
    "```\n" +
    "Emit the plan as EXACTLY ONE such block. Each step should be one concrete, independently " +
    "applicable change. When asked to continue a step, perform ONLY that step (with a dxpatch when " +
    "it changes code). A single-step change needs no plan — just emit the dxpatch directly."
  );
}

/** Constrói a mensagem `system` do modo projecto (fundamentação + gramática dxpatch +
 *  conteúdo do ficheiro activo para ancorar). Devolve null sem pasta aberta. */
async function buildSystemPrompt(): Promise<ChatMsg | null> {
  const root = workspaceRoot();
  if (!root) return null;
  let activeBlock = "";
  const file = activeFile();
  if (file) {
    try {
      const content = await invoke<string>("read_text_file", { path: file });
      const MAX = 12000;
      const body = content.length > MAX ? content.slice(0, MAX) + "\n…(truncado)" : content;
      const rel = file.startsWith(root) ? file.slice(root.replace(/\/$/, "").length + 1) : file;
      activeBlock = `\n\nActive file (${rel}) — you HAVE its content; edit it directly with dxpatch, do not ask to re-open it:\n\`\`\`\n${body}\n\`\`\``;
    } catch { /* sem acesso: segue sem o bloco */ }
  }
  return { role: "system", content: dxpatchSystem(root) + activeBlock };
}

// ── Envio + streaming ───────────────────────────────────────────────────────────
/** Envio a partir da caixa de composição (texto do utilizador). */
async function send(): Promise<void> {
  const input = $<HTMLTextAreaElement>("#ag-input"); if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  if (busy) { toast(t("codev.busy")); return; }
  if (!activeProvider) { toast(t("codev.noProvider")); return; }
  input.value = "";
  await runTurn(raw, await withContext(raw), false);
}

/** Envio PROGRAMÁTICO (conduz um passo do plano). Mostra a instrução como bolha de utilizador
 *  (transparência: vê-se o que o orquestrador pediu) e marca o turno como "a conduzir passo". */
async function sendText(text: string): Promise<void> {
  if (busy || !activeProvider) return;
  await runTurn(text, text, true);
}

/** Núcleo partilhado de um turno: pinta a bolha do utilizador, acumula o stream, e no fim
 *  despacha dxpatch (edição) e dxplan (orquestração). `driving` = este turno executa um passo
 *  do plano (ao terminar, avança o plano). */
async function runTurn(displayText: string, modelContent: string, driving: boolean): Promise<void> {
  pushUserBubble(displayText);
  logOutput("sent", oneLine(displayText));
  history.push({ role: "user", content: modelContent });

  // Modo projecto: fundamenta o assistente no projecto e ensina-lhe dxpatch/dxplan. O system é
  // reconstruído a cada turno (como no assistant.ts) e NÃO entra no histórico.
  const sys = await buildSystemPrompt();
  const outgoing = sys ? [sys, ...history] : history;

  const bd = newAiBubble();
  const requestId = `codev-${Date.now()}-${++seq}`;
  let acc = "";
  let first = true;
  busy = true;

  const unlisteners: Array<() => void> = [];
  const cleanup = (): void => { for (const u of unlisteners) u(); busy = false; };

  const unToken = await listen<TokenEvt>("llm://token", (e) => {
    if (e.payload.requestId !== requestId) return;
    if (first) { first = false; if (bd) bd.textContent = ""; }
    acc += e.payload.delta;
    if (bd) bd.textContent = acc; // textContent: sem risco de injecção
    scrollMsgs();
  });
  unlisteners.push(unToken);

  const unDone = await listen<DoneEvt>("llm://done", (e) => {
    if (e.payload.requestId !== requestId) return;
    if (bd && first) bd.textContent = ""; // resposta vazia honesta
    history.push({ role: "assistant", content: acc });
    logOutput("recv", acc ? oneLine(acc) : t("codev.out.empty"));
    cleanup();
    scrollMsgs();
    void onTurnDone(acc, bd, driving);
  });
  unlisteners.push(unDone);

  const unError = await listen<ErrorEvt>("llm://error", (e) => {
    if (e.payload.requestId !== requestId) return;
    if (bd) bd.textContent = t("codev.error", { error: e.payload.error });
    logOutput("error", e.payload.error);
    cleanup();
    scrollMsgs();
  });
  unlisteners.push(unError);

  try {
    await invoke("assistant_chat_stream", {
      messages: outgoing,
      provider: activeProvider,
      model: activeModel,
      requestId,
      mode: PROJECT_MODE,
    });
  } catch (err) {
    if (bd) bd.textContent = t("codev.error", { error: String(err) });
    cleanup();
  }
}

/** Ao terminar um turno: aplica dxpatch (edição ancorada), trata o dxplan (novo plano) e, se
 *  o turno conduzia um passo, avança o plano (encadeando em modo auto / verificando no fim). */
async function onTurnDone(acc: string, bd: HTMLElement | null, driving: boolean): Promise<void> {
  await handlePatchBlock(acc, bd);
  // Um turno que CONDUZIA um passo: o passo terminou → avança (em auto encadeia; no fim verifica).
  if (driving && plan && !plan.done) { advancePlan(); return; }
  // Caso contrário, a resposta pode TRAZER um novo plano multi-passo.
  const dir = parsePlanDirective(acc);
  if (dir && (!plan || plan.done)) {
    startPlan(dir.title, dir.steps);
    // Retira o bloco cru da bolha (o plano vive no cartão, não como texto).
    if (bd) bd.textContent = acc.replace(DXPLAN_RE, "").trim();
    if (autoMode()) setTimeout(() => void continuePlan(), 400); // auto conduz já o passo 1
  }
}

/** Detecta um `dxpatch` na resposta e, havendo, retira o bloco cru da bolha e delega a
 *  resolução ancorada + revisão em diff ao módulo de edição. O histórico guarda o texto cru
 *  (contexto para o modelo); a bolha mostra a versão sem o bloco + o estado honesto. */
async function handlePatchBlock(acc: string, bd: HTMLElement | null): Promise<void> {
  const out = await offerAnchoredPatch(acc);
  if (out.kind === "none") return;
  const shown = acc.replace(DXPATCH_RE, "").trim();
  let note: string;
  if (out.kind === "refused") { note = `⚠ ${out.reason}`; logOutput("error", out.reason); }
  else if (out.kind === "applied") { note = out.total > 1 ? t("codev.patch.appliedN", { n: out.total }) : t("codev.patch.applied"); logOutput("recv", note); }
  else { note = out.total > 1 ? t("codev.patch.reviewN", { n: out.total }) : t("codev.patch.review"); logOutput("recv", note); }
  if (bd) bd.textContent = shown ? `${shown}\n${note}` : note;
  scrollMsgs();
}

// ── Orquestração: plano → continuar → auto → verificar (PARITY #20) ────────────────
//
// O modelo emite ```dxplan {title, steps[]} para uma tarefa multi-passo. Desenhamos um cartão
// de plano no dock; "Continuar" conduz o passo actual (envia a sua instrução); em modo auto os
// passos encadeiam-se sozinhos (limitado pelo nº de passos, parável). Ao concluir o último
// passo corre os testes do projecto (run_all_tests) — o "verify" de observar→planear→agir→
// verificar — e mostra o veredicto HONESTO (ran/passed + saída). Sem simulação.
interface Plan { title: string; steps: string[]; current: number; done: boolean }
let plan: Plan | null = null;

/** Modo auto = o modebar da casca em "auto" (encadeia os passos sem clique). */
function autoMode(): boolean { return currentMode() === "auto"; }

/** Extrai um ```dxplan ({title, steps[]}) da resposta, se válido (≥1 passo). */
function parsePlanDirective(text: string): { title: string; steps: string[] } | null {
  const m = text.match(/```dxplan\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim()) as { title?: unknown; steps?: unknown };
    if (Array.isArray(obj.steps) && obj.steps.length) {
      return { title: typeof obj.title === "string" ? obj.title : t("codev.plan.untitled"), steps: obj.steps.map(String) };
    }
  } catch { /* malformado → ignorado */ }
  return null;
}

/** Arranca um plano novo e desenha o cartão. */
function startPlan(title: string, steps: string[]): void {
  plan = { title, steps, current: 0, done: false };
  renderPlanCard();
  logOutput("recv", t("codev.plan.started", { title, n: steps.length }));
}

/** Desenha/actualiza o cartão de plano no fim das mensagens (um só, reutilizado). */
function renderPlanCard(): void {
  const msgs = $("#ag-msgs"); if (!msgs || !plan) return;
  dropIntro();
  let card = $("#ag-plan");
  if (!card) { card = document.createElement("div"); card.id = "ag-plan"; card.className = "m ai"; msgs.appendChild(card); }
  card.innerHTML =
    `<div class="bub"><div class="bh"><span class="br2">${esc(t("codev.plan.title"))}</span></div>` +
    `<div class="bd"><div style="font-weight:600;margin-bottom:4px">${esc(plan.title)}</div>` +
    `<div id="ag-plan-steps"></div>` +
    (plan.done ? `<div class="sub" id="ag-plan-verify" style="margin-top:6px"></div>`
      : `<div style="margin-top:8px"><button class="btn" id="ag-plan-next" ${busy ? "disabled" : ""}>${esc(t("codev.plan.continue"))}</button>` +
        `<span class="sub" style="margin-left:8px">${esc(autoMode() ? t("codev.plan.autoOn") : t("codev.plan.manualHint"))}</span></div>`) +
    `</div></div>`;
  // Passos com texto como nó (sem injecção).
  const stepsHost = card.querySelector<HTMLElement>("#ag-plan-steps");
  if (stepsHost) {
    plan.steps.forEach((s, i) => {
      const done = plan!.done || i < plan!.current;
      const running = i === plan!.current && !plan!.done;
      const row = document.createElement("div");
      row.className = "oline";
      row.innerHTML = `<span class="${done ? "ok" : running ? "" : "dim"}">${done ? "✓" : running ? "▶" : "•"}</span> `;
      const span = document.createElement("span");
      if (!done && !running) span.className = "dim";
      span.textContent = s;
      row.appendChild(span);
      stepsHost.appendChild(row);
    });
  }
  const next = card.querySelector<HTMLElement>("#ag-plan-next");
  if (next) next.onclick = () => void continuePlan();
  scrollMsgs();
}

/** Conduz o passo actual: envia a sua instrução ao modelo (programaticamente). */
async function continuePlan(): Promise<void> {
  if (!plan || plan.done || busy) return;
  const step = plan.steps[plan.current];
  const remaining = plan.steps.slice(plan.current).map((s, i) => `${plan!.current + i + 1}. ${s}`).join("\n");
  await sendText(
    `Continue the plan "${plan.title}". Do ONLY this next step now:\n\n➡ ${step}\n\n` +
    `Remaining steps (for context, do not do them yet):\n${remaining}\n\n` +
    "Act through the IDE with a dxpatch when you change code — do not just describe it.",
  );
}

/** O passo actual terminou: marca-o feito e avança. No fim corre a verificação; em auto encadeia. */
function advancePlan(): void {
  if (!plan || plan.done) return;
  plan.current += 1;
  if (plan.current >= plan.steps.length) {
    plan.done = true;
    renderPlanCard();
    void runVerify();
    return;
  }
  renderPlanCard();
  if (autoMode()) setTimeout(() => void continuePlan(), 400);
}

/** Passo de verificação: corre os testes do projecto e mostra o veredicto honesto no cartão. */
async function runVerify(): Promise<void> {
  const root = workspaceRoot();
  const box = $("#ag-plan-verify");
  if (!root) { if (box) box.textContent = t("codev.plan.verifyNoFolder"); return; }
  if (box) box.textContent = t("codev.plan.verifyRunning");
  logOutput("sent", t("codev.plan.verifyRunning"));
  try {
    const run = await invoke<{ ran: boolean; passed: boolean; output: string }>("run_all_tests", { root });
    const verdict = !run.ran ? t("codev.plan.verifyNotRun")
      : run.passed ? t("codev.plan.verifyPass") : t("codev.plan.verifyFail");
    if (box) box.textContent = verdict;
    logOutput(run.ran && run.passed ? "recv" : "error", verdict);
    if (run.output) logOutput(run.passed ? "recv" : "error", oneLine(run.output));
  } catch (e) {
    if (box) box.textContent = t("codev.plan.verifyErr", { e: String(e) });
    logOutput("error", String(e));
  }
}

/** Nova conversa: limpa o histórico e repõe a intro curta. */
function newChat(): void {
  if (busy) { toast(t("codev.busy")); return; }
  history.length = 0;
  renderIntro();
  clearOutput();
}

// ── Output · Co-Dev (registo honesto da actividade do dock) ─────────────────────────
/** Acrescenta uma linha com carimbo de tempo ao painel inferior Output·Co-Dev. */
function logOutput(kind: "sent" | "recv" | "error", msg: string): void {
  const out = $("#pc-output"); if (!out) return;
  const cls = kind === "error" ? "er" : kind === "sent" ? "dim" : "ok";
  const tag = t("codev.out." + kind);
  const line = document.createElement("div");
  line.className = "oline";
  line.innerHTML = `<span class="ts">${hhmm()}</span> <span class="${cls}">${tag}</span> `;
  line.appendChild(document.createTextNode(msg)); // texto como nó: sem injecção
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}
function clearOutput(): void { const out = $("#pc-output"); if (out) out.innerHTML = ""; }
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 160);

// ── Selector de modelo (real: list_providers + modelos de cada provedor) ───────────
let pickerOpen = false;
async function pickModel(anchorSel: string): Promise<void> {
  if (pickerOpen) { closePicker(); return; }
  let providers: ProviderInfo[] = [];
  try { providers = await invoke<ProviderInfo[]>("list_providers"); } catch { providers = []; }
  const avail = providers.filter((p) => p.available);
  if (!avail.length) { toast(t("codev.noProvider")); return; }
  // Expande cada provedor nos seus modelos (Ollama traz locais; outros via assistant_models).
  const items: Array<{ provider: string; model: string | null; label: string }> = [];
  for (const p of avail) {
    let models = p.models;
    if (p.id === "ollama" && models.length === 0) {
      try { models = await invoke<string[]>("assistant_models"); } catch { models = []; }
    }
    if (models.length) for (const m of models) items.push({ provider: p.id, model: m, label: `${p.name} · ${m}` });
    else items.push({ provider: p.id, model: null, label: p.name });
  }
  const anchor = $(anchorSel); if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.className = "menu-pop show"; pop.id = "codev-model-pop";
  pop.style.minWidth = "220px";
  items.forEach((it) => {
    const mi = document.createElement("div");
    mi.className = "mi" + (it.provider === activeProvider && it.model === activeModel ? " has-key" : "");
    mi.innerHTML = `<span>${it.label}</span>` + (it.provider === activeProvider && it.model === activeModel ? '<span class="key">✓</span>' : "");
    mi.onclick = (e) => {
      e.stopPropagation();
      activeProvider = it.provider; activeModel = it.model;
      try { localStorage.setItem("dxtutor.codev.provider", it.provider); localStorage.setItem("dxtutor.codev.model", it.model || ""); } catch { /* */ }
      applyModelLabel(providers);
      closePicker();
    };
    pop.appendChild(mi);
  });
  document.body.appendChild(pop);
  pickerOpen = true;
  let top = r.bottom + 4; const h = pop.offsetHeight;
  if (top + h > innerHeight) top = Math.max(6, r.top - h - 4);
  pop.style.left = Math.max(6, Math.min(innerWidth - pop.offsetWidth - 6, r.left)) + "px";
  pop.style.top = top + "px";
  setTimeout(() => document.addEventListener("click", closePicker, { once: true }), 0);
}
function closePicker(): void { $("#codev-model-pop")?.remove(); pickerOpen = false; }

/** Escreve o rótulo do modelo activo em #ag-model-l e #st-model-l + ponto de vida. */
function applyModelLabel(providers: ProviderInfo[]): void {
  const label = $("#ag-model-l"); const st = $("#st-model-l");
  const dot = $<HTMLElement>("#ag-model .live");
  const p = providers.find((x) => x.id === activeProvider);
  const text = p ? (activeModel ? `${p.name} · ${activeModel}` : p.name) : t("codev.noProvider");
  if (label) label.textContent = text;
  if (st) st.textContent = p ? p.name : "Co-Dev";
  if (dot) dot.style.background = activeProvider ? "var(--green)" : "var(--fg-muted)";
}

// ── Provedores em Settings (real: get/save_providers_config) ────────────────────────
function providersPanel(host: HTMLElement): void {
  host.innerHTML = `<div class="sec-empty">${t("codev.providers.loading")}</div>`;
  void invoke<ProvidersConfig>("get_providers_config").then((cfg) => renderProvidersForm(host, cfg))
    .catch(() => { host.innerHTML = `<div class="sec-empty">${t("codev.providers.loadErr")}</div>`; });
}
function renderProvidersForm(host: HTMLElement, cfg: ProvidersConfig): void {
  const field = (key: keyof ProvidersConfig, labelKey: string, type = "password"): string =>
    `<label style="display:block;margin:8px 0 2px;font-size:11px;color:var(--fg-muted)">${t(labelKey)}</label>`
    + `<input data-cfg="${key}" type="${type}" value="${String(cfg[key] ?? "").replace(/"/g, "&quot;")}" style="width:100%;max-width:480px"/>`;
  host.innerHTML = `<div class="pcard" style="max-width:520px">
    ${field("anthropicKey", "codev.providers.anthropicKey")}
    ${field("openaiKey", "codev.providers.openaiKey")}
    ${field("geminiKey", "codev.providers.geminiKey")}
    ${field("ollamaHost", "codev.providers.ollamaHost", "text")}
    ${field("ollamaModel", "codev.providers.ollamaModel", "text")}
    <div style="margin-top:12px"><button class="btn" id="cfg-save">${t("codev.providers.save")}</button>
    <span id="cfg-status" style="margin-left:10px;font-size:12px"></span></div>
    <div class="pd" style="margin-top:8px">${t("codev.providers.note")}</div></div>`;
  const save = host.querySelector<HTMLElement>("#cfg-save");
  if (save) save.onclick = () => {
    const next: ProvidersConfig = { ...cfg };
    host.querySelectorAll<HTMLInputElement>("[data-cfg]").forEach((i) => {
      (next as unknown as Record<string, string>)[i.dataset.cfg!] = i.value;
    });
    const status = host.querySelector<HTMLElement>("#cfg-status");
    void invoke("save_providers_config", { config: next }).then(() => {
      if (status) { status.textContent = t("codev.providers.saved"); status.style.color = "var(--green)"; }
      void refreshModelLabel(); // o provedor pode ter passado a disponível
    }).catch((e) => { if (status) { status.textContent = String(e); status.style.color = "var(--red)"; } });
  };
}

// ── Arranque ──────────────────────────────────────────────────────────────────
/** Liga o chat do dock Co-Dev ao backend. Chamar DEPOIS de bootShell(). */
export function initCodev(): void {
  registerStrings(CODEV_STRINGS);

  // Reassume os controlos que a casca ligou temporariamente ao aviso «not implemented».
  const sendBtn = $("#ag-send");
  if (sendBtn) sendBtn.onclick = () => void send();

  const input = $<HTMLTextAreaElement>("#ag-input");
  if (input) input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  const newBtn = $("#ag-new");
  if (newBtn) newBtn.onclick = () => newChat();

  const ctxBtn = $("#pill-ctx");
  if (ctxBtn) ctxBtn.onclick = () => toggleCtx();

  // Selector de modelo real (dock + barra de estado) — reassume o aviso da casca.
  const modelBtn = $("#ag-model");
  if (modelBtn) modelBtn.onclick = (e) => { e.stopPropagation(); void pickModel("#ag-model"); };
  const stModel = $("#st-model");
  if (stModel) stModel.onclick = (e) => { e.stopPropagation(); void pickModel("#st-model"); };

  // Secção de provedores em Settings (real: get/save_providers_config).
  setProvidersPanel((host) => providersPanel(host));

  // O desfecho de cada edição ancorada (aplicada/rejeitada/conflito) regista-se no Output·Co-Dev.
  setPatchLog((msg) => logOutput("recv", msg));

  renderIntro();
  renderCtxPill();
  void refreshModelLabel();
}

/** Mostra o painel Output·Co-Dev (usado pelos comandos/atalhos da casca). */
export function showCodevOutput(): void { setPanelTab("output"); }

/** Provedor/modelo activo do Co-Dev (ou null se nenhum disponível), para outras superfícies
 *  (ex.: Explain) usarem a mesma escolha do utilizador em vez de duplicar a lógica. */
export function codevProvider(): { provider: string; model: string | null } | null {
  return activeProvider ? { provider: activeProvider, model: activeModel } : null;
}

// Chaves NOVAS (codev.*). As já registadas pela casca (placeholder, intro, send,
// newChat, pickModel, ctx…) NÃO são redefinidas aqui.
const CODEV_STRINGS = {
  en: {
    "codev.you": "you",
    "codev.assistant": "co-dev",
    "codev.thinking": "Thinking…",
    "codev.noProvider": "no provider configured",
    "codev.busy": "Wait for the current reply to finish.",
    "codev.error": "Error: {error}",
    "codev.ctxOn": "Active file included as context.",
    "codev.ctxOff": "Context off.",
    "codev.ctxNone": "no file",
    "codev.ctxHeader": "Active file as context: {file}",
    "codev.out.sent": "sent",
    "codev.out.recv": "reply",
    "codev.out.error": "error",
    "codev.out.empty": "(empty reply)",
    "codev.patch.review": "— anchored edit resolved; review it in the diff.",
    "codev.patch.reviewN": "— {n}-file anchored changeset resolved; review each diff.",
    "codev.patch.applied": "— anchored edit applied (undoable); diff shown as a record.",
    "codev.patch.appliedN": "— {n}-file anchored changeset applied (undoable); diff shown as a record.",
    "codev.plan.title": "Plan",
    "codev.plan.untitled": "Plan",
    "codev.plan.started": "plan started: {title} ({n} steps)",
    "codev.plan.continue": "Continue",
    "codev.plan.autoOn": "auto mode drives the steps",
    "codev.plan.manualHint": "click to drive the next step",
    "codev.plan.verifyRunning": "verifying: running the project tests…",
    "codev.plan.verifyPass": "✓ verified: the project tests passed.",
    "codev.plan.verifyFail": "✗ the project tests failed — see the output.",
    "codev.plan.verifyNotRun": "ℹ tests did not run (no runnable suite found).",
    "codev.plan.verifyNoFolder": "ℹ open a folder to run the verification tests.",
    "codev.plan.verifyErr": "⚠ could not run the tests: {e}",
    "codev.providers.loading": "Loading providers…",
    "codev.providers.loadErr": "Could not read the provider settings.",
    "codev.providers.anthropicKey": "Anthropic API key",
    "codev.providers.openaiKey": "OpenAI API key",
    "codev.providers.geminiKey": "Gemini API key",
    "codev.providers.ollamaHost": "Ollama host (e.g. http://localhost:11434)",
    "codev.providers.ollamaModel": "Ollama model",
    "codev.providers.save": "Save",
    "codev.providers.saved": "Saved.",
    "codev.providers.note": "Keys are stored locally at ~/.config/dxtutor/providers.json (mode 0600). Empty fields fall back to the matching environment variable.",
  },
  ptAO: {
    "codev.you": "tu",
    "codev.assistant": "co-dev",
    "codev.thinking": "A pensar…",
    "codev.noProvider": "sem provedor configurado",
    "codev.busy": "Espera a resposta actual terminar.",
    "codev.error": "Erro: {error}",
    "codev.ctxOn": "Ficheiro activo incluído como contexto.",
    "codev.ctxOff": "Contexto desligado.",
    "codev.ctxNone": "sem ficheiro",
    "codev.ctxHeader": "Ficheiro activo como contexto: {file}",
    "codev.out.sent": "enviado",
    "codev.out.recv": "resposta",
    "codev.out.error": "erro",
    "codev.out.empty": "(resposta vazia)",
    "codev.patch.review": "— edição ancorada resolvida; revê-a no diff.",
    "codev.patch.reviewN": "— conjunto ancorado de {n} ficheiros resolvido; revê cada diff.",
    "codev.patch.applied": "— edição ancorada aplicada (desfazível); diff mostrado como registo.",
    "codev.patch.appliedN": "— conjunto ancorado de {n} ficheiros aplicado (desfazível); diff como registo.",
    "codev.plan.title": "Plano",
    "codev.plan.untitled": "Plano",
    "codev.plan.started": "plano iniciado: {title} ({n} passos)",
    "codev.plan.continue": "Continuar",
    "codev.plan.autoOn": "o modo auto conduz os passos",
    "codev.plan.manualHint": "clica para conduzir o passo seguinte",
    "codev.plan.verifyRunning": "a verificar: a correr os testes do projecto…",
    "codev.plan.verifyPass": "✓ verificado: os testes do projecto passaram.",
    "codev.plan.verifyFail": "✗ os testes do projecto falharam — vê a saída.",
    "codev.plan.verifyNotRun": "ℹ os testes não correram (nenhuma suite executável encontrada).",
    "codev.plan.verifyNoFolder": "ℹ abre uma pasta para correr os testes de verificação.",
    "codev.plan.verifyErr": "⚠ não consegui correr os testes: {e}",
    "codev.providers.loading": "A carregar provedores…",
    "codev.providers.loadErr": "Não foi possível ler as definições dos provedores.",
    "codev.providers.anthropicKey": "Chave de API Anthropic",
    "codev.providers.openaiKey": "Chave de API OpenAI",
    "codev.providers.geminiKey": "Chave de API Gemini",
    "codev.providers.ollamaHost": "Host Ollama (ex.: http://localhost:11434)",
    "codev.providers.ollamaModel": "Modelo Ollama",
    "codev.providers.save": "Guardar",
    "codev.providers.saved": "Guardado.",
    "codev.providers.note": "As chaves ficam localmente em ~/.config/dxtutor/providers.json (modo 0600). Campos vazios recorrem à variável de ambiente correspondente.",
  },
};
