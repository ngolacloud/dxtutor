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
import { toast, setPanelTab, setProvidersPanel } from "./index";

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
  logOutput("sent", oneLine(raw));

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
    logOutput("recv", acc ? oneLine(acc) : t("codev.out.empty"));
    cleanup();
    scrollMsgs();
  });
  unlisteners.push(unDone);

  const unError = await listen<ErrorEvt>("llm://error", (e) => {
    if (e.payload.requestId !== requestId) return;
    if (bd) bd.textContent = t("codev.error", { error: e.payload.error });
    logOutput("error", e.payload.error);
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

  renderIntro();
  renderCtxPill();
  void refreshModelLabel();
}

/** Mostra o painel Output·Co-Dev (usado pelos comandos/atalhos da casca). */
export function showCodevOutput(): void { setPanelTab("output"); }

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
