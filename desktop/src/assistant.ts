// Dev Assistant (chat) — a place to type/paste prompts and talk to a local model.
//
// This is the chat shell that P4 will grow into the full assistant: multi-provider
// picker, token streaming, cancellation, and Ask-vs-Edit-with-me. For now it runs
// NON-streaming against the local Ollama model (the one provider available with no
// API key), so it is real and useful today. Paste a review finding or the review's
// second-opinion prompt straight in.

import { invoke } from "@tauri-apps/api/core";

interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}
interface ChatReply {
  content: string;
  model: string;
  provider: string;
}

let messages: ChatMsg[] = [];
let busy = false;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function initAssistant(): void {
  $("#assistant-close").addEventListener("click", () => $("#assistant-overlay").classList.add("hidden"));
  $("#assistant-clear").addEventListener("click", () => {
    messages = [];
    renderMessages();
  });
  $("#assistant-send").addEventListener("click", () => void send());
  const ta = $("#assistant-input") as HTMLTextAreaElement;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  });
}

export function openAssistant(): void {
  $("#assistant-overlay").classList.remove("hidden");
  renderMessages();
  void refreshModel();
  ($("#assistant-input") as HTMLTextAreaElement).focus();
}

async function refreshModel(): Promise<void> {
  const el = $("#assistant-model");
  try {
    const models = await invoke<string[]>("assistant_models");
    if (models.length) {
      el.textContent = models.find((m) => m.toLowerCase().includes("qwen")) ?? models[0];
      el.className = "assistant-model ok";
    } else {
      el.textContent = "no local model";
      el.className = "assistant-model off";
    }
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
  renderMessages();

  busy = true;
  setPending(true);
  try {
    const reply = await invoke<ChatReply>("assistant_chat", { messages, model: null });
    messages.push({ role: "assistant", content: reply.content || "(empty reply)" });
  } catch (e) {
    messages.push({ role: "assistant", content: `⚠ ${String(e)}` });
  } finally {
    busy = false;
    setPending(false);
    renderMessages();
  }
}

function setPending(p: boolean): void {
  const b = $("#assistant-send") as HTMLButtonElement;
  b.disabled = p;
  b.textContent = p ? "…" : "Send";
}

function renderMessages(): void {
  const host = $("#assistant-messages");
  if (messages.length === 0) {
    host.innerHTML = `<div class="as-welcome">Ask the Dev Assistant anything — paste a review finding, the review's AI prompt, or code. It runs on your local model (Ollama). <b>Ctrl+Enter</b> to send.<br><br>Streaming, a provider picker and “Edit with me” arrive in the next phase.</div>`;
    return;
  }
  host.innerHTML = messages
    .map(
      (m) =>
        `<div class="as-msg ${m.role}"><div class="as-role">${m.role === "user" ? "You" : "Assistant"}</div><div class="as-body">${esc(m.content)}</div></div>`,
    )
    .join("");
  if (busy) host.innerHTML += `<div class="as-msg assistant"><div class="as-role">Assistant</div><div class="as-body as-think"><span class="rv-spin"></span> thinking…</div></div>`;
  host.scrollTop = host.scrollHeight;
}
