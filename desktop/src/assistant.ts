// Dev Assistant (chat) — P4 streaming. Tokens arrive live via `llm://token` events
// (the pty.rs streaming pattern); the Send button becomes Stop to interrupt. Runs on
// the local Ollama model (no API key). The multi-provider picker and "Edit with me"
// build on this same transport next.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  activeFilePath,
  activeSelection,
  beginEditorStream,
  currentFileContent,
  endEditorStream,
  isDirty,
  pushEditorStream,
  revealPath,
  workspaceRoot,
} from "./workspace";

interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

interface DxAction {
  op: "createDir" | "createFile" | "writeFile";
  path: string;
  content?: string;
}

interface DxCode {
  file: string;
  language?: string;
  instruction: string;
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
let lastContext: string | null = null; // the workspace context sent with the last turn
const appliedActions = new Set<number>(); // message indices whose dxaction was applied
const actionErrors = new Map<number, string>(); // message index -> last apply error
// Dev delegate: the live code-generation stream that writes INTO the editor (not chat).
let codeStream: {
  requestId: string;
  path: string;
  file: string;
  idx: number;
  accum: string;
  original: string; // file content before the stream, to restore if the model gives nothing
} | null = null;
const writeState = new Map<number, "writing" | "done">(); // message idx -> code-stream state
const shrinkWarn = new Set<number>(); // done writes where the file shrank a lot (review it)

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function initAssistant(): void {
  $("#assistant-close").addEventListener("click", () => $("#assistant-overlay").classList.add("hidden"));
  $("#assistant-clear").addEventListener("click", () => {
    if (busy) return;
    messages = [];
    lastContext = null;
    appliedActions.clear();
    actionErrors.clear();
    writeState.clear();
    shrinkWarn.clear();
    renderMessages();
  });
  // Approve / dismiss a proposed workspace action (event delegation on the message list).
  $("#assistant-messages").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (Number.isNaN(idx)) return;
    if (btn.classList.contains("as-apply")) void applyAction(idx);
    else if (btn.classList.contains("as-write")) void startCodeStream(idx);
    else if (btn.classList.contains("as-reject")) {
      // Mark as handled so the card disappears: strip the directive from the message.
      messages[idx].content = messages[idx].content
        .replace(/```dxaction\s*\n[\s\S]*?```/, "")
        .replace(/```dxcode\s*\n[\s\S]*?```/, "")
        .trim();
      actionErrors.delete(idx);
      renderMessages();
    }
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

  // Live token stream from the backend. Tokens route to the EDITOR during a code stream
  // (Dev delegate), or to the chat bubble otherwise.
  void listen<{ requestId: string; delta: string }>("llm://token", (e) => {
    if (codeStream && e.payload.requestId === codeStream.requestId) {
      codeStream.accum += e.payload.delta;
      pushEditorStream(stripFences(codeStream.accum)); // build the code live in the tab
      return;
    }
    if (e.payload.requestId !== currentRequestId || streamingIdx < 0) return;
    messages[streamingIdx].content += e.payload.delta;
    renderMessages();
  });
  void listen<{ requestId: string }>("llm://done", (e) => {
    if (codeStream && e.payload.requestId === codeStream.requestId) {
      const cs = codeStream;
      const produced = stripFences(cs.accum).trim();
      if (!produced) {
        // The model returned nothing usable — restore the original content rather than
        // leaving the file wiped, and let the developer retry.
        pushEditorStream(cs.original);
        endEditorStream();
        actionErrors.set(cs.idx, "the model produced no code — the file was left unchanged");
        writeState.delete(cs.idx);
      } else {
        endEditorStream();
        writeState.set(cs.idx, "done");
        // Shrink guard: if a substantial file was replaced with far less content, the
        // model may have returned a partial — flag it so the developer reviews (undoable).
        if (cs.original.trim().length > 200 && produced.length < cs.original.length * 0.4) {
          shrinkWarn.add(cs.idx);
        }
      }
      codeStream = null;
      finishStream();
      return;
    }
    if (e.payload.requestId === currentRequestId) {
      const idx = streamingIdx; // the assistant message that just completed
      finishStream();
      // Dev delegate: as soon as the plan is in and it carries a dxcode, start writing the
      // code live into the editor — no extra click. Stop / Ctrl+Z keep the developer in
      // control. EXCEPTION: if the target file has unsaved edits, don't silently overwrite
      // them — fall through to the button so the developer decides.
      const dc = idx >= 0 ? parseCodeDirective(messages[idx]?.content ?? "") : null;
      const abs = dc ? codeTargetAbs(dc.file) : null;
      if (dc && !writeState.has(idx) && !(abs && isDirty(abs))) {
        void startCodeStream(idx);
      }
    }
  });
  void listen<{ requestId: string; error: string }>("llm://error", (e) => {
    if (codeStream && e.payload.requestId === codeStream.requestId) {
      // A mid-stream provider failure must not leave a partial/empty buffer — restore the
      // file to what it was before the generation started.
      pushEditorStream(codeStream.original);
      endEditorStream();
      actionErrors.set(codeStream.idx, e.payload.error);
      writeState.delete(codeStream.idx);
      codeStream = null;
      finishStream();
      return;
    }
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

/** Build the grounding context sent to the model in project mode: root, tree, active
 *  file, selection, and the dxaction protocol so it acts through the IDE. */
async function buildWorkspaceContext(): Promise<string | null> {
  const root = workspaceRoot();
  if (!root) return null;
  let tree = "";
  try {
    tree = await invoke<string>("workspace_tree", { root, maxDepth: 2, maxEntries: 200 });
  } catch {
    /* tree is best-effort */
  }
  const active = activeFilePath();
  const sel = activeSelection();
  // Ground on the active file's content too, so "explain/modify this file" works without
  // the model guessing. Truncated to keep the prompt bounded; a selection takes priority.
  const activeBody = active && !sel ? currentFileContent(active) : null;
  const MAX = 8000;
  const bodyBlock = activeBody
    ? `Active file content${activeBody.length > MAX ? " (truncated)" : ""}:\n${activeBody.slice(0, MAX)}`
    : "";
  return [
    `You are the dxtutor workspace assistant. You work INSIDE the user's open project — ` +
      `not a generic chatbot. Ground every answer in THIS real workspace, by its actual paths.`,
    `Workspace root: ${root}`,
    active ? `Active file: ${active}` : `No file is currently open.`,
    sel ? `Selected code:\n${sel.slice(0, 2000)}` : "",
    bodyBlock,
    `Project tree (depth-limited, build/VCS dirs skipped):\n${tree}`,
    `You act through the IDE, never with OS shell instructions (no mkdir / PowerShell / ` +
      `Python). You have two action blocks. Choose based on whether the task produces CODE:`,
    `• To WRITE or MODIFY CODE in a file (this is the common case), reply with a SHORT plan ` +
      `(1–3 lines) then, IN THIS SAME REPLY, EXACTLY ONE fenced block:\n` +
      "```dxcode\n" +
      `{"file":"<path relative to the workspace root>","language":"rust","instruction":"<precise, self-contained description of the full file to generate>"}\n` +
      "```\n" +
      `The \`file\` path MAY include folders that do not exist yet (e.g. ` +
      `"examples/dxtutor/main.rs") — they are created automatically, so you do NOT need a ` +
      `separate folder step. The code then streams LIVE into that editor tab. NEVER paste ` +
      `the code in the chat and NEVER say you "will" create it later — emit the dxcode block ` +
      `now. If several files are needed, emit the first dxcode now and offer the next after.`,
    `• ONLY for a pure EMPTY folder or empty file (no code at all), use exactly one block:\n` +
      "```dxaction\n" +
      `{"op":"createDir"|"createFile"|"writeFile","path":"<relative to root>","content":"<optional>"}\n` +
      "```\n" +
      `Do NOT use dxaction when the task involves code — use dxcode, whose path already ` +
      `creates any missing folders.`,
    `Example — user: "create a folder dxtutor in examples and a main.rs that prints hello ` +
      `world" → reply a one-line plan, then a single dxcode with ` +
      `file "examples/dxtutor/main.rs" and an instruction for a Rust hello-world program ` +
      `(the folder is created by that path).`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Extract the first dxcode directive from an assistant message, if valid. */
function parseCodeDirective(text: string): DxCode | null {
  const m = text.match(/```dxcode\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim());
    if (typeof obj.file === "string" && typeof obj.instruction === "string") return obj as DxCode;
  } catch {
    /* not valid JSON */
  }
  return null;
}

/** Strip a leading ``` fence (language tag and all) from streamed code, tolerating an
 *  unclosed trailing fence while tokens are still arriving. */
function stripFences(s: string): string {
  const i = s.indexOf("```");
  if (i < 0) return s;
  const after = s.slice(i + 3);
  const nl = after.indexOf("\n");
  const body = nl >= 0 ? after.slice(nl + 1) : "";
  const close = body.indexOf("```");
  return close >= 0 ? body.slice(0, close) : body;
}

/** Absolute path of a dxcode target, resolved under the workspace root. */
function codeTargetAbs(file: string): string | null {
  const root = workspaceRoot();
  return root ? `${root.replace(/\/$/, "")}/${file.replace(/^\.?\//, "")}` : null;
}

/** Dev delegate: stream the generated file content LIVE into the editor tab. The chat
 *  keeps the plan; the code is built in the real buffer (undoable, interruptible). */
async function startCodeStream(idx: number): Promise<void> {
  if (busy) return;
  const dir = parseCodeDirective(messages[idx]?.content ?? "");
  const root = workspaceRoot();
  if (!dir || !root) return;
  // Containment (robustness): resolve the proposed path under the workspace root on the
  // backend. A `../` escape is refused here, before any file is opened or streamed into.
  let abs: string;
  try {
    abs = await invoke<string>("workspace_resolve", { root, path: dir.file });
  } catch (e) {
    actionErrors.set(idx, `refused: ${String(e)}`);
    renderMessages();
    return;
  }
  const ok = await beginEditorStream(abs);
  if (!ok) {
    actionErrors.set(idx, "could not open the target file in the editor");
    renderMessages();
    return;
  }
  const current = currentFileContent(abs) ?? "";
  const rid = crypto.randomUUID();
  codeStream = { requestId: rid, path: abs, file: dir.file, idx, accum: "", original: current };
  writeState.set(idx, "writing");

  busy = true;
  currentRequestId = rid;
  setStreaming(true);
  renderMessages();

  const genMessages: ChatMsg[] = [
    {
      role: "system",
      content:
        `You are a precise code generator writing the file "${dir.file}"` +
        (dir.language ? ` (${dir.language})` : "") +
        `. Output ONLY the complete, final contents of this file. No markdown, no code ` +
        `fences, no explanation — just the file's text.`,
    },
    {
      role: "user",
      content:
        `${dir.instruction}\n\n` +
        (current.trim()
          ? `Current content of the file (modify as needed):\n${current}`
          : `The file is new/empty.`),
    },
  ];
  try {
    await invoke("assistant_chat_stream", {
      messages: genMessages,
      provider,
      model: null,
      requestId: rid,
      mode: "workspace", // code generation is a project-mode capability
      stepId: null,
    });
  } catch (e) {
    actionErrors.set(idx, String(e));
    endEditorStream();
    codeStream = null;
    writeState.delete(idx);
    finishStream();
  }
}

/** Extract the first dxaction block from an assistant message, if valid. */
function parseAction(text: string): DxAction | null {
  const m = text.match(/```dxaction\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim());
    if (
      (obj.op === "createDir" || obj.op === "createFile" || obj.op === "writeFile") &&
      typeof obj.path === "string"
    ) {
      return obj as DxAction;
    }
  } catch {
    /* not valid JSON — no actionable proposal */
  }
  return null;
}

/** Perform a proposed action, scoped to the workspace, then reveal it in the Explorer. */
async function applyAction(idx: number): Promise<void> {
  const action = parseAction(messages[idx]?.content ?? "");
  const root = workspaceRoot();
  if (!action || !root) return;
  actionErrors.delete(idx);
  try {
    const abs = await invoke<string>("workspace_action", {
      root,
      op: action.op,
      path: action.path,
      content: action.content ?? null,
    });
    await revealPath(abs, action.op === "createDir");
    appliedActions.add(idx);
  } catch (e) {
    actionErrors.set(idx, String(e));
  }
  renderMessages();
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
    // Ground the assistant in the OPEN workspace (project mode): root, tree, active file
    // and selection, plus the dxaction protocol so it can act through the IDE instead of
    // answering like a generic chat. Built fresh each turn; inspectable via the context chip.
    const mode = localStorage.getItem("dxtutor.mode") ?? "learning";
    lastContext = mode === "workspace" ? await buildWorkspaceContext() : null;
    const history = messages.slice(0, streamingIdx);
    const outbound = lastContext
      ? [{ role: "system", content: lastContext } as ChatMsg, ...history]
      : history;
    // Returns immediately; completion/tokens arrive via llm:// events. Send the
    // history WITHOUT the empty assistant placeholder we just pushed.
    // P0-2: tell the backend the active mode so it can enforce the study contract.
    // In learning mode the backend prepends the tutor directive and refuses to be a free
    // code generator — the student keeps authorship. The backend is the authority; this
    // is just the explicit Study/Project signal (`Mode::parse` maps workspace→Project).
    await invoke("assistant_chat_stream", {
      messages: outbound,
      provider,
      model: null,
      requestId: currentRequestId,
      mode,
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
    host.innerHTML = `<div class="as-welcome">Ask the Dev Assistant anything about your open project. With a folder open it knows the workspace — its tree, the active file and your selection — and can create or edit files for you (you approve each action). Tokens stream live. <b>Ctrl+Enter</b> to send, <b>Stop</b> to interrupt.</div>`;
    return;
  }
  // A small, inspectable chip showing the workspace context attached to the last turn.
  const chip = lastContext
    ? `<details class="as-context"><summary>🗂 workspace context attached — click to inspect</summary><pre>${esc(lastContext)}</pre></details>`
    : "";
  host.innerHTML =
    chip +
    messages
      .map((m, i) => {
        const streaming = busy && i === streamingIdx;
        const isDone = m.role === "assistant" && !streaming;
        const action = isDone ? parseAction(m.content) : null;
        const code = isDone ? parseCodeDirective(m.content) : null;
        // Hide the raw dxaction/dxcode JSON from the bubble; shown as a card instead.
        let shown = m.content;
        if (action) shown = shown.replace(/```dxaction\s*\n[\s\S]*?```/, "").trim();
        if (code) shown = shown.replace(/```dxcode\s*\n[\s\S]*?```/, "").trim();
        const body = esc(shown) + (streaming ? '<span class="as-cursor">▍</span>' : "");
        const err = actionErrors.get(i);
        let card = "";
        // Code tasks win over a bare folder action: the code is the point, and a dxcode
        // path creates any missing folders on its own.
        if (code) {
          const state = writeState.get(i);
          if (state === "writing") {
            card = `<div class="as-action"><div class="as-action-h">✍️ Writing <code>${esc(code.file)}</code> in the editor… <span class="as-spin"></span></div><div class="as-action-sub">Press <b>Stop</b> to interrupt — the code stays in the buffer.</div></div>`;
          } else if (state === "done") {
            const warn = shrinkWarn.has(i)
              ? `<div class="as-action-sub">⚠ The new file is much smaller than before — review it (Ctrl+Z to revert) in case the generation was partial.</div>`
              : "";
            card = `<div class="as-action done">✓ Wrote <code>${esc(code.file)}</code> in the editor — review, edit and save it.${warn}</div>`;
          } else {
            const abs = codeTargetAbs(code.file);
            const dirty = abs ? isDirty(abs) : false;
            card =
              `<div class="as-action"><div class="as-action-h">✍️ Write <code>${esc(code.file)}</code> directly in the editor</div>` +
              (dirty
                ? `<div class="as-action-sub">⚠ This file has unsaved changes — writing replaces them (undoable with Ctrl+Z).</div>`
                : "") +
              `<div class="as-action-btns"><button class="as-write" data-idx="${i}">Write in editor</button><button class="as-reject" data-idx="${i}">Dismiss</button></div>` +
              (err ? `<div class="as-action-err">⚠ ${esc(err)}</div>` : "") +
              `</div>`;
          }
        } else if (action) {
          if (appliedActions.has(i)) {
            card = `<div class="as-action done">✓ Applied: <b>${esc(action.op)}</b> <code>${esc(action.path)}</code></div>`;
          } else {
            card =
              `<div class="as-action"><div class="as-action-h">Proposed: <b>${esc(action.op)}</b> <code>${esc(action.path)}</code></div>` +
              `<div class="as-action-btns"><button class="as-apply" data-idx="${i}">Apply</button><button class="as-reject" data-idx="${i}">Dismiss</button></div>` +
              (err ? `<div class="as-action-err">⚠ ${esc(err)}</div>` : "") +
              `</div>`;
          }
        }
        return `<div class="as-msg ${m.role}"><div class="as-role">${m.role === "user" ? "You" : "Assistant"}</div><div class="as-body">${body || (streaming ? '<span class="as-cursor">▍</span>' : "")}</div>${card}</div>`;
      })
      .join("");
  host.scrollTop = host.scrollHeight;
}
