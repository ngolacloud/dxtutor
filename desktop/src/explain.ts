// Explain: delegate to the Agent to produce an organized, read-first summary of the open
// file — an overview plus a section per function/method/attribute, each tagged with its
// line as [L<n>]. Rendered in a panel parallel to the code; clicking a line link jumps
// straight to that part of the code. Helps a dev understand third-party code fast.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openExplainTab, closeExplainTab, revealLine } from "./workspace";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let lastReq: { path: string; code: string; lang: string; name: string } | null = null;
let busy = false;
let reqId: string | null = null; // the in-flight streaming request
let accum = ""; // tokens accumulated so far
let painting = false; // rAF throttle for markdown rendering

function paint(): void {
  if (painting) return;
  painting = true;
  requestAnimationFrame(() => {
    painting = false;
    $("#explain-body").innerHTML = renderMarkdown(accum || "…");
  });
}

export function initExplain(): void {
  $("#explain-close").addEventListener("click", () => closeExplainTab());
  $("#explain-refresh").addEventListener("click", () => {
    if (lastReq) void explainFile(lastReq.path, lastReq.code, lastReq.lang, lastReq.name);
  });
  // Jump links: scroll the code (left pane) to the referenced line, keeping the split.
  $("#explain-body").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest(".explain-jump") as HTMLElement | null;
    if (a?.dataset.line) revealLine(Number(a.dataset.line));
  });

  // Draggable splitter between the code (left) and the summary (right).
  const region = $("#ws-editor-region");
  const saved = localStorage.getItem("dxtutor.explainSplit");
  if (saved) region.style.setProperty("--explain-split", saved);
  const splitter = $("#explain-splitter");
  let dragging = false;
  splitter.addEventListener("pointerdown", (e) => {
    dragging = true;
    splitter.setPointerCapture(e.pointerId);
  });
  splitter.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = region.getBoundingClientRect();
    const pct = Math.max(25, Math.min(75, ((e.clientX - r.left) / r.width) * 100));
    region.style.setProperty("--explain-split", `${pct.toFixed(1)}%`);
  });
  splitter.addEventListener("pointerup", (e) => {
    dragging = false;
    splitter.releasePointerCapture(e.pointerId);
    localStorage.setItem(
      "dxtutor.explainSplit",
      getComputedStyle(region).getPropertyValue("--explain-split").trim(),
    );
  });
  // Live token stream for the Explain summary (own request id — ignores assistant streams).
  void listen<{ requestId: string; delta: string }>("llm://token", (e) => {
    if (e.payload.requestId !== reqId) return;
    accum += e.payload.delta;
    paint();
  });
  void listen<{ requestId: string }>("llm://done", (e) => {
    if (e.payload.requestId !== reqId) return;
    reqId = null;
    busy = false;
    $("#explain-body").innerHTML = renderMarkdown(accum || "_(empty response)_");
  });
  void listen<{ requestId: string; error: string }>("llm://error", (e) => {
    if (e.payload.requestId !== reqId) return;
    reqId = null;
    busy = false;
    if (!accum) $("#explain-body").innerHTML = `<div class="explain-err">Explain failed: ${esc(e.payload.error)}</div>`;
  });
}

/** Run an Explain pass on a file and render it into the parallel panel. */
export async function explainFile(path: string, code: string, lang: string, name: string): Promise<void> {
  if (busy) return;
  lastReq = { path, code, lang, name };
  $("#explain-file").textContent = name;
  $("#explain-body").innerHTML = `<div class="explain-loading">Reading ${esc(name)} and writing a summary…</div>`;
  openExplainTab(name, path); // open as a real tab that splits code | summary

  // Number the lines so the model can reference exact positions as [L<n>].
  const numbered = code
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)}: ${l}`)
    .join("\n");
  const system =
    "You explain existing code to a developer reading it for the FIRST time, so they " +
    "understand third-party code fast. You do NOT rewrite or judge the code — you clarify " +
    "intent and logic. Answer in clear Markdown, concise and well organized.";
  const user =
    `Explain the file \`${name}\` (${lang}). Structure your answer EXACTLY as:\n\n` +
    "1. **Overview** — one short paragraph: what this file is for and how it fits together.\n" +
    "2. A section per function / method / struct / class / important field, IN FILE ORDER. " +
    "Begin each with a heading naming it and its line, e.g. `### parse_reference [L12]`. " +
    "In 1–4 sentences explain its logic, inputs/outputs and any side effects.\n\n" +
    "Whenever you mention a specific part, cite its line as `[L<number>]` so the reader can " +
    "jump there. Use the line numbers shown in the listing. Do not repeat the code verbatim.\n\n" +
    `\`\`\`${lang}\n${numbered}\n\`\`\``;

  busy = true;
  accum = "";
  reqId = crypto.randomUUID();
  try {
    // Stream live into the panel. mode "workspace" keeps the policy non-tutor (it must
    // actually explain, not withhold). Tokens arrive via llm://token (handled in init).
    await invoke("assistant_chat_stream", {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      provider: null,
      model: null,
      requestId: reqId,
      mode: "workspace",
      stepId: null,
    });
  } catch (e) {
    reqId = null;
    busy = false;
    $("#explain-body").innerHTML = `<div class="explain-err">Explain failed: ${esc(String(e))}</div>`;
  }
}

// ── Minimal, safe Markdown → HTML (headings, lists, code, emphasis) + [L<n>] links ──
function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    const fence = raw.match(/^```(\w*)/);
    if (fence) {
      closeList();
      if (!inCode) {
        out.push(`<pre class="explain-code"><code>`);
        inCode = true;
      } else {
        out.push("</code></pre>");
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      out.push(esc(raw));
      continue;
    }
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl} class="explain-h">${inline(h[2])}</h${lvl}>`);
      continue;
    }
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (raw.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(raw)}</p>`);
  }
  if (inCode) out.push("</code></pre>");
  closeList();
  return out.join("\n");
}

/** Inline formatting on an escaped string: code, bold, italic, then [L<n>] jump links. */
function inline(s: string): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // [L12] or [L12-20] or bare L12 → a clickable jump to the first line.
  t = t.replace(/\[?L(\d+)(?:-\d+)?\]?/g, (_m, n) => `<a class="explain-jump" data-line="${n}">L${n}</a>`);
  return t;
}
