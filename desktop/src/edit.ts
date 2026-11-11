// "Edit with me" (P4, §6) — interruptible AI-assisted editing.
//
// A delegated edit streams a proposal into a diff view (left = the current file,
// right = the AI's proposal built live). The developer can PAUSE (stop incorporating
// new tokens), TAKE OVER (edit the right side by hand), CONTINUE FROM HERE (resume
// from the edited draft), and APPLY (write it back as one undoable edit, guarded
// against the file having changed meanwhile) or DISCARD. No fake slow-replay — the
// proposal grows only as real tokens arrive.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { monaco } from "./monaco";
import { selectedProvider } from "./assistant";
import { currentFileContent, replaceFileContent } from "./workspace";

const EDIT_SYSTEM =
  "You are a precise code editor. Apply the user's instruction to the file and return ONLY the complete, updated file inside a single fenced code block — no explanation, no partial snippets. Preserve all unrelated code byte-for-byte.";

type State = "idle" | "streaming" | "paused" | "done";

let diff: monaco.editor.IStandaloneDiffEditor | null = null;
let baseModel: monaco.editor.ITextModel | null = null;
let propModel: monaco.editor.ITextModel | null = null;
let reqId: string | null = null;
let raw = "";
let state: State = "idle";
let targetPath = "";
let baseContent = "";
let lang = "plaintext";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

export function initEdit(): void {
  $("#edit-close").addEventListener("click", discard);
  $("#edit-discard").addEventListener("click", discard);
  $("#edit-apply").addEventListener("click", () => void apply());
  $("#edit-generate").addEventListener("click", () => generate(instructionValue()));
  $("#edit-pause").addEventListener("click", togglePause);
  $("#edit-instruction").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") generate(instructionValue());
  });

  void listen<{ requestId: string; delta: string }>("llm://token", (e) => {
    if (e.payload.requestId === reqId) onToken(e.payload.delta);
  });
  void listen<{ requestId: string }>("llm://done", (e) => {
    if (e.payload.requestId === reqId) onDone();
  });
  void listen<{ requestId: string; error: string }>("llm://error", (e) => {
    if (e.payload.requestId === reqId) onError(e.payload.error);
  });
}

function ensureDiff(): void {
  if (diff) return;
  diff = monaco.editor.createDiffEditor($("#edit-diff"), {
    theme: "dxtutor-dark",
    automaticLayout: true,
    renderSideBySide: true,
    originalEditable: false, // left = current file (read-only)
    readOnly: false, // right = proposal (editable → "take over")
    fontSize: 12,
    minimap: { enabled: false },
  });
}

/** Open the Edit-with-me surface for `path`; the user types an instruction + Generate.
 *  `prefill` pre-populates the instruction box (e.g. from a review finding). */
export function startEdit(path: string, content: string, language: string, prefill?: string): void {
  targetPath = path;
  baseContent = content;
  lang = language || "plaintext";
  raw = "";
  reqId = null;
  state = "idle";
  $("#edit-overlay").classList.remove("hidden");
  $("#edit-file").textContent = path.split("/").pop() ?? path;
  ensureDiff();
  baseModel?.dispose();
  propModel?.dispose();
  baseModel = monaco.editor.createModel(content, lang);
  propModel = monaco.editor.createModel(content, lang);
  diff!.setModel({ original: baseModel, modified: propModel });
  setStatus();
  const instr = $("#edit-instruction") as HTMLInputElement;
  instr.value = prefill ?? "";
  instr.focus();
}

function instructionValue(): string {
  return ($("#edit-instruction") as HTMLInputElement).value.trim();
}

function generate(instruction: string): void {
  if (!instruction || state === "streaming" || !propModel) return;
  // Seed the proposal from the CURRENT draft (which may include the user's take-over),
  // so "Continue from here" resumes from their edits, not the original.
  const draft = propModel.getValue();
  raw = "";
  state = "streaming";
  setStatus();
  const messages = [
    { role: "system", content: EDIT_SYSTEM },
    {
      role: "user",
      content: `Instruction: ${instruction}\n\nReturn the COMPLETE updated file in one \`\`\` code block.\n\nFile (${lang}):\n\`\`\`${lang}\n${draft}\n\`\`\``,
    },
  ];
  reqId = crypto.randomUUID();
  void invoke("assistant_chat_stream", {
    messages,
    provider: selectedProvider(),
    model: null,
    requestId: reqId,
  }).catch((e) => onError(String(e)));
}

function onToken(delta: string): void {
  if (state !== "streaming" || !propModel) return;
  raw += delta;
  const code = extractCode(raw);
  if (code) propModel.setValue(code); // live diff as blocks arrive
}

function onDone(): void {
  if (state === "streaming" && propModel) {
    const code = extractCode(raw);
    if (code) propModel.setValue(code);
  }
  state = "done";
  setStatus();
}

function onError(err: string): void {
  state = "done";
  setStatus(err);
}

function togglePause(): void {
  if (state === "streaming") {
    // Pause: stop incorporating new tokens immediately; cancel the in-flight stream so
    // nothing arriving later can touch the paused proposal.
    state = "paused";
    if (reqId) void invoke("assistant_cancel", { requestId: reqId });
    reqId = null;
    setStatus();
  } else if (state === "paused") {
    // Continue from here: resume from the (possibly hand-edited) current draft.
    generate(instructionValue() || "Continue applying the previous instruction.");
  }
}

async function apply(): Promise<void> {
  if (!propModel) return;
  const proposed = propModel.getValue();
  // Base-version guard: if the file changed since we started, let the developer decide.
  const current = currentFileContent(targetPath) ?? baseContent;
  if (current !== baseContent) {
    if (!confirm("This file changed since the edit started. Apply anyway (overwriting those changes)?")) {
      return;
    }
  }
  await replaceFileContent(targetPath, proposed);
  discard();
}

function discard(): void {
  if (reqId) void invoke("assistant_cancel", { requestId: reqId });
  reqId = null;
  state = "idle";
  $("#edit-overlay").classList.add("hidden");
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Extract the code inside the first ``` fence, tolerating an unclosed (streaming) one. */
function extractCode(s: string): string {
  const i = s.indexOf("```");
  if (i < 0) return s; // no fence yet — show raw so the user sees progress
  const after = s.slice(i + 3);
  const nl = after.indexOf("\n");
  const body = nl >= 0 ? after.slice(nl + 1) : "";
  const close = body.indexOf("```");
  return close >= 0 ? body.slice(0, close) : body;
}

function setStatus(err?: string): void {
  const el = $("#edit-status");
  const pause = $("#edit-pause") as HTMLButtonElement;
  const apply = $("#edit-apply") as HTMLButtonElement;
  const gen = $("#edit-generate") as HTMLButtonElement;
  if (err) {
    el.textContent = `⚠ ${err}`;
    el.className = "edit-status err";
  } else {
    el.textContent = { idle: "", streaming: "streaming…", paused: "paused — take over, then Continue", done: "done" }[state];
    el.className = "edit-status " + state;
  }
  pause.disabled = state !== "streaming" && state !== "paused";
  pause.textContent = state === "paused" ? "Continue" : "Pause";
  apply.disabled = state === "idle";
  gen.disabled = state === "streaming";
}
