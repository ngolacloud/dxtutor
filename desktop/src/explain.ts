// Explain: delegate to the Agent to produce an organized, read-first summary of the open
// file — an overview plus a section per function/method/attribute, each tagged with its
// line as [L<n>]. Rendered in a panel parallel to the code; clicking a line link jumps
// straight to that part of the code. Helps a dev understand third-party code fast.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openExplainTab, closeExplainTab, revealLine, openFileAt } from "./workspace";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let lastReq: { path: string; code: string; lang: string; name: string } | null = null;
let folderSources: Array<{ path: string; content: string }> = []; // for multi-file links
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
  // Jump links: single-file scrolls the left code pane; multi-file opens that file.
  $("#explain-body").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest(".explain-jump") as HTMLElement | null;
    if (!a?.dataset.line) return;
    if (a.dataset.path) void openFileAt(a.dataset.path, Number(a.dataset.line), 1);
    else revealLine(Number(a.dataset.line));
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

  // Ground the model in the REAL symbol outline (exact line spans from the parser) so the
  // sections and [L<n>] anchors are precise, not guessed. Best-effort (Rust today).
  let outlineBlock = "";
  try {
    const outline = await invoke<Array<{ name: string; kind: string; startLine: number; endLine: number }>>(
      "file_outline",
      { code },
    );
    if (outline.length) {
      outlineBlock =
        "\n\nAuthoritative symbol outline (name — kind — lines; use these EXACT lines for the " +
        "section headings and [L<n>] anchors):\n" +
        outline.map((s) => `- ${s.name} — ${s.kind} — L${s.startLine}-${s.endLine}`).join("\n");
    }
  } catch {
    /* outline is best-effort; fall back to line numbers in the listing */
  }

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
    "jump there. Use the EXACT line numbers from the outline/listing. Do not repeat the code " +
    "verbatim." +
    outlineBlock +
    `\n\n\`\`\`${lang}\n${numbered}\n\`\`\``;

  folderSources = [];
  await runExplain(system, user);
}

/** Explain a whole FOLDER (module): a module overview + a per-file section, with links that
 *  open each file at a line. Bounded to a handful of files so the prompt stays sane. */
export async function explainFolder(dir: string, name: string): Promise<void> {
  if (busy) return;
  lastReq = null;
  $("#explain-file").textContent = `${name}/`;
  $("#explain-body").innerHTML = `<div class="explain-loading">Reading ${esc(name)}/ and summarizing the module…</div>`;
  openExplainTab(`${name}/`); // no single file → full-width summary (no split)
  let sources: Array<{ path: string; content: string }> = [];
  try {
    sources = await invoke<Array<{ path: string; content: string }>>("read_folder_sources", {
      dir,
      maxFiles: 10,
      maxBytes: 48000,
    });
  } catch (e) {
    $("#explain-body").innerHTML = `<div class="explain-err">Could not read folder: ${esc(String(e))}</div>`;
    return;
  }
  if (sources.length === 0) {
    $("#explain-body").innerHTML = `<div class="explain-err">No source files found in this folder.</div>`;
    return;
  }
  folderSources = sources;
  const listing = sources
    .map((s, i) => {
      const rel = s.path.slice(dir.length).replace(/^[\\/]/, "");
      const numbered = s.content
        .split("\n")
        .map((l, k) => `${String(k + 1).padStart(4)}: ${l}`)
        .join("\n");
      return `### File ${i + 1}: ${rel}\n\`\`\`\n${numbered}\n\`\`\``;
    })
    .join("\n\n");
  const system =
    "You explain an existing code MODULE to a developer reading it for the FIRST time. You " +
    "clarify how the files fit together and what each does — you do NOT rewrite or judge. " +
    "Answer in clear, well-organized Markdown.";
  const user =
    `Explain the module \`${name}/\` (${sources.length} files below). Structure your answer as:\n\n` +
    "1. **Module overview** — what this folder does and how the files collaborate.\n" +
    "2. A section per file (heading = the file's relative path). Summarize its role and its " +
    "key functions/types.\n\n" +
    "To point at a specific place, cite it as `[open <fileNumber>:<line>]` (e.g. `[open 1:12]`) " +
    "using the File numbers and line numbers shown below, so the reader can jump straight to " +
    "it. Do not repeat the code verbatim.\n\n" +
    listing;
  await runExplain(system, user);
}

/** Shared streaming driver: send the prompt and let llm:// events render it live. */
async function runExplain(system: string, user: string): Promise<void> {
  busy = true;
  accum = "";
  reqId = crypto.randomUUID();
  try {
    // mode "workspace" keeps the policy non-tutor (it must explain, not withhold).
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

/** Inline formatting on an escaped string: code, bold, italic, then jump links. */
function inline(s: string): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Multi-file: [open 1:12] → opens File #1 at line 12 (mapped via folderSources).
  t = t.replace(/\[open (\d+):(\d+)\]/g, (_m, fi, ln) => {
    const src = folderSources[Number(fi) - 1];
    if (!src) return `L${ln}`;
    const rel = src.path.split(/[\\/]/).pop() ?? src.path;
    return `<a class="explain-jump" data-path="${esc(src.path)}" data-line="${ln}">${esc(rel)}:${ln}</a>`;
  });
  // Single-file: [L12] / [L12-20] / bare L12 → a clickable jump to the first line.
  t = t.replace(/\[?L(\d+)(?:-\d+)?\]?/g, (_m, n) => `<a class="explain-jump" data-line="${n}">L${n}</a>`);
  return t;
}
