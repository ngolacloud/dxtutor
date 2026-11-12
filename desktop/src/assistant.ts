// Dev Assistant (chat) — P4 streaming. Tokens arrive live via `llm://token` events
// (the pty.rs streaming pattern); the Send button becomes Stop to interrupt. Runs on
// the local Ollama model (no API key). The multi-provider picker and "Edit with me"
// build on this same transport next.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  streaming: boolean;
  note: string;
  models: string[];
}

let messages: ChatMsg[] = [];
let busy = false;
let currentRequestId: string | null = null;
let streamingIdx = -1; // index of the assistant message being streamed into
let provider = "ollama"; // selected AI provider (only Ollama streams live today)

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function initAssistant(): void {
  $("#assistant-close").addEventListener("click", () => $("#assistant-overlay").classList.add("hidden"));
  $("#assistant-clear").addEventListener("click", () => {
    if (busy) return;
    messages = [];
    renderMessages();
  });
  // One button: Send while idle, Stop (cancel) while a stream is running.
  $("#assistant-send").addEventListener("click", () => {
    if (busy && currentRequestId) void invoke("assistant_cancel", { requestId: currentRequestId });
    else void send();
  });
  const ta = $("#assistant-input") as HTMLTextAreaElement;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!busy) void send();
    }
  });
  $("#assistant-provider").addEventListener("change", (e) => {
    provider = (e.target as HTMLSelectElement).value;
    updateModelLabel();
  });
  $("#assistant-settings").addEventListener("click", () => void openProviders());
  $("#providers-close").addEventListener("click", () => $("#providers-overlay").classList.add("hidden"));
  $("#providers-save").addEventListener("click", () => void saveProviders());

  // Live token stream from the backend.
  void listen<{ requestId: string; delta: string }>("llm://token", (e) => {
    if (e.payload.requestId !== currentRequestId || streamingIdx < 0) return;
    messages[streamingIdx].content += e.payload.delta;
    renderMessages();
  });
  void listen<{ requestId: string }>("llm://done", (e) => {
    if (e.payload.requestId === currentRequestId) finishStream();
  });
  void listen<{ requestId: string; error: string }>("llm://error", (e) => {
    if (e.payload.requestId !== currentRequestId) return;
    if (streamingIdx >= 0 && !messages[streamingIdx].content) {
      messages[streamingIdx].content = `⚠ ${e.payload.error}`;
    }
    finishStream();
  });
}

export function openAssistant(): void {
  $("#review-overlay")?.classList.add("hidden"); // the two right drawers are exclusive
  $("#assistant-overlay").classList.remove("hidden");
  renderMessages();
  void refreshModel();
  ($("#assistant-input") as HTMLTextAreaElement).focus();
}

/** The AI provider the user has selected (so Edit-with-me / Ask AI use the same one). */
export function selectedProvider(): string {
  return provider;
}

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

// Trim whitespace AND one layer of wrapping quotes — a stray pasted quote on a
// key or workspace id (e.g. `wrkspc_…"`) otherwise invalidates the auth header.
const val = (id: string) => {
  let v = ($(`#${id}`) as HTMLInputElement | HTMLSelectElement).value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
};
const setVal = (id: string, v: string) => (($(`#${id}`) as HTMLInputElement).value = v);

async function openProviders(): Promise<void> {
  // Populate the default-provider dropdown from the live provider list.
  try {
    const providers = await invoke<ProviderInfo[]>("list_providers");
    (($("#cfg-provider") as HTMLSelectElement).innerHTML = providers
      .map((p) => `<option value="${p.id}">${p.name}</option>`)
      .join(""));
  } catch {
    /* leave empty */
  }
  try {
    const c = await invoke<ProvidersConfig>("get_providers_config");
    ($("#cfg-provider") as HTMLSelectElement).value = c.provider || "ollama";
    setVal("cfg-anthropic-key", c.anthropicKey);
    setVal("cfg-anthropic-ws", c.anthropicWorkspaceId);
    setVal("cfg-assistant-model", c.assistantModel);
    setVal("cfg-openai-key", c.openaiKey);
    setVal("cfg-gemini-key", c.geminiKey);
    setVal("cfg-ollama-host", c.ollamaHost);
    setVal("cfg-ollama-model", c.ollamaModel);
  } catch {
    /* fresh config */
  }
  $("#providers-status").textContent = "";
  $("#providers-overlay").classList.remove("hidden");
}

async function saveProviders(): Promise<void> {
  const config: ProvidersConfig = {
    provider: val("cfg-provider"),
    anthropicKey: val("cfg-anthropic-key"),
    anthropicWorkspaceId: val("cfg-anthropic-ws"),
    openaiKey: val("cfg-openai-key"),
    geminiKey: val("cfg-gemini-key"),
    ollamaHost: val("cfg-ollama-host"),
    ollamaModel: val("cfg-ollama-model"),
    assistantModel: val("cfg-assistant-model"),
  };
  try {
    await invoke("save_providers_config", { config });
    if (config.provider) provider = config.provider;
    $("#providers-status").textContent = "Saved ✓";
    await refreshModel(); // re-read availability; update picker + model label
    setTimeout(() => $("#providers-overlay").classList.add("hidden"), 700);
  } catch (e) {
    $("#providers-status").textContent = `⚠ ${String(e)}`;
  }
}

let ollamaModels: string[] = [];
/** Update the model indicator to reflect the selected provider. */
function updateModelLabel(): void {
  const el = $("#assistant-model");
  if (provider === "ollama") {
    if (ollamaModels.length) {
      el.textContent = ollamaModels.find((m) => m.toLowerCase().includes("qwen")) ?? ollamaModels[0];
      el.className = "assistant-model ok";
    } else {
      el.textContent = "no local model";
      el.className = "assistant-model off";
    }
  } else {
    const defaults: Record<string, string> = {
      claude: "claude-haiku-4-5",
      openai: "gpt-4o-mini",
      gemini: "gemini-2.0-flash",
    };
    el.textContent = defaults[provider] ?? provider;
    el.className = "assistant-model ok";
  }
}

/** Open the assistant pre-filled with a prompt (used by "Ask AI" on a finding). */
export function askAssistant(prompt: string): void {
  openAssistant();
  const ta = $("#assistant-input") as HTMLTextAreaElement;
  ta.value = prompt;
  ta.focus();
}

async function refreshModel(): Promise<void> {
  const sel = $("#assistant-provider") as HTMLSelectElement;
  const el = $("#assistant-model");
  try {
    const providers = await invoke<ProviderInfo[]>("list_providers");
    // Only providers that stream live are selectable; the rest are shown (disabled)
    // with their status so the matrix is honest.
    sel.innerHTML = providers
      .map((p) => {
        const usable = p.available && p.streaming;
        const label = usable ? p.name : `${p.name} — ${p.available ? "no stream" : "set key"}`;
        return `<option value="${p.id}" ${usable ? "" : "disabled"} ${p.id === provider ? "selected" : ""}>${label}</option>`;
      })
      .join("");
    const current = providers.find((p) => p.id === provider);
    if (current && !(current.available && current.streaming)) {
      // Fall back to the first usable provider (Ollama).
      const first = providers.find((p) => p.available && p.streaming);
      if (first) {
        provider = first.id;
        sel.value = first.id;
      }
    }
    ollamaModels = providers.find((p) => p.id === "ollama")?.models ?? [];
    updateModelLabel();
  } catch {
    el.textContent = "offline";
    el.className = "assistant-model off";
  }
}

async function send(): Promise<void> {
  if (busy) return;
  const ta = $("#assistant-input") as HTMLTextAreaElement;
  const text = ta.value.trim();
  if (!text) return;
  messages.push({ role: "user", content: text });
  ta.value = "";
  streamingIdx = messages.push({ role: "assistant", content: "" }) - 1;

  busy = true;
  currentRequestId = crypto.randomUUID();
  setStreaming(true);
  renderMessages();
  try {
    // Returns immediately; completion/tokens arrive via llm:// events. Send the
    // history WITHOUT the empty assistant placeholder we just pushed.
    // P0-2: tell the backend the active mode so it can enforce the study contract.
    // In learning mode the backend prepends the tutor directive and refuses to be a free
    // code generator — the student keeps authorship. The backend is the authority; this
    // is just the explicit Study/Project signal (`Mode::parse` maps workspace→Project).
    await invoke("assistant_chat_stream", {
      messages: messages.slice(0, streamingIdx),
      provider,
      model: null,
      requestId: currentRequestId,
      mode: localStorage.getItem("dxtutor.mode") ?? "learning",
      stepId: null,
    });
  } catch (e) {
    if (streamingIdx >= 0) messages[streamingIdx].content = `⚠ ${String(e)}`;
    finishStream();
  }
}

function finishStream(): void {
  busy = false;
  currentRequestId = null;
  streamingIdx = -1;
  setStreaming(false);
  renderMessages();
}

function setStreaming(s: boolean): void {
  const b = $("#assistant-send") as HTMLButtonElement;
  b.textContent = s ? "Stop" : "Send";
  b.classList.toggle("stop", s);
}

function renderMessages(): void {
  const host = $("#assistant-messages");
  if (messages.length === 0) {
    host.innerHTML = `<div class="as-welcome">Ask the Dev Assistant anything — paste a review finding, the review's AI prompt, or code. Tokens stream live from your local model (Ollama). <b>Ctrl+Enter</b> to send, <b>Stop</b> to interrupt.<br><br>A provider picker and “Edit with me” build on this streaming transport next.</div>`;
    return;
  }
  host.innerHTML = messages
    .map((m, i) => {
      const streaming = busy && i === streamingIdx;
      const body = esc(m.content) + (streaming ? '<span class="as-cursor">▍</span>' : "");
      return `<div class="as-msg ${m.role}"><div class="as-role">${m.role === "user" ? "You" : "Assistant"}</div><div class="as-body">${body || (streaming ? '<span class="as-cursor">▍</span>' : "")}</div></div>`;
    })
    .join("");
  host.scrollTop = host.scrollHeight;
}
