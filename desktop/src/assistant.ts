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
  beginRangeStream,
  currentFileContent,
  acceptRange,
  applyReviewedBlock,
  endEditorStream,
  endRangeStream,
  rangeStreamConflicted,
  enterRangeReview,
  isDirty,
  openFileAt,
  pushEditorStream,
  pushRangeStream,
  rangeStreamOriginal,
  rejectRange,
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

interface DxEdit {
  file: string;
  method: string;
  instruction: string;
}

interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  streaming: boolean;
  cancel: boolean;
  tools: boolean;
  context: boolean;
  note: string;
  models: string[];
}

let messages: ChatMsg[] = [];
let busy = false;

// ── Project focus ──────────────────────────────────────────────────────────
// The Agent pins its context to ONE project. In a multi-project workspace the user
// picks which one from the header selector; the grounding uses that project's path.
interface ProjectInfo {
  name: string;
  path: string;
  kind: string;
}
let projects: ProjectInfo[] = [];
let focusedProject: string | null = null; // path of the focused project, or null = whole root
const FOCUS_KEY = "dxtutor.assistant.focusedProject";
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
  // Typewriter pacing: `accum` fills at network speed, but the editor only reveals
  // `target` (= stripFences(accum)) up to `shown`, advanced on a timer, so the
  // developer can follow each line being written instead of a blink-fast dump.
  target: string;
  shown: number;
  done: boolean;
  timer: number | null;
} | null = null;
const writeState = new Map<number, "writing" | "done">(); // message idx -> code-stream state
const shrinkWarn = new Set<number>(); // done writes where the file shrank a lot (review it)
// Localized edit: a code stream scoped to ONE block/range in the editor (not a whole file).
let localStream: { requestId: string; path: string; idx: number; accum: string; prefix?: string } | null = null;
// Proposed localized edits awaiting the developer's Accept/Reject (keyed by message index).
interface DiffLine {
  op: "context" | "add" | "del";
  text: string;
}
const reviews = new Map<number, DiffLine[]>();
// Per-review set of accepted add/del line indices (default: all → "accept all").
const reviewSel = new Map<number, Set<number>>();

// Agent plan (observe→plan→act→verify): a titled checklist the Agent emits via `dxplan`,
// rendered as a live progress card. Steps advance as the Agent's actions complete.
interface Plan {
  title: string;
  steps: string[];
  current: number; // index of the running step (steps before it are done)
  done: boolean;
  autoRun: boolean; // when on, each completed step auto-drives the next (stoppable)
}
const plans = new Map<number, Plan>(); // message idx → plan
let activePlanIdx = -1;
// When a plan finishes its action steps, auto-run the verify step (project tests) — the
// "verify" of observe→plan→act→verify. Wired by main.ts to run_tests.
let onPlanComplete: () => void = () => {};
export function setPlanCompleteHandler(fn: () => void): void {
  onPlanComplete = fn;
}

/** Extract a `dxplan` directive ({title, steps[]}) from an assistant message, if valid. */
function parsePlanDirective(text: string): { title: string; steps: string[] } | null {
  const m = text.match(/```dxplan\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim());
    if (Array.isArray(obj.steps) && obj.steps.length) {
      return { title: typeof obj.title === "string" ? obj.title : "Plan", steps: obj.steps.map(String) };
    }
  } catch {
    /* malformed */
  }
  return null;
}

/** Advance the active plan one step (the current step is now done). */
function advancePlan(): void {
  const p = activePlanIdx >= 0 ? plans.get(activePlanIdx) : undefined;
  if (!p || p.done) return;
  p.current += 1;
  if (p.current >= p.steps.length) {
    p.done = true;
    renderMessages();
    onPlanComplete(); // all steps done → auto-verify (run the project tests)
    return;
  }
  renderMessages();
  if (p.autoRun) {
    // Multi-step orchestration: drive the next step automatically (bounded by step count,
    // stoppable). A short tick lets the completed action settle before the next prompt.
    setTimeout(() => void continuePlan(), 400);
  }
}

/** Orchestrate the next plan step: ask the Agent to perform the current (not-yet-done) step,
 *  grounded on the remaining plan. Bounded by the plan length; Stop cancels the stream. */
async function continuePlan(): Promise<void> {
  const p = activePlanIdx >= 0 ? plans.get(activePlanIdx) : undefined;
  if (!p || p.done || busy) return;
  const step = p.steps[p.current];
  const remaining = p.steps.slice(p.current).map((s, i) => `${p.current + i + 1}. ${s}`).join("\n");
  await sendText(
    `Continue the plan "${p.title}". Do ONLY this next step now:\n\n➡ ${step}\n\n` +
      `Remaining steps (for context, do not do them yet):\n${remaining}\n\n` +
      `Act through the IDE (dxcode/dxedit/dxcontinue/dxaction) — do not just describe it.`,
  );
}

/** Render the isolated-task result for message `i` (running / patch / error), if any. */
function taskCard(i: number): string {
  const t = tasks.get(i);
  if (!t) return "";
  if (t.status === "running") {
    return `<div class="as-task"><span class="as-spin"></span> Running in isolation (worktree of HEAD)…</div>`;
  }
  if (t.status === "error") {
    return `<div class="as-task err">⚠ Isolated task failed: ${esc(t.error)}</div>`;
  }
  const patch = t.patch.trim();
  return (
    `<div class="as-task done">✓ Ran in isolation — the working tree was not touched. Reviewed patch:</div>` +
    `<pre class="as-patch">${esc(patch || "(no changes)")}</pre>`
  );
}

/** Render the plan progress card (title · N/M · step checklist), Antigravity-CLI style. */
function planCard(p: Plan): string {
  const total = p.steps.length;
  const doneN = p.done ? total : p.current;
  const pct = Math.round((doneN / total) * 100);
  const rows = p.steps
    .map((s, i) => {
      const state = p.done || i < p.current ? "done" : i === p.current ? "run" : "todo";
      const glyph = state === "done" ? "✓" : state === "run" ? "▶" : "·";
      return `<div class="as-plan-step ${state}"><span class="as-plan-glyph">${glyph}</span><span class="as-plan-label">${esc(s)}</span></div>`;
    })
    .join("");
  // Orchestration controls: when the plan has steps left and nothing is streaming, offer to
  // drive the next step (Continue →) or toggle autonomous run (each step drives the next).
  const idx = activePlanIdx;
  const controls =
    !p.done && idx >= 0 && plans.get(idx) === p
      ? `<div class="as-plan-ctl">` +
        (busy
          ? `<span class="as-plan-run">running step ${p.current + 1}…</span>` +
            `<button class="as-plan-pause" data-idx="${idx}" title="Pausar ao fim do passo (p)"><kbd>p</kbd> pausar</button>` +
            `<button class="as-plan-stop" data-idx="${idx}" title="Parar agora (x)"><kbd>x</kbd> parar</button>`
          : `<button class="as-plan-next" data-idx="${idx}">Continue →</button>`) +
        `<label class="as-plan-auto"><input type="checkbox" class="as-plan-autock" data-idx="${idx}" ${p.autoRun ? "checked" : ""}/> Auto</label>` +
        `</div>`
      : "";
  return (
    `<div class="as-plan"><div class="as-plan-h"><span class="as-plan-title">${esc(p.title)}</span>` +
    `<span class="as-plan-count">${doneN}/${total}${p.done ? " ✓" : ""}</span></div>` +
    `<div class="as-plan-bar"><span style="width:${pct}%"></span></div>${rows}${controls}</div>`
  );
}

/** Build the block text from a diff, keeping only the accepted changes: context stays;
 *  an added line is kept iff selected; a deleted line is kept (i.e. NOT removed) iff its
 *  deletion is NOT selected. */
function buildSelectedBlock(diff: DiffLine[], sel: Set<number>): string {
  const out: string[] = [];
  diff.forEach((l, k) => {
    if (l.op === "context") out.push(l.text);
    else if (l.op === "add") {
      if (sel.has(k)) out.push(l.text);
    } else if (!sel.has(k)) {
      out.push(l.text); // unselected deletion → keep the original line
    }
  });
  return out.join("\n");
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function initAssistant(): void {
  $("#assistant-close").addEventListener("click", () => {
    $("#assistant-overlay").classList.add("hidden");
    document.getElementById("body")?.classList.remove("dock-open"); // free the editor column
  });

  // The developer decided the pending change from the INLINE editor widget (Codex-style).
  // acceptRange/rejectRange already ran; here we just retire the matching review card in the
  // panel and note the outcome on its message, so the two surfaces stay in sync.
  window.addEventListener("dx:range-reviewed", (e) => {
    if (!reviews.size && !reviewSel.size) return;
    const kind = (e as CustomEvent<{ kind: "accept" | "reject" }>).detail?.kind;
    const note = kind === "reject" ? " — ✗ rejected (inline)." : " — ✓ accepted (inline).";
    for (const idx of reviews.keys()) if (messages[idx]) messages[idx].content += note;
    reviews.clear();
    reviewSel.clear();
    renderMessages();
  });

  // Running bar "Parar": cancel the in-flight stream (same as the Send→Stop button).
  document.getElementById("ar-stop")?.addEventListener("click", () => {
    if (currentRequestId) void invoke("assistant_cancel", { requestId: currentRequestId });
  });

  // Restore dock mode + width. First use (no saved preference) DOCKS the Agent by default,
  // VSCode/Antigravity-style; a saved choice wins afterwards (RF-UI-01).
  const dockPref = localStorage.getItem("dx.assistant.docked");
  docked = dockPref === null ? true : dockPref === "1";
  const savedW = Number(localStorage.getItem("dx.assistant.dockw"));
  if (Number.isFinite(savedW) && savedW > 0) setDockWidth(savedW);
  $("#assistant-dock").addEventListener("click", () => {
    docked = !docked;
    localStorage.setItem("dx.assistant.docked", docked ? "1" : "0");
    syncDock();
  });
  (() => {
    const handle = document.getElementById("assistant-resizer");
    if (!handle) return;
    let startX = 0;
    let startW = 0;
    const onMove = (e: PointerEvent) => setDockWidth(startW + (startX - e.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const w = getComputedStyle(document.documentElement).getPropertyValue("--dock-w").trim();
      if (w) localStorage.setItem("dx.assistant.dockw", String(parseInt(w, 10)));
    };
    handle.addEventListener("pointerdown", (e) => {
      startX = e.clientX;
      startW = $("#assistant-overlay").getBoundingClientRect().width;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      e.preventDefault();
    });
  })();
  // Project focus: switch which project the Agent grounds on (multi-project workspace).
  $("#assistant-project").addEventListener("change", (e) => {
    focusedProject = (e.target as HTMLSelectElement).value || null;
    if (focusedProject) localStorage.setItem(FOCUS_KEY, focusedProject);
    updateContextHint();
  });

  // New chat archives the current session to history first, then clears.
  $("#assistant-new").addEventListener("click", newChat);
  // Chat history: toggle the dropdown; restore or delete an entry.
  $("#assistant-history").addEventListener("click", toggleHistory);
  $("#assistant-history-panel").addEventListener("click", (e) => {
    const del = (e.target as HTMLElement).closest("[data-del]") as HTMLElement | null;
    if (del) {
      e.stopPropagation();
      saveHistory(loadHistory().filter((x) => x.id !== del.dataset.del));
      renderHistory();
      return;
    }
    const item = (e.target as HTMLElement).closest(".as-hist-item") as HTMLElement | null;
    if (item?.dataset.id) restoreChat(item.dataset.id);
  });
  // Approve / dismiss a proposed workspace action (event delegation on the message list).
  $("#assistant-messages").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (Number.isNaN(idx)) return;
    if (btn.classList.contains("as-apply")) void applyAction(idx);
    else if (btn.classList.contains("as-write")) void startCodeStream(idx);
    else if (btn.classList.contains("as-plan-next")) void continuePlan(); // drive the next step
    else if (btn.classList.contains("as-plan-pause")) {
      const p = plans.get(idx); // pausar: desliga o auto-run (pára ao fim do passo actual)
      if (p) { p.autoRun = false; renderMessages(); }
    } else if (btn.classList.contains("as-plan-stop")) {
      if (currentRequestId) void invoke("assistant_cancel", { requestId: currentRequestId }); // parar agora
      const p = plans.get(idx);
      if (p) p.autoRun = false;
    }
    else if (btn.classList.contains("as-isolate")) void runInIsolation(idx); // isolated worktree → patch
    else if (btn.classList.contains("as-accept-all")) {
      acceptRange(); // keep the full proposal (already in the buffer; one undo step)
      reviews.delete(idx);
      reviewSel.delete(idx);
      messages[idx].content += " — ✓ accepted all.";
      renderMessages();
    } else if (btn.classList.contains("as-accept-sel")) {
      const diff = reviews.get(idx);
      const sel = reviewSel.get(idx);
      if (diff && sel) applyReviewedBlock(buildSelectedBlock(diff, sel)); // apply only ticked changes
      reviews.delete(idx);
      reviewSel.delete(idx);
      messages[idx].content += " — ✓ accepted selected lines.";
      renderMessages();
    } else if (btn.classList.contains("as-revreject")) {
      rejectRange(); // restore the original block
      reviews.delete(idx);
      reviewSel.delete(idx);
      messages[idx].content += " — ✗ rejected (original restored).";
      renderMessages();
    } else if (btn.classList.contains("as-reject")) {
      // Mark as handled so the card disappears: strip the directive from the message.
      messages[idx].content = messages[idx].content
        .replace(/```dxaction\s*\n[\s\S]*?```/, "")
        .replace(/```dxcode\s*\n[\s\S]*?```/, "")
        .trim();
      actionErrors.delete(idx);
      renderMessages();
    }
  });
  // Toggle a diff line's acceptance (review checkboxes) or the plan's Auto-run.
  $("#assistant-messages").addEventListener("change", (e) => {
    const ck = e.target as HTMLInputElement;
    if (ck.classList.contains("as-plan-autock")) {
      const p = plans.get(Number(ck.dataset.idx));
      if (p) {
        p.autoRun = ck.checked;
        if (p.autoRun && !p.done && !busy) void continuePlan(); // turning Auto on drives now
      }
      return;
    }
    if (!ck.classList.contains("dl-ck")) return;
    const idx = Number(ck.dataset.idx);
    const k = Number(ck.dataset.k);
    const sel = reviewSel.get(idx);
    if (!sel) return;
    if (ck.checked) sel.add(k);
    else sel.delete(k);
  });
  // Atalhos do agente em execução (estilo TUI): p = pausar (auto-run off), x = parar (cancelar).
  // Só disparam com um stream activo e fora de campos de texto, para não colidir com a escrita.
  document.addEventListener("keydown", (e) => {
    if (!busy) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "p") {
      const p = activePlanIdx >= 0 ? plans.get(activePlanIdx) : undefined;
      if (p) { p.autoRun = false; renderMessages(); }
    } else if (e.key === "x") {
      if (currentRequestId) void invoke("assistant_cancel", { requestId: currentRequestId });
    }
  });
  // One button: Send while idle, Stop (cancel) while a stream is running.
  $("#assistant-send").addEventListener("click", () => {
    if (busy && currentRequestId) {
      const p = activePlanIdx >= 0 ? plans.get(activePlanIdx) : undefined;
      if (p) p.autoRun = false; // Stop also halts autonomous plan driving
      void invoke("assistant_cancel", { requestId: currentRequestId });
    } else void send();
  });
  const ta = $("#assistant-input") as HTMLTextAreaElement;
  ta.addEventListener("input", () => syncTemplateMenu());
  ta.addEventListener("keydown", (e) => {
    const menu = document.getElementById("assistant-templates");
    const menuOpen = menu && !menu.classList.contains("hidden");
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveTemplate(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveTemplate(-1);
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        applyTemplate(templateSel);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideTemplates();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        applyTemplate(templateSel);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!busy) void send();
    }
  });
  $("#assistant-templates").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".as-tpl") as HTMLElement | null;
    if (row) applyTemplate(Number(row.dataset.i));
  });
  $("#assistant-provider").addEventListener("change", (e) => {
    provider = (e.target as HTMLSelectElement).value;
    updateModelLabel();
  });
  // The Agent gear opens the UNIFIED Settings at its AI section (RF-UI-03); main.ts wires
  // the handler. Falls back to the providers surface if none is registered.
  $("#assistant-settings").addEventListener("click", () => settingsHandler());
  $("#settings-open-providers").addEventListener("click", () => void openProviders());
  $("#providers-close").addEventListener("click", () => $("#providers-overlay").classList.add("hidden"));
  $("#providers-save").addEventListener("click", () => void saveProviders());

  // Live token stream from the backend. Tokens route to the EDITOR during a code stream
  // (Dev delegate), or to the chat bubble otherwise.
  void listen<{ requestId: string; delta: string }>("llm://token", (e) => {
    if (localStream && e.payload.requestId === localStream.requestId) {
      localStream.accum += e.payload.delta;
      // prefix keeps existing content when APPENDING (continue), empty when replacing a block.
      const applied = pushRangeStream((localStream.prefix ?? "") + stripFences(localStream.accum));
      if (!applied && rangeStreamConflicted()) {
        // The dev edited the buffer mid-stream — stop clobbering it, keep their change.
        const rid = localStream.requestId;
        void invoke("assistant_cancel", { requestId: rid });
        messages.push({
          role: "assistant",
          content: "✋ You edited the file while I was writing, so I stopped — your change is kept. Re-run the edit if you still want it.",
        });
        localStream = null;
        endRangeStream();
        finishStream();
        renderMessages();
      }
      return;
    }
    if (codeStream && e.payload.requestId === codeStream.requestId) {
      codeStream.accum += e.payload.delta;
      codeStream.target = stripFences(codeStream.accum);
      paceCodeStream(); // reveal progressively — decoupled from arrival speed
      return;
    }
    if (e.payload.requestId !== currentRequestId || streamingIdx < 0) return;
    messages[streamingIdx].content += e.payload.delta;
    renderMessages();
  });
  void listen<{ requestId: string }>("llm://done", (e) => {
    if (localStream && e.payload.requestId === localStream.requestId) {
      const ls = localStream;
      const produced = stripFences(ls.accum).trim();
      if (!produced) {
        pushRangeStream(rangeStreamOriginal()); // nothing usable — restore the block
        endRangeStream();
        messages[ls.idx].content += " — ⚠ no replacement; block left unchanged.";
        writeState.delete(ls.idx);
      } else {
        // Enter REVIEW: keep the proposed block highlighted, show the diff, and let the
        // developer Accept or Reject it.
        const info = enterRangeReview();
        writeState.delete(ls.idx);
        advancePlan(); // an edit/continue step completed
        if (info) {
          void invoke<DiffLine[]>("diff_lines", { old: info.original, new: info.proposed })
            .then((d) => {
              reviews.set(ls.idx, d);
              // Default: every change accepted (so "Accept selected" with all ticked = accept all).
              const sel = new Set<number>();
              d.forEach((l, k) => {
                if (l.op !== "context") sel.add(k);
              });
              reviewSel.set(ls.idx, sel);
              renderMessages();
            })
            .catch(() => {});
          messages[ls.idx].content += " — review the change below:";
        }
      }
      localStream = null;
      finishStream();
      return;
    }
    if (codeStream && e.payload.requestId === codeStream.requestId) {
      // Stream finished arriving; let the typewriter reveal the remaining buffered
      // text (bounded lag), then finalize via paceCodeStream → finalizeCodeStream.
      codeStream.done = true;
      codeStream.target = stripFences(codeStream.accum);
      paceCodeStream();
      return;
    }
    if (e.payload.requestId === currentRequestId) {
      const idx = streamingIdx; // the assistant message that just completed
      finishStream();
      // Dev delegate: as soon as the plan is in and it carries a dxcode, start writing the
      // code live into the editor — no extra click. Stop / Ctrl+Z keep the developer in
      // control. EXCEPTION: if the target file has unsaved edits, don't silently overwrite
      // them — fall through to the button so the developer decides.
      if (idx < 0 || writeState.has(idx)) return;
      // A plan sets up the execution checklist; later actions tick its steps.
      const plan = parsePlanDirective(messages[idx]?.content ?? "");
      if (plan) {
        // Carry the Auto preference across re-planning within the same run.
        const autoRun = activePlanIdx >= 0 ? (plans.get(activePlanIdx)?.autoRun ?? false) : false;
        plans.set(idx, { title: plan.title, steps: plan.steps, current: 0, done: false, autoRun });
        activePlanIdx = idx;
        renderMessages();
        if (autoRun) setTimeout(() => void continuePlan(), 400); // auto-drive step 1
      }
      // Continue/complete an existing file (append) — for "continue where it stopped".
      const cont = parseContinueDirective(messages[idx]?.content ?? "");
      if (cont) {
        const absC = codeTargetAbs(cont.file);
        if (absC) void startContinue(absC, cont.instruction);
        return;
      }
      // Localized edit (modify one method) takes precedence over a whole-file write.
      const de = parseEditDirective(messages[idx]?.content ?? "");
      if (de) {
        void startChatMethodEdit(idx);
        return;
      }
      const dc = parseCodeDirective(messages[idx]?.content ?? "");
      const abs = dc ? codeTargetAbs(dc.file) : null;
      if (dc && !(abs && isDirty(abs))) {
        void startCodeStream(idx);
      }
    }
  });
  void listen<{ requestId: string; error: string }>("llm://error", (e) => {
    if (localStream && e.payload.requestId === localStream.requestId) {
      pushRangeStream(rangeStreamOriginal()); // restore the block on a mid-stream failure
      endRangeStream();
      messages[localStream.idx].content += ` — ⚠ ${e.payload.error}`;
      writeState.delete(localStream.idx);
      localStream = null;
      finishStream();
      return;
    }
    if (codeStream && e.payload.requestId === codeStream.requestId) {
      // A mid-stream provider failure must not leave a partial/empty buffer — restore the
      // file to what it was before the generation started.
      if (codeStream.timer != null) window.clearInterval(codeStream.timer); // stop the typewriter
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

  setStreaming(false); // render the circular send arrow at rest
}

/** Where the Agent gear opens (unified Settings @ AI section). Wired by main.ts. */
let settingsHandler: () => void = () => void openProviders();
export function setSettingsHandler(fn: () => void): void {
  settingsHandler = fn;
}

/** The active-model label text, so Settings can mirror it in its AI section. */
export function activeModelLabel(): string {
  return document.getElementById("assistant-model")?.textContent ?? "—";
}

export function openAssistant(): void {
  $("#review-overlay")?.classList.add("hidden"); // the two right drawers are exclusive
  $("#assistant-overlay").classList.remove("hidden");
  syncDock();
  renderMessages();
  void refreshModel();
  void refreshProjects(); // pin context to the open project(s) as soon as the Agent opens
  ($("#assistant-input") as HTMLTextAreaElement).focus();
}

/** Discover the projects in the open workspace and populate the focus selector. Auto-pins
 *  the only project; shows the selector (to choose focus) when there is more than one. */
async function refreshProjects(): Promise<void> {
  const sel = document.getElementById("assistant-project") as HTMLSelectElement | null;
  const root = workspaceRoot();
  if (!sel) return;
  if (!root) {
    projects = [];
    focusedProject = null;
    sel.classList.add("hidden");
    updateContextHint();
    return;
  }
  try {
    projects = await invoke<ProjectInfo[]>("detect_projects", { root });
  } catch {
    projects = [];
  }
  const saved = localStorage.getItem(FOCUS_KEY);
  // Keep the saved focus if it is still a detected project; else default to the first.
  focusedProject =
    (saved && projects.some((p) => p.path === saved) && saved) ||
    (projects.length ? projects[0].path : null);
  // The selector only appears when there's a real choice; the label always shows the focus.
  if (projects.length > 1) {
    sel.innerHTML = projects
      .map(
        (p) =>
          `<option value="${esc(p.path)}"${p.path === focusedProject ? " selected" : ""}>${esc(p.name)} · ${esc(p.kind)}</option>`,
      )
      .join("");
    sel.classList.remove("hidden");
  } else {
    sel.classList.add("hidden");
  }
  updateContextHint();
}

/** The effective root the Agent grounds on: the focused project, else the workspace root. */
function focusRoot(): string | null {
  return focusedProject ?? workspaceRoot();
}

/** Reflect the focused project in the input placeholder, so the dev sees the Agent's focus. */
function updateContextHint(): void {
  const input = document.getElementById("assistant-input") as HTMLTextAreaElement | null;
  const label = document.getElementById("assistant-project-label");
  const p = projects.find((x) => x.path === focusedProject);
  if (input) {
    input.placeholder = p
      ? `Ask about ${p.name}… — / for templates`
      : "Ask anything — / for prompt templates…";
  }
  if (label) {
    const name = p?.name ?? workspaceRoot()?.split(/[\\/]/).filter(Boolean).pop() ?? "";
    label.textContent = name;
    label.classList.toggle("hidden", !name);
  }
}

// ── Guided prompt templates ("/") ──────────────────────────────────────────
// The developer stays in charge: templates scaffold a precise, well-engineered prompt
// with <PLACEHOLDERS> for them to fill, so the Agent assists an intent the dev defines
// (rather than inventing scope). The <…> gaps are filled by the dev; the project context
// (AG-1) supplies the rest.
interface PromptTemplate {
  cmd: string;
  label: string;
  body: string;
}
const TEMPLATES: PromptTemplate[] = [
  {
    cmd: "/implement",
    label: "Implement a feature",
    body: "Implement <WHAT> in <FILE>.\nBehaviour: <WHAT IT SHOULD DO>.\nConstraints: <STYLE / DEPENDENCIES / LIMITS>.\nAcceptance: <HOW I'LL VERIFY IT>.",
  },
  {
    cmd: "/fix",
    label: "Fix a bug",
    body: "Fix <BUG> in <FILE OR METHOD>.\nSymptom: <WHAT GOES WRONG>.\nExpected: <WHAT SHOULD HAPPEN>.\nKeep the change minimal and localized.",
  },
  {
    cmd: "/refactor",
    label: "Refactor safely",
    body: "Refactor <TARGET> in <FILE> to <GOAL>.\nPreserve behaviour; do not change the public API.\nExplain the trade-off in 1–2 lines before the change.",
  },
  {
    cmd: "/explain",
    label: "Explain code",
    body: "Explain <WHAT> in <FILE>.\nFocus on: <ASPECT — control flow / types / edge cases>.\nUse the real symbols from this project.",
  },
  {
    cmd: "/test",
    label: "Write tests",
    body: "Write tests for <TARGET> in <FILE>.\nCover: <CASES — happy path / edge / error>.\nUse the project's existing test style/framework.",
  },
  {
    cmd: "/review",
    label: "Review a change",
    body: "Review <FILE OR SELECTION> for <CONCERN — correctness / performance / safety>.\nList concrete issues with file:line and a suggested fix each.",
  },
];
let templateSel = 0;
let templateShown: PromptTemplate[] = [];

function syncTemplateMenu(): void {
  const ta = $("#assistant-input") as HTMLTextAreaElement;
  const v = ta.value;
  // Only a leading "/" command (no spaces/newlines yet) opens the menu.
  const m = /^\/(\w*)$/.exec(v);
  if (!m) {
    hideTemplates();
    return;
  }
  const q = m[1].toLowerCase();
  templateShown = TEMPLATES.filter((t) => t.cmd.slice(1).startsWith(q));
  if (templateShown.length === 0) {
    hideTemplates();
    return;
  }
  templateSel = 0;
  renderTemplates();
}

function renderTemplates(): void {
  const menu = $("#assistant-templates");
  menu.innerHTML = templateShown
    .map(
      (t, i) =>
        `<div class="as-tpl${i === templateSel ? " sel" : ""}" data-i="${i}" role="option"><span class="as-tpl-cmd">${esc(t.cmd)}</span><span class="as-tpl-label">${esc(t.label)}</span></div>`,
    )
    .join("");
  menu.classList.remove("hidden");
}

function moveTemplate(d: number): void {
  if (templateShown.length === 0) return;
  templateSel = (templateSel + d + templateShown.length) % templateShown.length;
  renderTemplates();
}

function hideTemplates(): void {
  document.getElementById("assistant-templates")?.classList.add("hidden");
}

/** Insert the chosen scaffold and place the caret on the first <PLACEHOLDER>. */
function applyTemplate(i: number): void {
  const t = templateShown[i];
  if (!t) return;
  const ta = $("#assistant-input") as HTMLTextAreaElement;
  ta.value = t.body;
  hideTemplates();
  const first = t.body.indexOf("<");
  const end = t.body.indexOf(">", first);
  ta.focus();
  if (first >= 0 && end >= 0) ta.setSelectionRange(first, end + 1);
  else ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ── Docking (Antigravity style) ───────────────────────────────────────────
// Floating = overlay with a shadow; docked = reserves a right column so the
// editor reflows beside it (Monaco's automaticLayout handles the reflow).
let docked = false;
const DOCK_MIN = 320;
function dockMax(): number {
  return Math.min(760, Math.round(window.innerWidth * 0.92));
}
function setDockWidth(px: number): void {
  const w = Math.max(DOCK_MIN, Math.min(dockMax(), Math.round(px)));
  document.documentElement.style.setProperty("--dock-w", `${w}px`);
}
/** Reconcile DOM with the current dock mode + open state. */
function syncDock(): void {
  const drawer = $("#assistant-overlay");
  const open = !drawer.classList.contains("hidden");
  drawer.classList.toggle("docked", docked);
  document.getElementById("assistant-dock")?.classList.toggle("is-docked", docked);
  document.getElementById("body")?.classList.toggle("dock-open", docked && open);
}

// ── Chat history (Agent-panel style) ──────────────────────────────────────
// Past chats are archived to localStorage when a new chat starts, and can be
// restored or deleted from the history dropdown.
interface ChatHistoryEntry {
  id: string;
  title: string;
  ts: number;
  messages: ChatMsg[];
}
const HIST_KEY = "dxtutor.assistant.history";
const HIST_MAX = 25;
function loadHistory(): ChatHistoryEntry[] {
  try {
    const a = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]");
    return Array.isArray(a) ? (a as ChatHistoryEntry[]) : [];
  } catch {
    return [];
  }
}
function saveHistory(h: ChatHistoryEntry[]): void {
  localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, HIST_MAX)));
}
/** Archive the current session (unless it's empty / system-only). */
function archiveCurrent(): void {
  if (messages.filter((m) => m.role !== "system").length === 0) return;
  const firstUser = messages.find((m) => m.role === "user")?.content.trim() ?? "";
  const title = (firstUser.split("\n")[0] || "Conversa").slice(0, 60);
  const h = loadHistory();
  h.unshift({ id: `c${Date.now()}`, title, ts: Date.now(), messages: [...messages] });
  saveHistory(h);
}
function clearSession(): void {
  messages = [];
  lastContext = null;
  appliedActions.clear();
  actionErrors.clear();
  writeState.clear();
  shrinkWarn.clear();
  reviews.clear();
  reviewSel.clear();
  renderMessages();
}
function newChat(): void {
  if (busy) return;
  archiveCurrent();
  clearSession();
  hideHistory();
}
function restoreChat(id: string): void {
  if (busy) return;
  const h = loadHistory();
  const i = h.findIndex((e) => e.id === id);
  if (i < 0) return;
  archiveCurrent(); // keep the chat being replaced
  const [entry] = h.splice(i, 1);
  saveHistory(h);
  clearSession();
  messages = [...entry.messages];
  renderMessages();
  hideHistory();
}
function renderHistory(): void {
  const panel = document.getElementById("assistant-history-panel");
  if (!panel) return;
  const h = loadHistory();
  panel.innerHTML = h.length
    ? h
        .map(
          (e) =>
            `<button class="as-hist-item" data-id="${e.id}"><span class="as-hist-title">${esc(e.title)}</span><span class="as-hist-del" data-del="${e.id}" title="Delete">&times;</span></button>`,
        )
        .join("")
    : `<div class="as-hist-empty">No past chats yet.</div>`;
}
function toggleHistory(): void {
  const panel = document.getElementById("assistant-history-panel");
  if (!panel) return;
  if (panel.classList.contains("hidden")) {
    renderHistory();
    panel.classList.remove("hidden");
  } else {
    panel.classList.add("hidden");
  }
}
function hideHistory(): void {
  document.getElementById("assistant-history-panel")?.classList.add("hidden");
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

/** Honest capability matrix per provider (RF-AG-06): streaming / cancel / tools / context. */
function renderCapabilityMatrix(providers: ProviderInfo[]): void {
  const host = document.getElementById("providers-caps");
  if (!host) return;
  const tick = (b: boolean) => (b ? '<span class="cap-yes">✓</span>' : '<span class="cap-no">·</span>');
  host.innerHTML =
    `<table class="caps-table"><thead><tr><th>Provider</th><th title="Live token stream">stream</th>` +
    `<th title="Stop an in-flight request">cancel</th><th title="Structured edit/action protocol">tools</th>` +
    `<th title="Workspace grounding sent">context</th><th></th></tr></thead><tbody>` +
    providers
      .map(
        (p) =>
          `<tr class="${p.available ? "" : "cap-off"}"><td>${esc(p.name)}</td><td>${tick(p.streaming)}</td>` +
          `<td>${tick(p.cancel)}</td><td>${tick(p.tools)}</td><td>${tick(p.context)}</td>` +
          `<td class="cap-note">${esc(p.available ? "ready" : "set key")}</td></tr>`,
      )
      .join("") +
    "</tbody></table>";
}

async function openProviders(): Promise<void> {
  // Populate the default-provider dropdown from the live provider list.
  try {
    const providers = await invoke<ProviderInfo[]>("list_providers");
    (($("#cfg-provider") as HTMLSelectElement).innerHTML = providers
      .map((p) => `<option value="${p.id}">${p.name}</option>`)
      .join(""));
    renderCapabilityMatrix(providers);
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
  const wsRoot = workspaceRoot();
  if (!wsRoot) return null;
  // Ground on the FOCUSED project when the workspace holds several — the Agent stays
  // aligned to the project the developer picked, not the whole folder.
  const root = focusRoot() ?? wsRoot;
  const focus = projects.find((p) => p.path === focusedProject);
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
      `not a generic chatbot. You ASSIST the developer: they decide what to build; you ` +
      `help them do it. Do not invent scope — ground every answer in THIS real project, by ` +
      `its actual paths, and stay within the focused project below.`,
    focus
      ? `Focused project: ${focus.name} (${focus.kind}) at ${focus.path}. Keep ALL paths relative to this project root and do not touch files outside it.`
      : "",
    `Project root: ${root}`,
    wsRoot !== root ? `(Workspace folder: ${wsRoot})` : "",
    active ? `Active file: ${active}` : `No file is currently open.`,
    sel ? `Selected code:\n${sel.slice(0, 2000)}` : "",
    bodyBlock,
    `Project tree (depth-limited, build/VCS dirs skipped):\n${tree}`,
    `You act through the IDE, never with OS shell instructions (no mkdir / PowerShell / ` +
      `Python). You have three action blocks. Choose by what the task does:`,
    `• To MODIFY an EXISTING function/method in a file (e.g. "improve the pow fn", "make ` +
      `this method faster", "fix the bug in parse"), reply with a SHORT plan (1–3 lines) then ` +
      `EXACTLY ONE:\n` +
      "```dxedit\n" +
      `{"file":"<path relative to root>","method":"<the fn/method name>","instruction":"<what to change>"}\n` +
      "```\n" +
      `This edits ONLY that method — it streams a replacement into just that block, leaving ` +
      `the rest of the file untouched. PREFER dxedit whenever you are changing existing code: ` +
      `do NOT rewrite the whole file. (dxedit resolves the method by name in the file.)`,
    `• To create a NEW file or do a FULL rewrite, reply with a SHORT plan (1–3 lines) then ` +
      `EXACTLY ONE fenced block:\n` +
      "```dxcode\n" +
      `{"file":"<path relative to the workspace root>","language":"rust","instruction":"<precise, self-contained description of the full file to generate>"}\n` +
      "```\n" +
      `The \`file\` path MAY include folders that do not exist yet (e.g. ` +
      `"examples/dxtutor/main.rs") — they are created automatically. The code streams LIVE ` +
      `into that editor tab. NEVER paste the code in the chat and NEVER say you "will" create ` +
      `it later — emit the block now. Use dxcode only for a NEW file or a deliberate full ` +
      `rewrite; to change one method, use dxedit.`,
    `• For a MULTI-STEP task (several files or edits), FIRST emit a plan so the user sees ` +
      `the whole execution, then carry it out step by step:\n` +
      "```dxplan\n" +
      `{"title":"<short goal>","steps":["<step 1>","<step 2>","…"]}\n` +
      "```\n" +
      `The UI renders it as a live checklist and ticks each step as your following actions ` +
      `(dxcode/dxedit/dxcontinue) complete. Use a plan only when there IS more than one step.`,
    `• To CONTINUE or COMPLETE an existing, unfinished file (the user says "continue", ` +
      `"finish", "complete", "it's incomplete") WITHOUT rewriting it, reply with a SHORT note ` +
      `then EXACTLY ONE:\n` +
      "```dxcontinue\n" +
      `{"file":"<path relative to root>","instruction":"<what to finish>"}\n` +
      "```\n" +
      `This APPENDS the generated continuation at the end of the file — it never repeats or ` +
      `rewrites the existing code. PREFER dxcontinue over dxcode when the file already has ` +
      `content and only needs to be finished.`,
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

/** Extract the first dxcontinue directive (append/complete a file), if valid. */
function parseContinueDirective(text: string): { file: string; instruction: string } | null {
  const m = text.match(/```dxcontinue\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim());
    if (typeof obj.file === "string") {
      return { file: obj.file, instruction: typeof obj.instruction === "string" ? obj.instruction : "continue the file" };
    }
  } catch {
    /* malformed */
  }
  return null;
}

/** Extract the first dxedit directive (modify one method), if valid. */
function parseEditDirective(text: string): DxEdit | null {
  const m = text.match(/```dxedit\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim());
    if (typeof obj.file === "string" && typeof obj.method === "string" && typeof obj.instruction === "string") {
      return obj as DxEdit;
    }
  } catch {
    /* not valid JSON */
  }
  return null;
}

/** Chat → localized edit: open the target file, resolve the method's range via
 *  symbol_ranges, and stream a replacement into ONLY that method (no whole-file rewrite). */
async function startChatMethodEdit(idx: number): Promise<void> {
  const dir = parseEditDirective(messages[idx]?.content ?? "");
  const root = workspaceRoot();
  if (!dir || !root) return;
  const abs = codeTargetAbs(dir.file)!;
  // Open the file so we have its live content, then resolve the method range.
  await openFileAt(abs, 1, 1);
  const code = currentFileContent(abs);
  if (code == null) {
    messages[idx].content += ` — ⚠ could not open ${dir.file}`;
    renderMessages();
    return;
  }
  let ranges: SymbolRange[] = [];
  try {
    ranges = await invoke<SymbolRange[]>("symbol_ranges", { code, name: dir.method });
  } catch {
    ranges = [];
  }
  if (ranges.length === 0) {
    // The method isn't there (often because the file is INCOMPLETE and doesn't parse yet).
    // Don't give up — continue/complete the file by appending from where it stops.
    messages[idx].content += ` — \`${dir.method}\` not found; continuing the file instead.`;
    renderMessages();
    await startContinue(abs, `${dir.instruction} (continue \`${dir.method}\` / complete the file)`);
    return;
  }
  const t = ranges[0]; // chat path targets the first match (editor actions disambiguate)
  const lang = abs.endsWith(".rs") ? "rust" : "plaintext";
  const selected = code.split("\n").slice(t.startLine - 1, t.endLine).join("\n");
  await startLocalizedEdit(abs, t.startLine, t.endLine, selected, lang, dir.instruction);
}

/** Continue/complete a file by APPENDING the generated continuation at its end — never
 *  rewriting existing code. Used when the dev asks to "continue where it stopped" or when a
 *  method edit can't find its target (incomplete file). Streams live into the buffer. */
export async function startContinue(path: string, instruction: string): Promise<void> {
  if (busy) return;
  await openFileAt(path, 1, 1);
  const code = currentFileContent(path);
  if (code == null) return;
  const rel = path.split("/").pop() ?? path;
  const lang = path.endsWith(".rs") ? "rust" : path.endsWith(".py") ? "python" : path.endsWith(".go") ? "go" : "plaintext";
  const lines = code.split("\n");
  const lastLine = Math.max(1, lines.length);
  const lastText = lines[lastLine - 1] ?? "";

  openAssistant();
  const idx = messages.push({ role: "assistant", content: `➕ Continuing \`${rel}\` from where it stops…` }) - 1;
  writeState.set(idx, "writing");
  renderMessages();

  const ok = await beginRangeStream(path, lastLine, lastLine);
  if (!ok) {
    actionErrors.set(idx, "could not open the file to continue");
    writeState.delete(idx);
    renderMessages();
    return;
  }
  const rid = crypto.randomUUID();
  // The block is the last line; prefix keeps it and a newline, so tokens APPEND after it.
  localStream = { requestId: rid, path, idx, accum: "", prefix: lastText.length ? `${lastText}\n` : "" };
  busy = true;
  currentRequestId = rid;
  setStreaming(true);

  const genMessages: ChatMsg[] = [
    {
      role: "system",
      content:
        `You are completing an UNFINISHED ${lang} file "${rel}". Output ONLY the code to ` +
        `APPEND so the file becomes complete and compiles — the continuation from exactly ` +
        `where it stops. Do NOT repeat any existing code, do NOT restate the whole file, no ` +
        `fences, no explanation. Match the file's style and indentation.`,
    },
    {
      role: "user",
      content: `${instruction}\n\nThe file so far (continue after the last line):\n${code.slice(-6000)}`,
    },
  ];
  try {
    await invoke("assistant_chat_stream", {
      messages: genMessages,
      provider,
      model: null,
      requestId: rid,
      mode: "workspace",
      stepId: null,
    });
  } catch (e) {
    pushRangeStream(rangeStreamOriginal());
    endRangeStream();
    actionErrors.set(idx, String(e));
    writeState.delete(idx);
    localStream = null;
    finishStream();
  }
}

/** Strip a leading ``` fence (language tag and all) from streamed code, tolerating an
 *  unclosed trailing fence while tokens are still arriving. */
// Typewriter for the code stream: reveals `target` up to `shown` at a readable rate
// (~80 chars/s) with bounded lag, so the developer can follow each line being written.
// When the stream has finished arriving AND the editor has caught up, it finalizes.
function paceCodeStream(): void {
  if (!codeStream || codeStream.timer != null) return;
  codeStream.timer = window.setInterval(() => {
    const cs = codeStream;
    if (!cs) return; // cancelled / cleared elsewhere (requestId guard owns the stream)
    if (cs.shown < cs.target.length) {
      const remaining = cs.target.length - cs.shown;
      // Base ~2 chars/tick (readable); accelerate only to cap how far behind we lag.
      const step = Math.max(2, Math.floor(remaining / 50));
      cs.shown = Math.min(cs.target.length, cs.shown + step);
      pushEditorStream(cs.target.slice(0, cs.shown));
    } else if (cs.done) {
      if (cs.timer != null) {
        window.clearInterval(cs.timer);
        cs.timer = null;
      }
      finalizeCodeStream(cs);
    }
  }, 24);
}
function finalizeCodeStream(cs: NonNullable<typeof codeStream>): void {
  const produced = stripFences(cs.accum).trim();
  if (!produced) {
    pushEditorStream(cs.original); // nothing usable — restore, let the developer retry
    endEditorStream();
    actionErrors.set(cs.idx, "the model produced no code — the file was left unchanged");
    writeState.delete(cs.idx);
  } else {
    pushEditorStream(cs.target); // ensure the full text is shown
    endEditorStream();
    writeState.set(cs.idx, "done");
    advancePlan(); // a code-write step completed
    // Shrink guard: a substantial file replaced with far less content may be a partial.
    if (cs.original.trim().length > 200 && produced.length < cs.original.length * 0.4) {
      shrinkWarn.add(cs.idx);
    }
  }
  if (codeStream === cs) codeStream = null;
  finishStream();
  renderMessages();
}

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

// Cloud-shaped isolated tasks (RF-AG-01/05): a dxcode proposal can be run in an isolated
// worktree instead of written to the buffer; it returns a PATCH, leaving the tree untouched.
interface TaskState {
  status: "running" | "done" | "error";
  patch: string;
  error: string;
}
const tasks = new Map<number, TaskState>(); // message idx → isolated task result

/** Generate the dxcode file content (one blocking call) and run it as an ISOLATED task: the
 *  write is applied in a throwaway worktree of HEAD and the returned diff is shown for review
 *  — the working tree is never touched. */
async function runInIsolation(idx: number): Promise<void> {
  const dir = parseCodeDirective(messages[idx]?.content ?? "");
  const root = workspaceRoot();
  if (!dir || !root || tasks.get(idx)?.status === "running") return;
  tasks.set(idx, { status: "running", patch: "", error: "" });
  renderMessages();
  try {
    // 1) Generate the full file content (blocking — we need it as a payload, not a stream).
    const reply = await invoke<{ content: string }>("assistant_chat", {
      messages: [
        { role: "system", content: `You generate ONE complete ${dir.language} file. Output ONLY the file's code — no fences, no prose.` },
        { role: "user", content: dir.instruction },
      ],
      model: null,
    });
    const content = stripFences(reply.content).trimEnd() + "\n";
    // 2) Submit to the isolated executor and 3) poll until it collects a patch.
    const id = await invoke<string>("agent_task_submit", { root, writes: [[dir.file, content]] });
    for (let i = 0; i < 60; i++) {
      const st = await invoke<TaskState | null>("agent_task_status", { id });
      if (st && st.status !== "running") {
        tasks.set(idx, st);
        renderMessages();
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    tasks.set(idx, { status: "error", patch: "", error: "timed out waiting for the task" });
    renderMessages();
  } catch (e) {
    tasks.set(idx, { status: "error", patch: "", error: String(e) });
    renderMessages();
  }
}

interface SymbolRange {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

interface EntrypointProposal {
  snippet: string;
  note: string;
}

/** Add a runnable entry point (fn main / func main / __main__ guard) if the active file
 *  lacks one, appended at the end as a REVIEWED localized edit (diff + Accept/Reject). */
export async function addEntrypoint(path: string, code: string, lang: string): Promise<void> {
  if (busy) return;
  let proposal: EntrypointProposal | null = null;
  try {
    proposal = await invoke<EntrypointProposal | null>("propose_entrypoint", { lang, code });
  } catch {
    return;
  }
  openAssistant();
  const rel = path.split("/").pop() ?? path;
  if (!proposal) {
    messages.push({ role: "assistant", content: `\`${rel}\` already has an entry point.` });
    renderMessages();
    return;
  }
  const idx = messages.push({ role: "assistant", content: `➕ ${proposal.note}` }) - 1;
  const lines = code.split("\n");
  const lastLine = Math.max(1, lines.length);
  const ok = await beginRangeStream(path, lastLine, lastLine);
  if (!ok) {
    messages[idx].content += " — ⚠ could not open the file";
    renderMessages();
    return;
  }
  pushRangeStream((lines[lastLine - 1] ?? "") + proposal.snippet); // append after the last line
  const info = enterRangeReview();
  if (info) {
    const d = await invoke<DiffLine[]>("diff_lines", { old: info.original, new: info.proposed }).catch(() => []);
    reviews.set(idx, d);
    const sel = new Set<number>();
    d.forEach((l, k) => {
      if (l.op !== "context") sel.add(k);
    });
    reviewSel.set(idx, sel);
    messages[idx].content += " — review below, then run the project to validate.";
    renderMessages();
  }
}

/** Localized edit of a NAMED Rust fn/method: find the target range via symbol_ranges
 *  (disambiguating homonyms), then run the scoped block edit. Rust-only (syntactic). */
export async function startMethodEdit(path: string, code: string, lang: string): Promise<void> {
  if (busy) return;
  const name = (window.prompt("Which method/function? (name)", "") ?? "").trim();
  if (!name) return;
  let ranges: SymbolRange[] = [];
  try {
    ranges = await invoke<SymbolRange[]>("symbol_ranges", { code, name });
  } catch {
    ranges = [];
  }
  if (ranges.length === 0) {
    window.alert(`No Rust fn/method named "${name}" found in this file.`);
    return;
  }
  let target = ranges[0];
  if (ranges.length > 1) {
    const choice = window.prompt(
      `${ranges.length} items named "${name}" — enter the start line to pick:\n` +
        ranges.map((r) => `• lines ${r.startLine}–${r.endLine} (${r.kind})`).join("\n"),
      String(ranges[0].startLine),
    );
    const found = ranges.find((r) => r.startLine === Number(choice));
    if (!found) return;
    target = found;
  }
  const selected = code.split("\n").slice(target.startLine - 1, target.endLine).join("\n");
  await startLocalizedEdit(path, target.startLine, target.endLine, selected, lang);
}

/** Localized edit: stream a replacement into ONLY the selected block (lines
 *  `startLine..endLine`), leaving the rest of the file untouched. The target is shown in the
 *  chat; the block is restored on empty/error; Stop / Ctrl+Z keep control. */
export async function startLocalizedEdit(
  path: string,
  startLine: number,
  endLine: number,
  selected: string,
  lang: string,
  instructionArg?: string,
): Promise<void> {
  if (busy) return;
  // The chat (dxedit) passes the instruction; the editor actions prompt for it.
  const instruction = (instructionArg ?? window.prompt(`Improve lines ${startLine}–${endLine} — how?`, "") ?? "").trim();
  if (!instruction) return;

  openAssistant();
  const rel = path.split("/").pop() ?? path;
  const idx =
    messages.push({
      role: "assistant",
      content: `✏️ Improving \`${rel}\` lines ${startLine}–${endLine}: ${instruction}`,
    }) - 1;
  writeState.set(idx, "writing");
  renderMessages();

  const ok = await beginRangeStream(path, startLine, endLine);
  if (!ok) {
    actionErrors.set(idx, "could not open the target block in the editor");
    writeState.delete(idx);
    renderMessages();
    return;
  }

  const rid = crypto.randomUUID();
  localStream = { requestId: rid, path, idx, accum: "" };
  busy = true;
  currentRequestId = rid;
  setStreaming(true);

  const genMessages: ChatMsg[] = [
    {
      role: "system",
      content:
        `You are a precise code editor working on "${rel}" (${lang}). The user selected a ` +
        `block (lines ${startLine}–${endLine}). Output ONLY the replacement for THAT block — ` +
        `no fences, no explanation, no surrounding code, and keep the block's indentation. ` +
        `Do not output the whole file.`,
    },
    {
      role: "user",
      content: `${instruction}\n\nThe selected block:\n${selected}`,
    },
  ];
  try {
    await invoke("assistant_chat_stream", {
      messages: genMessages,
      provider,
      model: null,
      requestId: rid,
      mode: "workspace",
      stepId: null,
    });
  } catch (e) {
    pushRangeStream(rangeStreamOriginal());
    endRangeStream();
    actionErrors.set(idx, String(e));
    writeState.delete(idx);
    localStream = null;
    finishStream();
  }
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
  codeStream = { requestId: rid, path: abs, file: dir.file, idx, accum: "", original: current, target: "", shown: 0, done: false, timer: null };
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
  const ta = $("#assistant-input") as HTMLTextAreaElement;
  const text = ta.value.trim();
  if (!text) return;
  ta.value = "";
  await sendText(text);
}

/** Send `text` as a user turn (shared by the composer and the plan orchestration). */
async function sendText(text: string): Promise<void> {
  if (busy || !text.trim()) return;
  messages.push({ role: "user", content: text });
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

const SEND_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
function setStreaming(s: boolean): void {
  const b = $("#assistant-send") as HTMLButtonElement;
  b.innerHTML = s ? STOP_ICON : SEND_ICON;
  b.title = s ? "Stop" : "Send (Ctrl+Enter)";
  b.classList.toggle("stop", s);
  // Prototype-style running bar: a real "A executar… / Parar" surfaces while the agent streams.
  document.getElementById("assistant-running")?.classList.toggle("hidden", !s);
}

function renderMessages(): void {
  const host = $("#assistant-messages");
  if (messages.length === 0) {
    host.innerHTML = `<div class="as-welcome">I'm your project-focused Agent. I know this project — its tree, the active file and your selection — and I assist the build <b>you</b> direct (you approve every change). Type <b>/</b> for guided prompt templates, <b>Ctrl+Enter</b> to send.</div>`;
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
        // Hide the raw dxaction/dxcode/dxedit JSON from the bubble (shown as the plan text
        // + an inline status appended by the stream handlers).
        let shown = m.content;
        if (action) shown = shown.replace(/```dxaction\s*\n[\s\S]*?```/, "").trim();
        if (code) shown = shown.replace(/```dxcode\s*\n[\s\S]*?```/, "").trim();
        shown = shown.replace(/```dxedit\s*\n[\s\S]*?```/, "").trim();
        shown = shown.replace(/```dxcontinue\s*\n[\s\S]*?```/, "").trim();
        shown = shown.replace(/```dxplan\s*\n[\s\S]*?```/, "").trim();
        const body = esc(shown) + (streaming ? '<span class="as-cursor">▍</span>' : "");
        const err = actionErrors.get(i);
        let card = "";
        // Agent plan progress (execution checklist) — rendered above any action card.
        const plan = plans.get(i);
        if (plan) card += planCard(plan);
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
              `<div class="as-action-btns"><button class="as-write" data-idx="${i}">Write in editor</button>` +
              `<button class="as-isolate" data-idx="${i}" title="Run in a throwaway worktree and show a patch — the working tree is not touched">Run in isolation</button>` +
              `<button class="as-reject" data-idx="${i}">Dismiss</button></div>` +
              taskCard(i) +
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
        // Localized-edit review: the proposed block's diff + Accept / Reject.
        const review = reviews.get(i);
        if (review) {
          const sel = reviewSel.get(i) ?? new Set<number>();
          const diffHtml = review
            .map((l, k) => {
              if (l.op === "context") return `<span class="dl context">${esc(l.text)}</span>`;
              const checked = sel.has(k) ? "checked" : "";
              return `<label class="dl ${l.op}"><input type="checkbox" class="dl-ck" data-idx="${i}" data-k="${k}" ${checked}>${esc(l.text)}</label>`;
            })
            .join("");
          card +=
            `<div class="as-review"><div class="as-review-diff">${diffHtml}</div>` +
            `<div class="as-review-btns"><button class="as-accept-all" data-idx="${i}">Accept all</button>` +
            `<button class="as-accept-sel" data-idx="${i}">Accept selected</button>` +
            `<button class="as-revreject" data-idx="${i}">Reject</button></div></div>`;
        }
        return `<div class="as-msg ${m.role}"><div class="as-role">${m.role === "user" ? "You" : "Assistant"}</div><div class="as-body">${body || (streaming ? '<span class="as-cursor">▍</span>' : "")}</div>${card}</div>`;
      })
      .join("");
  host.scrollTop = host.scrollHeight;
}
