// Frontend bridge to the multi-language LSP client (backend `lsp.rs`).
//
// Pure LSP↔Monaco layer: thin invoke wrappers + an `installLsp` that wires
// semantic navigation and refactor onto a Monaco editor via a small `host`
// (supplied by workspace.ts, where the editor, tabs and fs helpers live):
//
//   * Ctrl+Click / F12  → Go to Definition   (lsp_definition → host.openAt)
//   * Shift+F12         → Find References     (ReferenceProvider → Monaco peek)
//   * F2                → Rename (recursive)  (lsp_rename → WorkspaceEdit → disk + open models)
//   * hover             → semantic hover      (HoverProvider → lsp_hover)
//   * diagnostics       → markers             (lsp://diagnostics event → setModelMarkers)
//
// Cross-file navigation and rename are applied by us (not Monaco's built-in,
// which can only reach already-open models), so a rename reaches EVERY file that
// references the symbol — open or not — like NetBeans.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type monaco from "monaco-editor/esm/vs/editor/editor.api";

// ── LSP wire types (only the fields we read) ──────────────────────────────────
interface LspPos { line: number; character: number }
interface LspRange { start: LspPos; end: LspPos }
interface LspLocation { uri: string; range: LspRange }
interface LspLocationLink { targetUri: string; targetSelectionRange?: LspRange; targetRange: LspRange }
interface LspTextEdit { range: LspRange; newText: string }
interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument: { uri: string }; edits: LspTextEdit[] }>;
}
interface LspDiagnostic { range: LspRange; message: string; severity?: number; source?: string; code?: unknown }

/** Everything lsp.ts needs from the workspace to drive the editors + filesystem. */
export interface LspHost {
  root(): string | null;
  pathForModel(model: monaco.editor.ITextModel): string | null;
  modelForPath(path: string): monaco.editor.ITextModel | null;
  openAt(path: string, line: number, col: number): void | Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  promptRename(current: string): string | null;
  notify(msg: string): void;
}

// Monaco languageIds that have a backend LSP server (see `LANGS` in lsp.rs). Providers
// below register for each; workspace.ts only opens an LSP document for these.
export const LSP_LANGUAGES = ["rust", "go", "typescript", "javascript", "python"] as const;

// ── invoke wrappers ───────────────────────────────────────────────────────────
export const lspStart = (root: string) => invoke<void>("lsp_start", { root });
export const lspDidOpen = (path: string, text: string, languageId = "rust") =>
  invoke<void>("lsp_did_open", { path, text, languageId });
export const lspDidChange = (path: string, text: string, version: number) =>
  invoke<void>("lsp_did_change", { path, text, version });
const lspDefinition = (path: string, line: number, character: number) =>
  invoke<LspLocation | LspLocation[] | LspLocationLink[] | null>("lsp_definition", { path, line, character });
const lspReferences = (path: string, line: number, character: number) =>
  invoke<LspLocation[] | null>("lsp_references", { path, line, character });
const lspHover = (path: string, line: number, character: number) =>
  invoke<{ contents?: unknown; range?: LspRange } | null>("lsp_hover", { path, line, character });
const lspRename = (path: string, line: number, character: number, newName: string) =>
  invoke<LspWorkspaceEdit | null>("lsp_rename", { path, line, character, newName });

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Last-resort fallback for when rust-analyzer can't resolve — e.g. a file OUTSIDE
// any Cargo crate (an orphan example at a virtual-workspace root). Finds where the
// word is DEFINED within the same file by a Rust declaration keyword. Intra-file
// only, by design: it never guesses across files (that is rust-analyzer's job).
function intraFileDefinition(model: monaco.editor.ITextModel, word: string): { line: number; col: number } | null {
  const re = new RegExp("\\b(?:struct|enum|fn|trait|type|const|static|union|mod|macro_rules!)\\s+" + escapeRe(word) + "\\b");
  for (let ln = 1; ln <= model.getLineCount(); ln++) {
    const text = model.getLineContent(ln);
    const mm = re.exec(text);
    if (mm) return { line: ln, col: text.indexOf(word, mm.index) + 1 };
  }
  return null;
}

// ── helpers ───────────────────────────────────────────────────────────────────
const uriToPath = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""));
const firstLocation = (
  d: LspLocation | LspLocation[] | LspLocationLink[] | null,
): { uri: string; range: LspRange } | null => {
  if (!d) return null;
  const one = Array.isArray(d) ? d[0] : d;
  if (!one) return null;
  if ("targetUri" in one) return { uri: one.targetUri, range: one.targetSelectionRange ?? one.targetRange };
  return { uri: (one as LspLocation).uri, range: (one as LspLocation).range };
};
const hoverToMarkdown = (contents: unknown): string => {
  if (contents == null) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverToMarkdown).join("\n\n");
  const o = contents as { value?: string; language?: string };
  if (typeof o.value === "string") return o.language ? "```" + o.language + "\n" + o.value + "\n```" : o.value;
  return "";
};

/** Apply an LSP WorkspaceEdit to disk AND to any open model — reaches every file,
 *  open or not, so the rename is truly project-wide. Returns the files touched. */
async function applyWorkspaceEdit(edit: LspWorkspaceEdit, m: typeof monaco, host: LspHost): Promise<number> {
  const byFile = new Map<string, LspTextEdit[]>();
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) byFile.set(uriToPath(dc.textDocument.uri), dc.edits);
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) byFile.set(uriToPath(uri), edits);
  }
  let touched = 0;
  for (const [path, edits] of byFile) {
    const model = host.modelForPath(path);
    if (model) {
      // Apply through Monaco so it stays one undo step and the buffer updates live.
      model.pushEditOperations(
        null,
        edits.map((e) => ({
          range: new m.Range(e.range.start.line + 1, e.range.start.character + 1, e.range.end.line + 1, e.range.end.character + 1),
          text: e.newText,
        })),
        () => null,
      );
      await host.writeFile(path, model.getValue()); // persist the renamed buffer
    } else {
      // Not open: edit the text on disk directly (apply end→start so offsets hold).
      const original = await host.readFile(path);
      const lines = original.split("\n");
      const sorted = [...edits].sort(
        (a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character,
      );
      for (const e of sorted) {
        const s = e.range.start;
        const en = e.range.end;
        if (s.line === en.line) {
          const ln = lines[s.line] ?? "";
          lines[s.line] = ln.slice(0, s.character) + e.newText + ln.slice(en.character);
        } else {
          const head = (lines[s.line] ?? "").slice(0, s.character);
          const tail = (lines[en.line] ?? "").slice(en.character);
          lines.splice(s.line, en.line - s.line + 1, head + e.newText + tail);
        }
      }
      await host.writeFile(path, lines.join("\n"));
    }
    touched++;
  }
  return touched;
}

let diagnosticsBound = false;
let statusBound = false;

/** A discreet bottom-right indicator for rust-analyzer's own indexing progress. */
function setLspStatus(text: string | null): void {
  let el = document.getElementById("lsp-status");
  if (!text) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "lsp-status";
    document.body.appendChild(el);
  }
  el.innerHTML = `<span class="lsp-status-spin"></span><span>${text.replace(/[<>&]/g, "")}</span>`;
}

/** Register semantic LSP features (all supported languages) on `editor`. Idempotent per editor. */
export function installLsp(m: typeof monaco, editor: monaco.editor.IStandaloneCodeEditor, host: LspHost): void {
  const pathAtModel = () => {
    const model = editor.getModel();
    return model ? host.pathForModel(model) : null;
  };

  // Go to Definition — Ctrl+Click and F12 (our own nav reaches unopened files).
  const gotoDefinition = async () => {
    const path = pathAtModel();
    const posn = editor.getPosition();
    const model = editor.getModel();
    if (!path || !posn || !model) return;
    try {
      const d = await lspDefinition(path, posn.lineNumber - 1, posn.column - 1);
      if (d && (d as { indexing?: boolean }).indexing) {
        host.notify("O rust-analyzer ainda está a indexar este crate (demora na 1ª vez). Tenta novamente daqui a pouco.");
        return;
      }
      const loc = firstLocation(d);
      if (loc) {
        await host.openAt(uriToPath(loc.uri), loc.range.start.line + 1, loc.range.start.character + 1);
        return;
      }
      // rust-analyzer found nothing (file outside a Cargo crate, or still
      // indexing) → intra-file name fallback so same-file symbols still navigate.
      const word = model.getWordAtPosition(posn)?.word;
      if (word) {
        const hit = intraFileDefinition(model, word);
        if (hit) {
          await host.openAt(path, hit.line, hit.col);
          host.notify("Definição inferida (no ficheiro) — o rust-analyzer não resolveu aqui.");
          return;
        }
      }
      host.notify("Sem definição encontrada (fora de um crate Cargo, ou símbolo externo).");
    } catch (e) {
      host.notify("LSP (definição): " + String(e));
    }
  };
  editor.addCommand(m.KeyCode.F12, () => void gotoDefinition());
  editor.onMouseDown((e) => {
    if ((e.event.ctrlKey || e.event.metaKey) && e.target.type === m.editor.MouseTargetType.CONTENT_TEXT) {
      if (e.target.position) editor.setPosition(e.target.position);
      void gotoDefinition();
    }
  });

  // Ctrl+hover link effect (edcore.main omits Monaco's gotoDefinition contrib, so
  // we paint the underline ourselves): underline the word under the cursor while
  // Ctrl/⌘ is held, matching VS Code's clickable-symbol affordance.
  let linkDec: string[] = [];
  const clearLink = () => { linkDec = editor.deltaDecorations(linkDec, []); };
  editor.onMouseMove((e) => {
    const model = editor.getModel();
    if ((e.event.ctrlKey || e.event.metaKey) && e.target.type === m.editor.MouseTargetType.CONTENT_TEXT && e.target.position && model) {
      const w = model.getWordAtPosition(e.target.position);
      if (w) {
        linkDec = editor.deltaDecorations(linkDec, [{
          range: new m.Range(e.target.position.lineNumber, w.startColumn, e.target.position.lineNumber, w.endColumn),
          options: { inlineClassName: "lsp-link" },
        }]);
        return;
      }
    }
    clearLink();
  });
  editor.onMouseLeave(clearLink);
  editor.onKeyUp((e) => { if (e.keyCode === m.KeyCode.Ctrl || e.keyCode === m.KeyCode.Meta) clearLink(); });

  // Rename (recursive, F2) — apply the rust-analyzer WorkspaceEdit everywhere.
  editor.addCommand(m.KeyCode.F2, async () => {
    const path = pathAtModel();
    const posn = editor.getPosition();
    const model = editor.getModel();
    if (!path || !posn || !model) return;
    const current = model.getWordAtPosition(posn)?.word ?? "";
    const next = host.promptRename(current);
    if (!next || next === current) return;
    try {
      const edit = await lspRename(path, posn.lineNumber - 1, posn.column - 1, next);
      if (edit && (edit as { indexing?: boolean }).indexing) {
        host.notify("A indexar o crate — tenta o rename daqui a pouco.");
        return;
      }
      if (!edit) { host.notify("Rename não disponível aqui."); return; }
      const n = await applyWorkspaceEdit(edit, m, host);
      host.notify(`Renomeado em ${n} ficheiro(s).`);
    } catch (e) {
      host.notify("LSP (rename): " + String(e));
    }
  });

  // Hover + Find-References providers, registered for EVERY language with a backend
  // server (the backend routes each file to its own server by extension). Hover shows
  // semantic type/docs; Shift+F12 opens Monaco's reference peek from the LSP list.
  for (const lang of LSP_LANGUAGES) {
    m.languages.registerHoverProvider(lang, {
      provideHover: async (model, position) => {
        const path = host.pathForModel(model);
        if (!path) return null;
        try {
          const h = await lspHover(path, position.lineNumber - 1, position.column - 1);
          const md = hoverToMarkdown(h?.contents);
          return md ? { contents: [{ value: md }] } : null;
        } catch {
          return null;
        }
      },
    });
    m.languages.registerReferenceProvider(lang, {
      provideReferences: async (model, position) => {
        const path = host.pathForModel(model);
        if (!path) return [];
        try {
          const refs = (await lspReferences(path, position.lineNumber - 1, position.column - 1)) ?? [];
          return refs.map((r) => ({
            uri: m.Uri.file(uriToPath(r.uri)),
            range: new m.Range(r.range.start.line + 1, r.range.start.character + 1, r.range.end.line + 1, r.range.end.character + 1),
          }));
        } catch {
          return [];
        }
      },
    });
  }

  // Indexing status — one global listener drives the bottom-right indicator so the
  // (possibly minutes-long) first index of a crate is visible, not silent.
  if (!statusBound) {
    statusBound = true;
    let hideTimer: number | undefined;
    void listen<{ root: string; server: string; kind: string; title: string; message: string; percentage: number | null }>("lsp://status", (ev) => {
      const p = ev.payload;
      const proj = p.root.split("/").filter(Boolean).pop() ?? "";
      window.clearTimeout(hideTimer);
      if (p.kind === "end") {
        hideTimer = window.setTimeout(() => setLspStatus(null), 800);
        return;
      }
      const pct = typeof p.percentage === "number" ? ` ${p.percentage}%` : "";
      // Server label comes from the backend, so the pill reads "gopls · …", "rust-analyzer · …".
      setLspStatus(`${p.server || "lsp"} · ${proj}: ${p.message || p.title || "a indexar"}${pct}`);
      hideTimer = window.setTimeout(() => setLspStatus(null), 5000); // fail-safe if progress stalls
    });
  }

  // Diagnostics — one global listener paints rust-analyzer markers on open models.
  if (!diagnosticsBound) {
    diagnosticsBound = true;
    void listen<{ uri: string; diagnostics: LspDiagnostic[] }>("lsp://diagnostics", (ev) => {
      const path = uriToPath(ev.payload.uri);
      const model = host.modelForPath(path);
      if (!model) return;
      const sev = (s?: number) =>
        s === 1 ? m.MarkerSeverity.Error : s === 2 ? m.MarkerSeverity.Warning : s === 3 ? m.MarkerSeverity.Info : m.MarkerSeverity.Hint;
      m.editor.setModelMarkers(
        model,
        "rust-analyzer",
        ev.payload.diagnostics.map((d) => ({
          severity: sev(d.severity),
          message: d.message,
          source: d.source ?? "rust-analyzer",
          startLineNumber: d.range.start.line + 1,
          startColumn: d.range.start.character + 1,
          endLineNumber: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
        })),
      );
    });
  }
}
