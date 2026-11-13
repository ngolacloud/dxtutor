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
import { activeFile } from "./workspace";
import { toast } from "./index";

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
  const label = $("#ag-model-l");
  const dot = $<HTMLElement>("#ag-model .live");
  let providers: ProviderInfo[] = [];
  try { providers = await invoke<ProviderInfo[]>("list_providers"); }
  catch { providers = []; }
  const ready = providers.find((p) => p.available) || null;
  if (!ready) {
    activeProvider = null;
    activeModel = null;
    if (label) label.textContent = t("codev.noProvider");
    if (dot) dot.style.background = "var(--fg-muted)";
    return;
  }
  activeProvider = ready.id;
  // Ollama traz os modelos locais em `models`; para os restantes o backend escolhe.
  if (ready.id === "ollama" && ready.models.length === 0) {
    try { ready.models = await invoke<string[]>("assistant_models"); } catch { /* backend ausente */ }
  }
  activeModel = ready.models.length ? ready.models[0] : null;
  if (label) label.textContent = activeModel ? `${ready.name} · ${activeModel}` : ready.name;
  if (dot) dot.style.background = "var(--green)";
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

// ── Envio + streaming ───────────────────────────────────────────────────────────
async function send(): Promise<void> {
  const input = $<HTMLTextAreaElement>("#ag-input"); if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  if (busy) { toast(t("codev.busy")); return; }
  // Honestidade: sem provedor ligado não se inventa resposta.
  if (!activeProvider) { toast(t("codev.noProvider")); return; }

  input.value = "";
  pushUserBubble(raw);

  // A mensagem enviada ao modelo pode levar o ficheiro activo como contexto; o
  // histórico visível guarda o texto puro do utilizador.
  const content = await withContext(raw);
  history.push({ role: "user", content });

  const bd = newAiBubble();
  const requestId = `codev-${Date.now()}-${++seq}`;
  let acc = "";
  let first = true;
  busy = true;

  // Subscreve os três eventos ANTES de invocar (evita perder tokens iniciais).
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
    cleanup();
    scrollMsgs();
  });
  unlisteners.push(unDone);

  const unError = await listen<ErrorEvt>("llm://error", (e) => {
    if (e.payload.requestId !== requestId) return;
    if (bd) bd.textContent = t("codev.error", { error: e.payload.error });
    // Não se guarda no histórico uma resposta que falhou; a mensagem do utilizador fica.
    cleanup();
    scrollMsgs();
  });
  unlisteners.push(unError);

  try {
    await invoke("assistant_chat_stream", {
      messages: history,
      provider: activeProvider,
      model: activeModel,
      requestId,
    });
  } catch (err) {
    if (bd) bd.textContent = t("codev.error", { error: String(err) });
    cleanup();
  }
}

/** Nova conversa: limpa o histórico e repõe a intro curta. */
function newChat(): void {
  if (busy) { toast(t("codev.busy")); return; }
  history.length = 0;
  renderIntro();
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

  renderIntro();
  renderCtxPill();
  void refreshModelLabel();
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
  },
};
