// Anchored edits (`dxpatch`) — the content-anchored editing primitive.
//
// Reverse-engineered from the Claude Code `Edit` tool and Antigravity's Cascade: an edit is
// addressed by the EXACT TEXT it replaces, never by a line number. The model emits one or
// more {old, new} hunks; we locate each `old` in the LIVE buffer and require it to match
// EXACTLY ONCE. Zero matches → refuse (the file moved / the snippet was not copied verbatim);
// more than one → refuse (ambiguous, needs more surrounding context). We never guess a
// location, so a correction can never land on the wrong — or an ambiguous — line, and the
// rest of the file stays byte-for-byte identical (no whole-file rewrite).
//
// This module is PURE (no DOM, no Monaco, no Tauri) so the resolver can be unit-tested in
// isolation. The editor glue in assistant.ts turns the resolved span into a reviewable edit.

export interface PatchHunk {
  old: string;
  new: string;
}
/** One file's worth of anchored hunks. */
export interface PatchFile {
  file: string;
  edits: PatchHunk[];
}
/** A `dxpatch` directive. A single-file patch (`{file, edits}`) and a multi-file patch
 *  (`{files: [{file, edits}, …]}`) are BOTH accepted; the result is always normalized to
 *  `files[]`. Multi-file is resolved atomically by the caller: if ANY file/hunk fails to
 *  anchor, the whole changeset is refused and nothing is applied. */
export interface DxPatch {
  files: PatchFile[];
}

/** Parse and validate one file's `edits` array. Returns null (→ the whole patch is refused,
 *  never applied to a guessed subset) if it is not an array, carries a non-string/empty
 *  anchor, or reduces to zero effective hunks. No-op hunks (`old === new`) are dropped. */
function parseEdits(raw: unknown): PatchHunk[] | null {
  if (!Array.isArray(raw)) return null;
  const edits: PatchHunk[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const e = r as Record<string, unknown>;
    if (typeof e.old !== "string" || typeof e.new !== "string") return null;
    // An empty anchor would "match" at every position — reject it rather than guess.
    if (e.old.length === 0) return null;
    // A no-op hunk is harmless but pointless; drop it so it can't widen the span.
    if (e.old === e.new) continue;
    edits.push({ old: e.old, new: e.new });
  }
  return edits.length === 0 ? null : edits;
}

/** Extract the first ```dxpatch block, tolerating an unclosed trailing fence (streaming).
 *  Returns null unless it carries at least one file with one well-formed {old, new} hunk.
 *  Accepts the legacy single-file shape and the multi-file `files[]` shape; the same file
 *  named twice is refused (ambiguous — its hunks belong in ONE entry). */
export function parsePatchDirective(text: string): DxPatch | null {
  const m = text.match(/```dxpatch\s*\n([\s\S]*?)```/);
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[1].trim());
  } catch {
    return null; // malformed JSON
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  // Multi-file form: {files: [{file, edits}, …]}. One malformed file refuses the whole patch.
  if (Array.isArray(o.files)) {
    const files: PatchFile[] = [];
    const seen = new Set<string>();
    for (const raw of o.files) {
      if (!raw || typeof raw !== "object") return null;
      const f = raw as Record<string, unknown>;
      if (typeof f.file !== "string") return null;
      const edits = parseEdits(f.edits);
      if (!edits) return null;
      if (seen.has(f.file)) return null; // same file twice is ambiguous — merge into one entry
      seen.add(f.file);
      files.push({ file: f.file, edits });
    }
    return files.length === 0 ? null : { files };
  }
  // Legacy single-file form: {file, edits}.
  if (typeof o.file !== "string") return null;
  const edits = parseEdits(o.edits);
  if (!edits) return null;
  return { files: [{ file: o.file, edits }] };
}

export type PatchResolve =
  | { ok: true; startLine: number; endLine: number; original: string; proposed: string }
  | { ok: false; reason: string };

/** Anchor every hunk to a UNIQUE location in `content`, then compute the minimal contiguous
 *  LINE span covering all hunks together with its replacement text. The whole patch is
 *  resolved before anything is applied (atomic): if ANY hunk fails to anchor uniquely, the
 *  patch is refused and nothing changes — the caller surfaces `reason` so the model can
 *  re-emit with more context. Line/column arithmetic from the model is never trusted. */
export function resolveAnchoredEdits(content: string, edits: PatchHunk[]): PatchResolve {
  // 1. Resolve each hunk to a unique char offset BEFORE touching anything.
  const hits: { start: number; end: number }[] = [];
  for (const h of edits) {
    const first = content.indexOf(h.old);
    if (first === -1) {
      return {
        ok: false,
        reason: `trecho não encontrado — copia-o exactamente como está no ficheiro: ${preview(h.old)}`,
      };
    }
    if (content.indexOf(h.old, first + 1) !== -1) {
      return {
        ok: false,
        reason: `trecho ambíguo (aparece mais do que uma vez) — inclui mais linhas à volta para o tornar único: ${preview(h.old)}`,
      };
    }
    hits.push({ start: first, end: first + h.old.length });
  }
  // 2. Order by position; reject overlapping hunks (they can't both apply cleanly).
  hits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].start < hits[i - 1].end) {
      return { ok: false, reason: "dois trechos sobrepõem-se — separa-os em edições distintas" };
    }
  }
  // 3. Minimal contiguous span of WHOLE lines covering the first..last hunk.
  const lines = content.split("\n");
  const startLine = lineAt(content, hits[0].start);
  const endLine = lineAt(content, hits[hits.length - 1].end - 1);
  const original = lines.slice(startLine - 1, endLine).join("\n");
  // 4. Apply the hunks within that span. Each `old` is unique in the whole file, so it is
  //    unique inside this (narrower) span too — swap the first (= only) occurrence, treating
  //    both needle and replacement as literals.
  let proposed = original;
  for (const h of edits) proposed = replaceOnceLiteral(proposed, h.old, h.new);
  return { ok: true, startLine, endLine, original, proposed };
}

/** 1-based line number of a character offset. */
function lineAt(content: string, offset: number): number {
  let line = 1;
  const stop = Math.min(offset, content.length);
  for (let i = 0; i < stop; i++) if (content[i] === "\n") line++;
  return line;
}

/** Replace the first occurrence of `needle` with `replacement`, treating BOTH as literals
 *  (`String.replace` with a string needle still interprets `$&`, `$1`… in the replacement,
 *  which would corrupt code containing `$`). */
function replaceOnceLiteral(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  if (i === -1) return haystack;
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

/** A short, single-line preview of a snippet for an error message. */
function preview(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `"${one.slice(0, 60)}…"` : `"${one}"`;
}

// ── Whole-file-rewrite safety (Phase 3) ────────────────────────────────────────────
//
// A whole-file generation (dxcode / "Edit with me") that is truncated or drastically
// shorter than the file it replaces will silently destroy working code — the danger the
// owner flagged for production. Before such a write LANDS, these guards catch the two
// near-certain signs of a partial generation: a file that WAS delimiter-balanced coming
// back UNbalanced (cut off mid-structure), and an extreme shrink. New/empty/stub files
// (nothing substantial to protect) are never blocked.

export type RewriteVerdict = { ok: true } | { ok: false; reason: string };

/** Languages whose files are reliably delimiter-balanced, so an imbalance in the rewrite is
 *  a strong truncation signal. (Python blocks are indentation-based, so only its ()/[]/{}
 *  are checked — weaker, but extreme-shrink still guards it.) */
function balancedLang(lang: string): boolean {
  return ["rust", "go", "typescript", "javascript", "python", "c", "cpp", "java", "json"].includes(lang);
}

/** Decide whether a whole-file REWRITE of `original` into `produced` is safe to apply. */
export function assessWholeFileRewrite(original: string, produced: string, lang: string): RewriteVerdict {
  const orig = original.trim();
  const prod = produced.trim();
  if (orig.length < 40) return { ok: true }; // new/stub file: nothing substantial to protect
  if (prod.length === 0) return { ok: false, reason: "a geração ficou vazia" };
  // Extreme shrink — losing two thirds of a real file is almost always a partial generation.
  if (orig.length > 200 && prod.length < orig.length * 0.33) {
    const pct = Math.round((prod.length / orig.length) * 100);
    return { ok: false, reason: `a geração ficou com ${pct}% do tamanho original — parece truncada/parcial` };
  }
  // Truncation — the file parsed with balanced delimiters but the rewrite does not.
  if (balancedLang(lang) && isDelimiterBalanced(original) && !isDelimiterBalanced(produced)) {
    return { ok: false, reason: "a geração termina com delimitadores por fechar — parece cortada a meio" };
  }
  return { ok: true };
}

/** True when every (){}[] in `code` is matched and properly nested, ignoring delimiters that
 *  appear inside string/char literals and //-line or block comments. A premature closer (one
 *  with no open partner) or any unclosed opener at EOF makes it false. Covers C-family + Rust +
 *  Go + JS/TS strings (", ', `) and comments (//, / * ... * /); good enough to flag truncation. */
export function isDelimiterBalanced(code: string): boolean {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const openers = new Set(["(", "[", "{"]);
  const stack: string[] = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = i + 1 < n ? code[i + 1] : "";
    // Comments.
    if (c === "/" && next === "/") {
      const nl = code.indexOf("\n", i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) return false; // unterminated block comment → truncated
      i = end + 2;
      continue;
    }
    // String / char literals (", ', `). Scan to the matching, unescaped terminator.
    if (c === '"' || c === "'" || c === "`") {
      i++;
      let closed = false;
      while (i < n) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === c) {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) return false; // unterminated string → truncated
      continue;
    }
    if (openers.has(c)) {
      stack.push(c);
    } else if (c in pairs) {
      if (stack.pop() !== pairs[c]) return false; // premature / mismatched closer
    }
    i++;
  }
  return stack.length === 0;
}
