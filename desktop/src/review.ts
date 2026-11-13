// Code Review panel (P2) — the right-hand investigation surface.
//
// Drives the offline review engine (the `review_code` / `list_review_analyzers`
// Tauri commands) and answers the three questions the prompt asks of the panel:
// WHERE is the problem, UNDER WHAT CONDITIONS does it bite, and HOW do I verify the
// fix. Findings are grouped by file, filterable by severity / class / origin;
// clicking one opens the file and reveals the exact range, with the full set painted
// as Monaco markers. The primary review + navigation work with the AI switched off.
//
// AI-dependent and CodeMap actions (Ask / Preview fix / Show in CodeMap) are shown
// but gated until phases P3/P4 light them up — availability affects only the action
// that depends on it.

import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./monaco";
import { askAssistant, startContinue, startLocalizedEdit } from "./assistant";
import { startEdit } from "./edit";
import {
  activeFilePath,
  applyReviewEdits,
  clearReviewMarkers,
  contentVersion,
  currentFileContent,
  langForFile,
  openFileAt,
  setReviewGhost,
  setReviewMarkers,
  workspaceRoot,
} from "./workspace";

// ── Backend contract (mirrors crates/tutor-eval/src/review.rs, camelCase) ────────

type FindingClass = "bug" | "risk" | "opportunity";
type ReviewSeverity = "error" | "warning" | "info";
type AnalyzerStatus = "ran" | "failed" | "unavailable" | "skipped";

interface Span {
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  label: string | null;
}
interface FixEdit {
  replacement: string;
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  expected?: string;
}
interface SuggestedFix {
  title: string;
  edits: FixEdit[];
}
interface Finding {
  analyzer: string;
  rule: string | null;
  class: FindingClass;
  severity: ReviewSeverity;
  message: string;
  primary: Span;
  related: Span[];
  evidence: string | null;
  consequence: string | null;
  verification: string | null;
  fix: SuggestedFix | null;
}
interface AnalyzerRun {
  id: string;
  language: string;
  status: AnalyzerStatus;
  detail: string | null;
  filesCovered: number;
}
interface ReviewReport {
  findings: Finding[];
  analyzers: AnalyzerRun[];
  version: string | null;
  // content_version of each analyzed file at review time, keyed by the finding's path.
  // A fix/marker is dropped when the live buffer no longer hashes to this (P0-3).
  fileVersions: Record<string, string>;
}
interface FixVerification {
  applicable: boolean;
  reason: string;
}
interface AnalyzerInfo {
  id: string;
  language: string;
  available: boolean;
  version: string | null;
  note: string | null;
}

// ── State ────────────────────────────────────────────────────────────────────────

let ensureWorkspaceMode: () => void = () => {};
let lastReport: ReviewReport | null = null;
let lastRoot = "";
let flatFindings: Finding[] = []; // currently-rendered findings, indexed by data-idx
let running = false;
// Active filters; empty set = "show all" for that dimension.
const hiddenClasses = new Set<FindingClass>();

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ── Wiring (called once at startup) ──────────────────────────────────────────────

export function initReview(deps: { ensureWorkspaceMode: () => void }): void {
  ensureWorkspaceMode = deps.ensureWorkspaceMode;
  $("#review-close").addEventListener("click", closeReview);
  $("#review-run").addEventListener("click", () => void runReview());
  $("#review-report").addEventListener("click", openReport);
  $("#report-close").addEventListener("click", () => $("#report-overlay").classList.add("hidden"));
  $("#report-copy").addEventListener("click", () => {
    const text = ($("#report-text") as HTMLTextAreaElement).value;
    void navigator.clipboard.writeText(text).then(() => {
      const b = $("#report-copy");
      b.textContent = "Copied ✓";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    });
  });
  $("#report-download").addEventListener("click", () => {
    const text = ($("#report-text") as HTMLTextAreaElement).value;
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "code-review.md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

// ── Report + second-opinion prompt ───────────────────────────────────────────────

function openReport(): void {
  if (!lastReport || lastReport.findings.length === 0) {
    ($("#report-text") as HTMLTextAreaElement).value =
      "Run a review first — there are no findings to report yet.";
  } else {
    ($("#report-text") as HTMLTextAreaElement).value = buildReport(lastReport);
  }
  $("#report-overlay").classList.remove("hidden");
}

function buildReport(report: ReviewReport): string {
  const root = lastRoot || workspaceRoot() || "";
  const n = (c: FindingClass) => report.findings.filter((f) => f.class === c).length;
  const L: string[] = [];
  L.push(`# Code Review Report`, "");
  L.push(`Project: \`${root}\``);
  L.push(`Findings: ${report.findings.length} — ${n("bug")} bug, ${n("risk")} risk, ${n("opportunity")} improvement`, "");
  L.push(`## Coverage`);
  for (const a of report.analyzers)
    L.push(`- ${a.id} (${a.language}): ${a.status}${a.detail ? ` — ${a.detail}` : ""} — ${a.filesCovered} file(s)`);
  L.push("", `## Findings`);
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const k = relative(resolvePath(f.primary.file, root), root);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  for (const [file, items] of groups) {
    L.push("", `### ${file}`);
    for (const f of items) {
      L.push(`- **[${f.class}]** \`${f.analyzer}\`${f.rule ? ` ${f.rule}` : ""} at ${f.primary.startLine}:${f.primary.startCol} — ${f.message}`);
      if (f.consequence) L.push(`  - If unaddressed: ${f.consequence}`);
      if (f.fix) L.push(`  - Suggested fix: ${f.fix.title}`);
    }
  }
  L.push("", `## Second-opinion prompt (paste into any AI)`, "", "```text", secondOpinionPrompt(report, root), "```");
  return L.join("\n");
}

function secondOpinionPrompt(report: ReviewReport, root: string): string {
  const L: string[] = [];
  L.push(
    `You are a senior code reviewer. Below are findings from LOCAL static analyzers (clippy, go vet, ruff) on the project at ${root}.`,
    `A tool warning is a HYPOTHESIS, not a confirmed bug — verify each against the actual code.`,
    ``,
    `For EACH finding, open the cited file at the line and decide, citing evidence from the real code:`,
    `1. Is it a real BUG (a demonstrated failing path), a conditional RISK, an OPPORTUNITY (clarity/perf/style), or a GAP (missing handling or test)?`,
    `2. The smallest correct fix that preserves intended behaviour — or why it should be left as is.`,
    `3. A concrete test that would confirm or refute it.`,
    ``,
    `Findings:`,
  );
  report.findings.forEach((f, i) =>
    L.push(
      `${i + 1}. [${f.class}] ${f.analyzer}${f.rule ? " " + f.rule : ""} — ${relative(resolvePath(f.primary.file, root), root)}:${f.primary.startLine} — ${f.message}`,
    ),
  );
  return L.join("\n");
}

export function openReview(): void {
  $("#assistant-overlay")?.classList.add("hidden"); // the two right drawers are exclusive
  $("#review-overlay").classList.remove("hidden");
  void refreshAnalyzers();
  if (!lastReport) {
    $("#review-results").innerHTML = emptyHint();
  }
}

export function closeReview(): void {
  $("#review-overlay").classList.add("hidden");
}

// ── Run ──────────────────────────────────────────────────────────────────────────

async function runReview(): Promise<void> {
  if (running) return;
  const root = workspaceRoot();
  if (!root) {
    $("#review-results").innerHTML =
      `<div class="review-note">Open a project folder first (Explorer → Open Folder), then run a review.</div>`;
    return;
  }
  const scope = ($("#review-scope") as HTMLSelectElement).value; // file | changes | project
  const path = scope === "file" ? activeFilePath() : null;
  if (scope === "file" && !path) {
    $("#review-results").innerHTML =
      `<div class="review-note">Open a file to review it, or pick another scope.</div>`;
    return;
  }

  running = true;
  clearReviewMarkers(); // drop stale squiggles/ghost from the previous run
  const runBtn = $("#review-run") as HTMLButtonElement;
  runBtn.disabled = true;
  runBtn.textContent = "Reviewing…";
  $("#review-results").innerHTML = loadingHtml(scope);
  try {
    const report = await invoke<ReviewReport>("review_code", {
      root,
      scope,
      path,
      version: null,
    });
    lastReport = report;
    render(report, root);
  } catch (e) {
    $("#review-results").innerHTML = `<div class="review-note err">Review failed: ${esc(String(e))}</div>`;
  } finally {
    running = false;
    runBtn.disabled = false;
    runBtn.textContent = "Review";
  }
}

// ── Analyzer availability strip ──────────────────────────────────────────────────

async function refreshAnalyzers(): Promise<void> {
  try {
    const list = await invoke<AnalyzerInfo[]>("list_review_analyzers");
    const chips = list
      .map((a) => {
        const cls = a.available ? "ok" : "off";
        const title = a.available
          ? `${a.id} ${a.version ?? ""}`.trim()
          : `${a.id} not installed${a.note ? " — " + a.note : ""}`;
        return `<span class="rv-tool ${cls}" title="${esc(title)}">${esc(a.id)}</span>`;
      })
      .join("");
    $("#review-tools").innerHTML = chips;
  } catch {
    $("#review-tools").innerHTML = "";
  }
}

// ── Render ───────────────────────────────────────────────────────────────────────

function render(report: ReviewReport, root: string): void {
  renderCoverage(report);
  renderFilters(report);

  const visible = report.findings.filter((f) => !hiddenClasses.has(f.class));
  if (visible.length === 0) {
    // "No findings" is only honest when at least one analyzer actually ran. If the
    // analyzers DID report issues but the current scope filtered them out, say so —
    // that is the difference between "clean here" and "scanned nothing".
    const anyRan = report.analyzers.some((a) => a.status === "ran");
    const total = report.findings.length;
    const coveredElsewhere = report.analyzers.reduce((n, a) => n + a.filesCovered, 0);
    let note = "";
    if (total > 0) {
      note = `All ${total} findings are filtered out — re-enable a class above.`;
    } else if (anyRan && coveredElsewhere > 0) {
      note = `This scope looks clean. The analyzers reported issues in ${coveredElsewhere} file(s) outside it — switch scope to “Whole project” and run again to see them.`;
    } else if (anyRan) {
      note = `No findings — the analyzed scope is clean.`;
    } else {
      note = `Nothing analyzed yet — install a language's analyzer or pick another scope.`;
    }
    const ok = anyRan && total === 0 && coveredElsewhere === 0;
    $("#review-results").innerHTML = ok
      ? `<div class="rv-clean">${CHECK_ICON}<div>${note}</div></div>`
      : `<div class="review-note">${note}</div>`;
    return;
  }

  // Group by file; give each visible finding a stable index for button wiring.
  lastRoot = root;
  flatFindings = visible;
  const groups = new Map<string, number[]>();
  visible.forEach((f, i) => {
    const key = resolvePath(f.primary.file, root);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(i);
  });

  let html = `<div class="rv-summary">${visible.length} finding${visible.length === 1 ? "" : "s"} in ${groups.size} file${groups.size === 1 ? "" : "s"}</div>`;
  let gi = 0;
  for (const [abs, idxs] of groups) {
    const rel = relative(abs, root);
    const worst = worstClass(idxs.map((i) => flatFindings[i]));
    const delay = Math.min(gi * 45, 450);
    gi++;
    html += `<div class="rv-file" style="animation-delay:${delay}ms"><div class="rv-file-h">${classIcon(worst)}<span class="rv-file-name">${esc(rel)}</span><span class="rv-file-n">${idxs.length}</span></div>`;
    for (const i of idxs) html += findingRow(flatFindings[i], i);
    html += `</div>`;
  }
  const results = $("#review-results");
  results.innerHTML = html;

  // Click a row body → navigate; click "Apply fix" → apply the analyzer's edit.
  results.querySelectorAll<HTMLElement>(".rv-item").forEach((row) => {
    row.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".rv-fixbtn")) return;
      navigate(flatFindings[Number(row.dataset.idx)]);
    });
  });
  results.querySelectorAll<HTMLElement>(".rv-askbtn[data-ask]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      askAboutFinding(flatFindings[Number(btn.dataset.ask)]);
    });
  });
  results.querySelectorAll<HTMLElement>(".rv-askbtn[data-edit]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void fixWithAI(flatFindings[Number(btn.dataset.edit)]);
    });
  });
  results.querySelectorAll<HTMLButtonElement>(".rv-fixbtn").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const res = await applyFix(flatFindings[Number(btn.dataset.idx)]);
      if (!res.ok) {
        const orig = btn.textContent;
        btn.textContent = `⚠ ${res.reason ?? "failed"}`;
        btn.classList.add("warn");
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove("warn");
        }, 2600);
      }
    });
  });
}

function findingRow(f: Finding, idx: number): string {
  const where = `${f.primary.startLine}:${f.primary.startCol}`;
  const rule = f.rule ? `<span class="rv-rule">${esc(f.rule)}</span>` : "";
  const evid = f.evidence ? `<div class="rv-evid">${esc(f.evidence)}</div>` : "";
  const cons = f.consequence ? `<div class="rv-meta"><b>If unaddressed:</b> ${esc(f.consequence)}</div>` : "";
  const verf = f.verification ? `<div class="rv-meta"><b>Verify:</b> ${esc(f.verification)}</div>` : "";
  const rel =
    f.related.length > 0
      ? `<div class="rv-meta rv-related">${f.related.length} related location${f.related.length > 1 ? "s" : ""}</div>`
      : "";
  // Actions: a deterministic "Apply fix" when the analyzer offers a safe one, plus
  // "Ask AI" (second opinion — streams the analysis from the local model).
  const fixTitle = f.fix ? `<span class="rv-fix-t">💡 ${esc(f.fix.title)}</span>` : `<span class="rv-fix-t"></span>`;
  const fixBtn = f.fix ? `<button class="rv-fixbtn" data-idx="${idx}">Apply fix</button>` : "";
  const actions = `<div class="rv-fix">${fixTitle}<button class="rv-askbtn" data-ask="${idx}">Ask AI</button><button class="rv-askbtn" data-edit="${idx}">Fix with AI</button>${fixBtn}</div>`;
  return `<div class="rv-item cls-${f.class}" data-idx="${idx}">
    <div class="rv-row1">
      <span class="rv-badge ${f.class}">${classIcon(f.class)} ${classLabel(f.class)}</span>
      <span class="rv-origin">${esc(f.analyzer)}</span>
      ${rule}
      <span class="rv-loc">${where}</span>
    </div>
    <div class="rv-msg">${esc(f.message)}</div>
    ${evid}${cons}${verf}${actions}${rel}
  </div>`;
}

function renderCoverage(report: ReviewReport): void {
  const parts = report.analyzers.map((a) => {
    const label =
      a.status === "ran"
        ? `${a.id} ✓ (${a.filesCovered} file${a.filesCovered === 1 ? "" : "s"})`
        : a.status === "failed"
          ? `${a.id} ✗ failed`
          : a.status === "unavailable"
            ? `${a.id} — unavailable`
            : `${a.id} — skipped`;
    const title = a.detail ? esc(a.detail) : "";
    return `<span class="rv-cov ${a.status}" title="${title}">${esc(label)}</span>`;
  });
  $("#review-coverage").innerHTML = parts.join("");
}

function renderFilters(report: ReviewReport): void {
  const counts: Record<FindingClass, number> = { bug: 0, risk: 0, opportunity: 0 };
  for (const f of report.findings) counts[f.class]++;
  const chip = (c: FindingClass) => {
    const on = !hiddenClasses.has(c);
    return `<button class="rv-filter ${c} ${on ? "on" : "off"}" data-class="${c}">${classLabel(c)} ${counts[c]}</button>`;
  };
  const host = $("#review-filters");
  host.innerHTML = (["bug", "risk", "opportunity"] as FindingClass[]).map(chip).join("");
  host.querySelectorAll<HTMLElement>(".rv-filter").forEach((b) => {
    b.addEventListener("click", () => {
      const c = b.dataset.class as FindingClass;
      if (hiddenClasses.has(c)) hiddenClasses.delete(c);
      else hiddenClasses.add(c);
      if (lastReport) render(lastReport, lastRoot || workspaceRoot() || "");
    });
  });
}

// ── Navigation ───────────────────────────────────────────────────────────────────

function navigate(f: Finding): void {
  const report = lastReport;
  const root = lastRoot;
  if (!report) return;
  const abs = resolvePath(f.primary.file, root);
  ensureWorkspaceMode();
  void openFileAt(abs, f.primary.startLine, f.primary.startCol).then(() => {
    // P0-3: never paint a stale squiggle. If the live buffer no longer matches the
    // revision the review analyzed, the line/column spans may point at moved code, so we
    // clear markers and tell the developer to re-run instead of painting over new code.
    const analyzedVersion = report.fileVersions?.[f.primary.file];
    const live = currentFileContent(abs);
    if (analyzedVersion && live != null && contentVersion(live) !== analyzedVersion) {
      setReviewMarkers(abs, []);
      setReviewGhost(f.primary.startLine, "this file changed — re-run Review to refresh");
      return;
    }
    // Paint every finding for this file as a marker so the evidence stays visible
    // (the squiggle colour IS the problem's severity colour).
    const markers = report.findings
      .filter((x) => resolvePath(x.primary.file, root) === abs)
      .map((x) => ({
        severity:
          x.severity === "error"
            ? monaco.MarkerSeverity.Error
            : x.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        message: `${x.rule ? x.rule + ": " : ""}${x.message}`,
        startLineNumber: x.primary.startLine,
        startColumn: x.primary.startCol,
        endLineNumber: x.primary.endLine,
        endColumn: Math.max(x.primary.startCol + 1, x.primary.endCol),
        source: x.analyzer,
      }));
    setReviewMarkers(abs, markers);

    // Inline placeholder at the line: the suggested fix (code / "remove this"), or the
    // message when there is no auto-fix. Re-running the review clears it when resolved.
    const hint = f.fix ? `fix: ${f.fix.title}` : f.message;
    setReviewGhost(f.primary.startLine, hint.length > 90 ? hint.slice(0, 90) + "…" : hint);
  });
}

/** Open the Dev Assistant with a second-opinion prompt about this finding. */
function askAboutFinding(f: Finding): void {
  const loc = `${relative(resolvePath(f.primary.file, lastRoot), lastRoot)}:${f.primary.startLine}:${f.primary.startCol}`;
  const prompt = [
    `A local static analyzer (${f.analyzer}${f.rule ? " " + f.rule : ""}) reported this at ${loc}:`,
    ``,
    `> ${f.message}`,
    ``,
    `Treat it as a HYPOTHESIS, not a confirmed bug. Looking at the real code at that location, tell me:`,
    `1. Is it a genuine BUG, a conditional RISK, an OPPORTUNITY (clarity/perf/style), or a false positive — with evidence.`,
    `2. The smallest correct fix that preserves intended behaviour, or why to leave it.`,
    `3. A concrete test that would confirm or refute it.`,
  ].join("\n");
  askAssistant(prompt);
}

/** Delegate the fix to the AI. A LOCALIZED edit of just the finding's region (plus a little
 *  context) — the agent rewrites only the broken lines, not the whole file. That is faster,
 *  cannot truncate a long file mid-stream, and streams into the editor with the inline
 *  Accept/Reject widget. Falls back to a whole-file "Edit with me" only if the file isn't open. */
async function fixWithAI(f: Finding): Promise<void> {
  ensureWorkspaceMode();
  const abs = resolvePath(f.primary.file, lastRoot);
  const name = abs.split("/").pop() ?? abs;
  const lang = langForFile(name);

  // Structural end-of-file breakage (an unclosed delimiter) cannot be fixed by a localized
  // edit around the cited line: the compiler points its caret at (or past) EOF, but the fix —
  // the missing closers, and anything the still-open code needs to compile (a final match arm,
  // a referenced-but-undefined item) — belongs at the END of the file. Rewriting the two lines
  // around the primary span closes nothing. Route these to file COMPLETION (append at EOF),
  // the same path a method edit takes when the file is too incomplete to resolve the target.
  if (isStructuralIncomplete(f)) {
    const why =
      `The file is incomplete — the compiler reports "${f.message}" (around line ${f.primary.startLine}). ` +
      `Complete it from where it stops so it compiles: close every still-open block/delimiter at the ` +
      `very end, and add anything the existing code already refers to but is missing (for example a ` +
      `final \`_ =>\` match arm, or a function it calls). Do not rewrite or repeat existing code.`;
    void startContinue(abs, why);
    return;
  }

  const instruction = `Fix the ${f.analyzer}${f.rule ? " " + f.rule : ""} issue at line ${f.primary.startLine}: ${f.message}. Change only what is necessary.`;

  // Open the file in the editor (the localized edit streams INTO it); then target the
  // finding's line span, padded by 2 lines of context on each side.
  await openFileAt(abs, f.primary.startLine, f.primary.startCol);
  const content = currentFileContent(abs);
  if (content != null) {
    const lines = content.split("\n");
    const sl = Math.max(1, f.primary.startLine - 2);
    const el = Math.min(lines.length, Math.max(f.primary.endLine, f.primary.startLine) + 2);
    const selected = lines.slice(sl - 1, el).join("\n");
    void startLocalizedEdit(abs, sl, el, selected, lang, instruction);
    return;
  }
  // File not open / unreadable → whole-file "Edit with me" as a fallback.
  try {
    const disk = await invoke<string>("read_text_file", { path: abs });
    startEdit(abs, disk, lang, instruction);
  } catch {
    /* nothing to edit */
  }
}

/** Apply ALL edits of the analyzer's machine fix as one undoable change. */
async function applyFix(f: Finding): Promise<{ ok: boolean; reason?: string }> {
  if (!f.fix || f.fix.edits.length === 0) return { ok: false, reason: "no fix" };
  ensureWorkspaceMode();
  const abs = resolvePath(f.fix.edits[0].file || f.primary.file, lastRoot);

  // P0-3 identity check — the authority is the backend. Verify the live buffer is still
  // the exact revision this fix was computed against (and that the target snippet is
  // unchanged) BEFORE touching the file; otherwise the developer's edits are preserved
  // and they are told to re-run. The analyzed version comes from the report, keyed by
  // the finding's own path string.
  const analyzedVersion = lastReport?.fileVersions?.[f.primary.file];
  const currentSource = currentFileContent(abs);
  if (analyzedVersion && currentSource != null) {
    const v = await invoke<FixVerification>("verify_review_fix", {
      currentSource,
      analyzedVersion,
      fix: f.fix,
    });
    if (!v.applicable) return { ok: false, reason: v.reason };
  }

  const res = await applyReviewEdits(
    abs,
    f.fix.edits.map((e) => ({
      startLine: e.startLine,
      startCol: e.startCol,
      endLine: e.endLine,
      endCol: e.endCol,
      replacement: e.replacement,
    })),
    analyzedVersion,
  );
  if (res.ok) setReviewGhost(null, ""); // code changed — re-run Review to refresh
  return res;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** A parse error whose fix lives at END-OF-FILE, not at the cited line. An unclosed delimiter
 *  carets at (or past) EOF, but the closer — and whatever the unterminated code still needs to
 *  compile — belongs after the last line, so a localized edit around the primary span can never
 *  resolve it. Detected from the message or from a related span the compiler labels. */
function isStructuralIncomplete(f: Finding): boolean {
  const hit = (s: string | null) => (s ?? "").toLowerCase().includes("unclosed delimiter");
  return hit(f.message) || f.related.some((s) => hit(s.label));
}

function classLabel(c: FindingClass): string {
  return c === "bug" ? "Bug" : c === "risk" ? "Risk" : "Improve";
}

// Professional, nature-specific icons: bug = X in an octagon (error), risk = alert
// triangle (conditional), improvement = lightbulb (optional), clean = check.
function classIcon(c: FindingClass): string {
  if (c === "bug")
    return `<svg class="rv-ic bug" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9L7.9 2Z"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`;
  if (c === "risk")
    return `<svg class="rv-ic risk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5M12 17h.01"/></svg>`;
  return `<svg class="rv-ic opp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3Z"/></svg>`;
}
const CHECK_ICON = `<svg class="rv-ic ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

function worstClass(items: Finding[]): FindingClass {
  if (items.some((f) => f.class === "bug")) return "bug";
  if (items.some((f) => f.class === "risk")) return "risk";
  return "opportunity";
}

function loadingHtml(scope: string): string {
  const where =
    scope === "file" ? "the current file" : scope === "changes" ? "working changes" : "the whole project";
  return `<div class="rv-loading"><span class="rv-spin"></span><div><div class="rv-load-t">Analyzing ${where}…</div><div class="rv-load-s">running clippy · go vet · ruff — the first pass can take a moment</div></div></div>`;
}

/** Resolve an analyzer-reported path (often `./x` or `src/x`) to an absolute path. */
function resolvePath(file: string, root: string): string {
  let f = file.replace(/^\.\//, "");
  if (f.startsWith("/")) return f;
  return `${root.replace(/\/$/, "")}/${f}`;
}

function relative(abs: string, root: string): string {
  const r = root.replace(/\/$/, "") + "/";
  return abs.startsWith(r) ? abs.slice(r.length) : abs;
}

function emptyHint(): string {
  return `<div class="review-note">Pick a scope and press <b>Review</b>. Runs local analyzers only — no network, no model needed.</div>`;
}
