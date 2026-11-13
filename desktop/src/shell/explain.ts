// shell/explain.ts — Fase 2 (paridade, PARITY #16): Explain (resumo lado-a-lado em stream).
//
// Explica o ficheiro activo a quem o lê pela primeira vez: um resumo em Markdown que transmite
// AO VIVO do provedor real (mesmo caminho do Co-Dev: assistant_chat_stream + eventos llm://),
// fundamentado no outline REAL do ficheiro (file_outline) para que as secções e as âncoras
// [L<n>] sejam exactas, não adivinhadas. A vista é um split: código (Monaco, só leitura) à
// esquerda, resumo à direita; cada [L<n>] salta para a linha no código. Sem provedor ou sem
// ficheiro → estado honesto, nada inventado. Explain de pasta fica para fase posterior (PENDING).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { monaco } from "../monaco";
import { t, registerStrings } from "../i18n";
import { VIEW, openTab, addCommand, toast, closeTab, type Tab } from "./index";
import { workspaceRoot, activeFile, langForFile } from "./workspace";
import { currentTheme } from "./theme";
import { codevProvider } from "./codev";

const EXPLAIN_TAB = "explain";
const base = (p: string): string => p.split("/").pop() || p;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

interface SymbolRange { name: string; kind: string; start_line: number; end_line: number }

// Estado do pedido em curso. `accum` cresce só com tokens reais; `reqId` é a fonte única de
// "este stream ainda é meu" (fragmentos tardios após cancelar são ignorados).
let pending: { path: string; code: string; lang: string; name: string } | null = null;
let accum = "";
let reqId: string | null = null;
let busy = false;
let statusKey: "loading" | "streaming" | "done" | "error" | "noprov" = "loading";
let statusMsg = "";

// Editor de código (esquerda) reutilizado; recriado a cada render (a casca limpa o host).
let codeEd: monaco.editor.IStandaloneCodeEditor | null = null;
let codeModel: monaco.editor.ITextModel | null = null;

function monacoTheme(): string { return currentTheme() === "Papel claro" ? "vs" : "vs-dark"; }

/** Pinta o corpo do resumo (lado direito) a partir do markdown acumulado. */
function paintSummary(): void {
  const body = document.getElementById("explain-sum");
  if (!body) return;
  if (statusKey === "error") { body.innerHTML = `<div class="sec-empty" style="color:var(--red)">${esc(statusMsg)}</div>`; return; }
  if (statusKey === "noprov") { body.innerHTML = `<div class="sec-empty">${esc(t("explain.noProvider"))}</div>`; return; }
  if (!accum) { body.innerHTML = `<div class="sec-empty">${esc(t("explain.loading", { name: pending?.name ?? "" }))}</div>`; return; }
  body.innerHTML = renderMarkdown(accum);
  wireJumps(body);
}

/** Liga os saltos [L<n>] do resumo ao editor de código à esquerda. */
function wireJumps(body: HTMLElement): void {
  body.querySelectorAll<HTMLElement>(".explain-jump[data-line]").forEach((a) => {
    a.onclick = () => {
      const ln = Number(a.dataset.line);
      if (!codeEd || !Number.isFinite(ln)) return;
      codeEd.revealLineInCenter(ln);
      codeEd.setPosition({ lineNumber: ln, column: 1 });
      codeEd.focus();
    };
  });
}

/** Render da vista `explain`: código (Monaco só-leitura) | splitter | resumo em stream. */
const explainView = (_tab: Tab, host: HTMLElement): void => {
  const pf = pending;
  if (!pf) { host.innerHTML = `<div class="empty"><div>${esc(t("explain.gone"))}</div></div>`; return; }
  host.innerHTML =
    `<div style="display:flex;height:100%;min-height:0">
      <div id="explain-code" style="flex:1;min-width:0;border-right:1px solid var(--border)"></div>
      <div id="explain-sum" style="flex:1;min-width:0;overflow:auto;padding:12px 16px;font-size:13px;line-height:1.55"></div>
    </div>`;
  const chost = host.querySelector<HTMLElement>("#explain-code")!;
  codeModel?.dispose();
  codeEd?.dispose();
  codeModel = monaco.editor.createModel(pf.code, pf.lang);
  codeEd = monaco.editor.create(chost, {
    model: codeModel, theme: monacoTheme(), readOnly: true, automaticLayout: true,
    fontSize: 12, minimap: { enabled: false }, scrollBeyondLastLine: false, lineNumbers: "on",
  });
  paintSummary();
};

/** Explica o ficheiro ACTIVO: lê-o, fundamenta no outline real e transmite o resumo ao vivo. */
export async function explainActiveFile(): Promise<void> {
  if (busy) { toast(t("explain.busy")); return; }
  const path = activeFile();
  if (!path) { toast(t("explain.noFile")); return; }
  let code: string;
  try { code = await invoke<string>("read_text_file", { path }); }
  catch (e) { toast(t("explain.readErr", { e: String(e) })); return; }
  const lang = langForFile(base(path));
  const name = base(path);
  pending = { path, code, lang, name };
  accum = "";
  statusKey = "loading";
  openTab({ id: EXPLAIN_TAB, title: `✦ ${name}`, kind: "explain", path });

  // Provedor honesto: usa a escolha do Co-Dev; sem nenhum disponível, não inventa resumo.
  const prov = codevProvider();
  if (!prov) { statusKey = "noprov"; paintSummary(); return; }

  // Fundamenta no outline REAL (spans de linha do parser/LSP) — âncoras [L<n>] exactas.
  let outlineBlock = "";
  try {
    const outline = await invoke<SymbolRange[]>("file_outline", { code, lang, root: workspaceRoot(), file: path });
    if (outline.length) {
      outlineBlock = "\n\nAuthoritative symbol outline (name — kind — lines; use these EXACT lines for the " +
        "section headings and [L<n>] anchors):\n" +
        outline.map((s) => `- ${s.name} — ${s.kind} — L${s.start_line}-${s.end_line}`).join("\n");
    }
  } catch { /* outline best-effort — recai nos números do próprio código */ }

  const MAX_LINES = 1600;
  const lines = code.split("\n");
  const truncated = lines.length > MAX_LINES;
  const numbered = lines.slice(0, MAX_LINES).map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join("\n") +
    (truncated ? `\n… (listing truncated at line ${MAX_LINES}; the outline covers the rest)` : "");

  const system =
    "You explain existing code to a developer reading it for the FIRST time, so they understand " +
    "third-party code fast. You do NOT rewrite or judge the code — you clarify intent and logic. " +
    "Answer in clear Markdown, concise and well organized.";
  const user =
    `Explain the file \`${name}\` (${lang}). Structure your answer EXACTLY as:\n\n` +
    "1. **Overview** — one short paragraph: what this file is for and how it fits together.\n" +
    "2. A section per function / method / struct / class / important field, IN FILE ORDER. " +
    "Begin each with a heading naming it and its line, e.g. `### parse_reference [L12]`. " +
    "In 1–4 sentences explain its logic, inputs/outputs and any side effects.\n\n" +
    "Whenever you mention a specific part, cite its line as `[L<number>]` so the reader can jump " +
    "there. Use the EXACT line numbers from the outline/listing. Do not repeat the code verbatim." +
    outlineBlock + `\n\n\`\`\`${lang}\n${numbered}\n\`\`\``;

  busy = true;
  statusKey = "streaming";
  reqId = crypto.randomUUID();
  try {
    await invoke("assistant_chat_stream", {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      provider: prov.provider,
      model: prov.model,
      requestId: reqId,
      mode: "project",
    });
  } catch (e) {
    busy = false; reqId = null; statusKey = "error"; statusMsg = t("explain.failed", { e: String(e) });
    paintSummary();
  }
}

/** Liga os três eventos de stream UMA vez; o `reqId` filtra o que é do pedido actual. */
function installStreamListeners(): void {
  void listen<{ requestId: string; delta: string }>("llm://token", (e) => {
    if (e.payload.requestId !== reqId) return; // fragmento tardio / outro pedido
    accum += e.payload.delta; statusKey = "streaming"; paintSummary();
  });
  void listen<{ requestId: string }>("llm://done", (e) => {
    if (e.payload.requestId !== reqId) return;
    busy = false; reqId = null; statusKey = "done";
    if (!accum) { statusMsg = t("explain.empty"); statusKey = "error"; }
    paintSummary();
  });
  void listen<{ requestId: string; error: string }>("llm://error", (e) => {
    if (e.payload.requestId !== reqId) return;
    busy = false; reqId = null; statusKey = "error"; statusMsg = t("explain.failed", { e: e.payload.error });
    paintSummary();
  });
}

/** Regista a vista `explain`, o comando e as strings. Chamar antes de `bootShell()`. */
export function initExplain(): void {
  registerStrings(EXPLAIN_STRINGS);
  VIEW.explain = explainView;
  installStreamListeners();
  addCommand({ id: "explain:file", label: () => t("explain.cmd"), run: () => void explainActiveFile() });
}

// Mantido para simetria com outras superfícies que fecham o seu separador.
export function closeExplain(): void { pending = null; codeModel?.dispose(); codeEd?.dispose(); codeEd = null; codeModel = null; closeTab(EXPLAIN_TAB); }

// ── Markdown mínimo e seguro (cabeçalhos, listas, código, ênfase) + links [L<n>] ──
function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false, inList = false;
  const closeList = (): void => { if (inList) { out.push("</ul>"); inList = false; } };
  for (const raw of lines) {
    const fence = raw.match(/^```(\w*)/);
    if (fence) { closeList(); if (!inCode) { out.push(`<pre class="explain-code"><code>`); inCode = true; } else { out.push("</code></pre>"); inCode = false; } continue; }
    if (inCode) { out.push(esc(raw)); continue; }
    // Cabeçalho ATX, tolerando um ordinal de lista à frente (alguns modelos escrevem
    // "2. ### main [L1-4]" em vez de "### main [L1-4]") — queremos que seja uma secção.
    const h = raw.match(/^\s*(?:\d+\.\s+)?(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl} class="explain-h" style="margin:12px 0 4px">${inline(h[2])}</h${lvl}>`); continue; }
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (raw.trim() === "") { closeList(); continue; }
    closeList(); out.push(`<p>${inline(raw)}</p>`);
  }
  if (inCode) out.push("</code></pre>");
  closeList();
  return out.join("\n");
}

/** Formatação inline sobre texto JÁ escapado: código, negrito, itálico e, por fim, saltos [L<n>]. */
function inline(s: string): string {
  let x = esc(s);
  x = x.replace(/`([^`]+)`/g, "<code>$1</code>");
  x = x.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  x = x.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // [L12] / [L12-20] / L12 nu → salto clicável para a primeira linha.
  x = x.replace(/\[?L(\d+)(?:-\d+)?\]?/g, (_m, n) => `<a class="explain-jump" data-line="${n}" style="color:var(--accent);cursor:pointer">L${n}</a>`);
  return x;
}

const EXPLAIN_STRINGS = {
  en: {
    "explain.cmd": "Explain: current file",
    "explain.loading": "Reading {name} and writing a summary…",
    "explain.noFile": "Open a file to explain it.",
    "explain.noProvider": "No provider configured — set one in Settings to generate an explanation. Nothing is invented.",
    "explain.busy": "Wait for the current explanation to finish.",
    "explain.readErr": "Could not read the file: {e}",
    "explain.failed": "Explain failed: {e}",
    "explain.empty": "The provider returned an empty explanation.",
    "explain.gone": "This explanation is no longer available.",
  },
  ptAO: {
    "explain.cmd": "Explicar: ficheiro actual",
    "explain.loading": "A ler {name} e a escrever um resumo…",
    "explain.noFile": "Abre um ficheiro para o explicar.",
    "explain.noProvider": "Sem provedor configurado — define um em Definições para gerar a explicação. Nada é inventado.",
    "explain.busy": "Espera a explicação actual terminar.",
    "explain.readErr": "Não consegui ler o ficheiro: {e}",
    "explain.failed": "Explain falhou: {e}",
    "explain.empty": "O provedor devolveu uma explicação vazia.",
    "explain.gone": "Esta explicação já não está disponível.",
  },
};
