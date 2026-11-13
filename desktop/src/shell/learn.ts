// shell/learn.ts — Fase 3: Learning Track (percurso de aprendizagem) real.
//
// Liga ao backend REAL (comandos Tauri sobre os crates `tutor-*`): o catálogo de
// linguagens vem de `list_courses`, a árvore de unidades/passos de `get_course`,
// a correcção dos `challenge` de `submit_step` e as pistas de `request_hint`.
// Nada de cursos embutidos em JSON — ao contrário do protótipo, que simula.
//
// Contratos de honestidade (ver docs/ui-rewrite/PLAN.md):
//   • A correcção de um `challenge` é decidida pelos TESTES do backend, nunca por
//     um modelo nem por heurística do cliente.
//   • O gabarito só viaja depois de os testes passarem — o backend serializa
//     `gabarito: null` numa falha, e esta vista mostra apenas o que vier.
//   • Em estudo, a IA tutora (explica/dá pista mínima via `request_hint`): NUNCA
//     escreve o buffer Monaco do aluno nem entrega a solução.
//   • O que ainda não está ligado fica visível com «not implemented yet» (ver a
//     nota dos bastidores e docs/ui-rewrite/PENDING.md). Nada simulado em silêncio.

import { monaco } from "../monaco";
import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { svg, hydrate } from "./icons";
import { VIEW, RP, openTab, goPane, toast, addCommand, type Tab } from "./index";

// ─────────────────────────── DTOs (camelCase, exactos do main.rs) ───────────────────────────
interface CourseSummary { id: string; language: string; title: string; level: string; summary: string }
interface Step {
  kind: string; id: string; title: string; points: number; intro: string; difficulty: number;
  body: string; prompt: string; target: string; explanation: string; lineComments: string[];
  placeholderPolicy: string; installCommands: string[]; runCommand: string; dependencies: string[];
  instructions: string; entry: string; starter: string;
}
interface Unit { id: string; title: string; intro: string; difficulty: number; level: string; steps: Step[] }
interface Course { id: string; language: string; title: string; level: string; summary: string; units: Unit[] }
interface Correctness { passed: boolean; summary: string; raw: string }
interface Gabarito { solution: string; time: string; space: string; justification: string }
interface Complexity { bigO: string; rSquared: number; exponent: number; confidence: string; ranking: Array<[string, number]> }
interface Assessment { correctness: Correctness; complexity: Complexity | null; expected: string | null; gabarito: Gabarito | null }
interface Hint { text: string; provider: string; level: number }
interface RunResult { ok: boolean; stdout: string; stderr: string }

// ─────────────────────────── Estado persistido ───────────────────────────
interface LtState {
  lang: string | null;
  levels: string[];
  done: Record<string, boolean>;   // dk(stepId) → concluído
  open: Record<string, boolean>;   // unitId → unidade expandida na árvore
  show: Record<string, boolean>;   // dk(stepId) → gabarito/alvo do drill revelado
  hints: Record<string, number>;   // dk(stepId) → nível de pista já pedido (0..3)
  code: Record<string, string>;    // dk(stepId) → buffer do aluno
  cur: string | null;              // passo actual
}

const LS_KEY = "dxtutor.lt";
const LEVEL_IDS = ["basic", "intermediate", "advanced"];

const defaultState = (): LtState => ({ lang: null, levels: [], done: {}, open: {}, show: {}, hints: {}, code: {}, cur: null });

function loadState(): LtState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<LtState>;
    return { ...defaultState(), ...parsed };
  } catch { return defaultState(); }
}

const state: LtState = loadState();

let saveTimer: number | undefined;
function save(): void { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* storage indisponível */ } }
function scheduleSave(): void { clearTimeout(saveTimer); saveTimer = window.setTimeout(save, 400); }

// ─────────────────────────── Caches e estado transitório ───────────────────────────
let courseCache: Course | null = null;
let loadError = "";
let hoodOpen = false;
let onbChoice: { lang: string | null; levels: string[] } = { lang: null, levels: [] };

// Resultados que só existem depois de uma acção real do backend (não persistidos:
// o gabarito, por contrato, só viaja ao passar — não o guardamos no dispositivo).
const submission = new Map<string, Assessment | "loading" | { error: string }>();
const drillRun = new Map<string, RunResult | "loading" | { error: string }>();
const hintLog = new Map<string, Hint[]>();

// ─────────────────────────── Utilitários ───────────────────────────
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const dk = (id: string): string => (state.lang || "") + ":" + id;
const isDone = (id: string): boolean => !!state.done[dk(id)];

const MONACO_LANG: Record<string, string> = { rust: "rust", go: "go", python: "python", javascript: "javascript", typescript: "typescript", c: "c", cpp: "cpp" };
const EXT: Record<string, string> = { rust: "rs", go: "go", python: "py", javascript: "js", typescript: "ts", c: "c", cpp: "cpp" };
const GLYPH: Record<string, string> = { rust: "🦀", go: "💪", python: "🐍", javascript: "⚡", typescript: "🅣", c: "🔧", cpp: "🔧" };
const NICE: Record<string, string> = { rust: "Rust", go: "Go", python: "Python", javascript: "JavaScript", typescript: "TypeScript", c: "C", cpp: "C++" };
const BADGE: Record<string, string> = { concept: "lt.badge.concept", drill: "lt.badge.drill", challenge: "lt.badge.challenge" };

const monacoLang = (lang: string): string => MONACO_LANG[lang] ?? "plaintext";
const extFor = (lang: string): string => EXT[lang] ?? "txt";
const glyph = (lang: string): string => GLYPH[lang] ?? "📘";
const niceLang = (lang: string): string => NICE[lang] ?? (lang.charAt(0).toUpperCase() + lang.slice(1));
const commentPrefix = (): string => (state.lang === "python" ? "#" : "//");
const fileName = (step: Step): string => `${step.id}.${extFor(state.lang || "")}`;

/** Marcador de dificuldade (estrelas). `concept` e dificuldade 0 não mostram nada. */
function stars(d: number, kind?: string): string {
  if (kind === "concept" || !d) return "";
  const n = d <= 3 ? 1 : d <= 7 ? 2 : d <= 12 ? 3 : d <= 18 ? 4 : 5;
  return `<span class="lt-stars" title="${esc(t("lt.challenge"))} ${n}/5">${"★".repeat(n)}<i>${"★".repeat(5 - n)}</i></span>`;
}

// Markdown compacto (headings, blocos de código, listas, negrito, itálico, code inline).
function mdInline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
}
function md(src: string): string {
  const out: string[] = [];
  String(src || "").split(/```/).forEach((p, i) => {
    if (i % 2) { out.push(`<pre>${esc(p.replace(/^[a-z]*\n/, "").replace(/\n$/, ""))}</pre>`); return; }
    p.split(/\n{2,}/).forEach((raw) => {
      const b = raw.trim(); if (!b) return;
      if (/^#{1,4}\s/.test(b)) {
        const lines = b.split("\n");
        out.push(`<h3>${mdInline(lines[0].replace(/^#+\s*/, ""))}</h3>`);
        if (lines.length > 1) out.push(`<p>${mdInline(lines.slice(1).join(" "))}</p>`);
      } else if (/^\s*[-*]\s/.test(b)) {
        out.push("<ul>" + b.split(/\n(?=\s*[-*]\s)/).map((l) => `<li>${mdInline(l.replace(/^\s*[-*]\s+/, "").replace(/\n\s*/g, " "))}</li>`).join("") + "</ul>");
      } else {
        out.push(`<p>${mdInline(b.replace(/\n/g, " "))}</p>`);
      }
    });
  });
  return out.join("");
}

// ─────────────────────────── Carregamento do curso ───────────────────────────
async function ensureCourse(lang: string): Promise<Course | null> {
  if (!lang) return null;
  if (courseCache && courseCache.language === lang) return courseCache;
  try { courseCache = await invoke<Course>("get_course", { language: lang }); loadError = ""; }
  catch (e) { courseCache = null; loadError = String(e); }
  return courseCache;
}

function activeUnits(course: Course): Unit[] {
  const levels = state.levels.length ? state.levels : course.units.map((u) => u.level);
  return course.units.filter((u) => levels.includes(u.level));
}
const sequence = (course: Course): Step[] => activeUnits(course).flatMap((u) => u.steps);

function findStep(course: Course, id: string): { unit: Unit; step: Step; index: number } | null {
  for (const unit of course.units) {
    const index = unit.steps.findIndex((s) => s.id === id);
    if (index >= 0) return { unit, step: unit.steps[index], index };
  }
  return null;
}
function currentStep(): Step | null {
  if (!courseCache || !state.cur) return null;
  const f = findStep(courseCache, state.cur);
  return f ? f.step : null;
}

// ─────────────────────────── Onboarding (modal dinâmico) ───────────────────────────
async function openOnboard(page: number): Promise<void> {
  let o = document.getElementById("onb");
  if (!o) {
    document.body.insertAdjacentHTML("beforeend", '<div id="onb"></div>');
    o = document.getElementById("onb")!;
    // Só se pode fechar clicando fora depois de já existir uma escolha (primeira
    // vez obriga a escolher uma linguagem).
    o.onclick = (e) => { if (e.target === o && state.lang) o!.classList.remove("show"); };
  }
  if (page === 1) {
    onbChoice = { lang: state.lang, levels: state.levels.slice() };
    let courses: CourseSummary[] = [];
    try { courses = await invoke<CourseSummary[]>("list_courses"); }
    catch (e) { loadError = String(e); }
    const byLang = new Map<string, CourseSummary>();
    for (const c of courses) if (!byLang.has(c.language)) byLang.set(c.language, c);
    const cards = Array.from(byLang.values());
    const body = cards.length
      ? `<div class="onb-langs">${cards.map((c) =>
          `<button class="onb-lang" data-lang="${esc(c.language)}"><span class="g">${glyph(c.language)}</span><b>${esc(niceLang(c.language))}</b><small>${esc(c.summary.slice(0, 58))}…</small><span class="tag live">${esc(t("lt.available"))}</span></button>`).join("")}</div>`
      : `<div class="sec-empty">${esc(loadError || t("lt.noCourses"))}</div>`;
    o.innerHTML = `<div class="onb-box"><div class="onb-brand">${svg("sparkle")} Delonix Tutor</div><h2>${esc(t("lt.onbTitle1"))}</h2><p>${esc(t("lt.onbSub1"))}</p>${body}</div>`;
    o.querySelectorAll<HTMLElement>(".onb-lang").forEach((b) => {
      b.addEventListener("click", () => { onbChoice.lang = b.dataset.lang || null; void openOnboard(2); });
    });
  } else {
    const lvls = LEVEL_IDS.map((id) =>
      `<button class="onb-lvl${onbChoice.levels.includes(id) ? " on" : ""}" data-lvl="${id}"><span><b>${esc(t("level." + id))}</b><small>${esc(t("level." + id + ".blurb"))}</small></span><i>${onbChoice.levels.includes(id) ? "✓" : ""}</i></button>`).join("");
    o.innerHTML = `<div class="onb-box"><div class="onb-brand">${svg("sparkle")} Delonix Tutor</div><h2>${esc(t("lt.onbTitle2"))}</h2><p>${esc(t("lt.onbSub2"))}</p>${lvls}<div class="onb-foot"><button class="lnk" id="onb-back">${esc(t("lt.back"))}</button><button class="mini pri" id="onb-start"${onbChoice.levels.length ? "" : " disabled"}>${esc(t("lt.start"))}</button></div></div>`;
    o.querySelectorAll<HTMLElement>(".onb-lvl").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.dataset.lvl!;
        const i = onbChoice.levels.indexOf(id);
        if (i >= 0) onbChoice.levels.splice(i, 1); else onbChoice.levels.push(id);
        void openOnboard(2);
      });
    });
    o.querySelector<HTMLElement>("#onb-back")?.addEventListener("click", () => void openOnboard(1));
    o.querySelector<HTMLElement>("#onb-start")?.addEventListener("click", () => { if (onbChoice.levels.length) ltStart(); });
  }
  o.classList.add("show");
}

function ltStart(): void {
  state.lang = onbChoice.lang;
  state.levels = LEVEL_IDS.filter((l) => onbChoice.levels.includes(l));
  state.cur = null;
  courseCache = null; // força recarregar o curso da nova linguagem
  save();
  document.getElementById("onb")?.classList.remove("show");
  goPane("tutor");
  void ltResume();
}

async function ltResume(): Promise<void> {
  if (!state.lang) { goPane("tutor"); void openOnboard(1); return; }
  const course = await ensureCourse(state.lang);
  if (!course) { goPane("tutor"); void renderTutor(); return; }
  const seq = sequence(course);
  if (!seq.length) { void renderTutor(); return; }
  const keep = state.cur && seq.some((s) => s.id === state.cur) ? state.cur : null;
  const next = keep || (seq.find((s) => !isDone(s.id)) || seq[0]).id;
  ltOpen(next);
}

// ─────────────────────────── Abrir um passo (com bloqueio) ───────────────────────────
function ltOpen(id: string): void {
  const course = courseCache; if (!course) return;
  const f = findStep(course, id); if (!f) return;
  const { unit, step, index } = f;
  // Bloqueio: um passo só abre se o anterior da mesma unidade estiver feito.
  if (index > 0 && !isDone(unit.steps[index - 1].id)) { toast(t("lt.unlockPrev")); return; }
  state.cur = id;
  state.open[unit.id] = true;
  hoodOpen = false;
  seedBuffer(step);
  save();
  openTab({ id: "lt", title: fileName(step), kind: "lt" });
  void renderTutor();
}

function seedBuffer(step: Step): void {
  const key = dk(step.id);
  if (state.code[key] !== undefined) return;
  let seed = "";
  if (step.kind === "concept") seed = `${commentPrefix()} ${step.title}\n${commentPrefix()} ${t("lt.conceptSeed")}\n`;
  else if (step.kind === "challenge") seed = step.starter.replace(/^\n/, "");
  // drill: começa vazio — o aluno retranscreve o alvo linha a linha.
  state.code[key] = seed;
}

// ─────────────────────────── Monaco (editor reutilizável) ───────────────────────────
type LtModel = monaco.editor.ITextModel & { _ltStep?: string };
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let editorHost: HTMLDivElement | null = null;
const models = new Map<string, LtModel>();

function applyMonacoTheme(): void {
  if (!editor) return;
  const light = document.documentElement.style.colorScheme === "light";
  monaco.editor.setTheme(light ? "vs" : "vs-dark");
}

function ensureEditor(): monaco.editor.IStandaloneCodeEditor {
  if (editor) return editor;
  editorHost = document.createElement("div");
  editorHost.style.cssText = "width:100%;height:100%";
  editor = monaco.editor.create(editorHost, {
    model: null, theme: "vs-dark", automaticLayout: true,
    fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 4,
  });
  applyMonacoTheme();
  // Segue o tema da casca sem depender do módulo ./theme: o theme.ts escreve
  // `colorScheme` no documentElement, por isso observamos esse atributo.
  new MutationObserver(() => applyMonacoTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  editor.onDidChangeModelContent(() => {
    const m = editor?.getModel() as LtModel | null;
    const id = m?._ltStep;
    if (!id || !m) return;
    state.code[dk(id)] = m.getValue();
    scheduleSave();
    onBufferChanged(id);
  });
  return editor;
}

function modelFor(step: Step): LtModel {
  const key = dk(step.id);
  let m = models.get(key);
  if (!m) {
    m = monaco.editor.createModel(state.code[key] ?? "", monacoLang(state.lang || "")) as LtModel;
    m._ltStep = step.id;
    models.set(key, m);
  }
  return m;
}

// ─────────────────────────── Drill (transcrição, verificação no cliente) ───────────────────────────
// A verificação do drill é transcrição pura: compara o que o aluno escreveu com o
// `target` linha a linha, de forma transparente (não é uma correcção de modelo nem
// julga um `challenge` — o contrato dos testes aplica-se aos challenges).
function drillLines(step: Step): string[] { return step.target.replace(/^\n/, "").replace(/\n+$/, "").split("\n"); }
function drillState(step: Step): { T: string[]; ok: boolean[]; n: number; all: boolean } {
  const T = drillLines(step);
  const typed = (state.code[dk(step.id)] || "").replace(/\s+$/, "").split("\n");
  const ok = T.map((l, i) => typed[i] !== undefined && typed[i].trimEnd() === l.trimEnd());
  return { T, ok, n: ok.filter(Boolean).length, all: ok.every(Boolean) && typed.length === T.length };
}

function onBufferChanged(id: string): void {
  if (!courseCache) return;
  const f = findStep(courseCache, id); if (!f || f.step.kind !== "drill") return;
  const step = f.step;
  if (!isDone(step.id)) {
    const d = drillState(step);
    if (d.all) { state.done[dk(step.id)] = true; save(); void renderTutor(); }
  }
  renderResults();
}

async function runDrill(step: Step): Promise<void> {
  if (drillRun.has(step.id)) return;
  drillRun.set(step.id, "loading"); renderResults();
  try {
    const r = await invoke<RunResult>("run_drill", { code: state.code[dk(step.id)] || "", language: state.lang, dependencies: step.dependencies });
    drillRun.set(step.id, r);
  } catch (e) { drillRun.set(step.id, { error: String(e) }); }
  renderResults();
}

// ─────────────────────────── Challenge (correcção pelo backend) ───────────────────────────
async function submitChallenge(step: Step): Promise<void> {
  submission.set(step.id, "loading"); renderResults();
  try {
    const a = await invoke<Assessment>("submit_step", { stepId: step.id, code: state.code[dk(step.id)] || "" });
    submission.set(step.id, a);
    if (a.correctness.passed && !isDone(step.id)) { state.done[dk(step.id)] = true; save(); void renderTutor(); }
  } catch (e) { submission.set(step.id, { error: String(e) }); }
  renderResults();
}

// ─────────────────────────── Pedir ajuda à tutora (pista mínima) ───────────────────────────
// Usa `request_hint` (pista gradual 1..3). NUNCA escreve no buffer Monaco do aluno —
// a dica é só texto, mostrada no painel de resultados.
async function ltAsk(): Promise<void> {
  const step = currentStep(); if (!step) return;
  const level = Math.min(3, (state.hints[dk(step.id)] || 0) + 1);
  state.hints[dk(step.id)] = level; save();
  try {
    const hint = await invoke<Hint>("request_hint", { phaseId: step.id, code: state.code[dk(step.id)] || "", level });
    const log = hintLog.get(step.id) || []; log.push(hint); hintLog.set(step.id, log);
  } catch (e) {
    const log = hintLog.get(step.id) || []; log.push({ text: String(e), provider: "error", level }); hintLog.set(step.id, log);
  }
  renderResults();
}

// ─────────────────────────── Botão primário + avanço ───────────────────────────
function advance(step: Step): void {
  if (!courseCache) return;
  const seq = sequence(courseCache);
  const i = seq.findIndex((s) => s.id === step.id);
  const next = i >= 0 ? seq[i + 1] : undefined;
  if (next) ltOpen(next.id);
  else { toast(t("lt.trackComplete")); void renderTutor(); }
}

async function onPrimary(): Promise<void> {
  const step = currentStep(); if (!step) return;
  if (isDone(step.id)) { advance(step); return; }
  if (step.kind === "concept") { state.done[dk(step.id)] = true; save(); void renderTutor(); advance(step); return; }
  if (step.kind === "drill") {
    const d = drillState(step);
    if (d.all) { if (!isDone(step.id)) { state.done[dk(step.id)] = true; save(); void renderTutor(); } advance(step); }
    else { toast(t("lt.lineKeepTyping", { n: d.n, total: d.T.length })); renderResults(); }
    return;
  }
  await submitChallenge(step); // challenge
}

// ─────────────────────────── Pane «tutor»: árvore do percurso ───────────────────────────
const tutorHead = (): string =>
  `<div class="side-hd"><span class="t">${esc(t("lt.title"))}</span><span class="acts"><button data-ic="settings" id="lt-gear" title="${esc(t("lt.changeTrack"))}"></button></span></div>`;

async function renderTutor(): Promise<void> {
  const el = document.getElementById("pane-tutor"); if (!el) return;
  if (!state.lang) {
    el.innerHTML = tutorHead() + `<div class="sections"><div class="sec-empty">${esc(t("lt.pickPrompt"))}</div><button class="btn" id="lt-choose">${esc(t("lt.choose"))}</button></div>`;
    hydrate(el);
    el.querySelector<HTMLElement>("#lt-gear")?.addEventListener("click", () => void openOnboard(1));
    el.querySelector<HTMLElement>("#lt-choose")?.addEventListener("click", () => void openOnboard(1));
    return;
  }
  if (!courseCache || courseCache.language !== state.lang) {
    el.innerHTML = tutorHead() + `<div class="sec-empty">${esc(t("common.loading"))}</div>`;
    hydrate(el);
  }
  const course = await ensureCourse(state.lang);
  if (!course) {
    el.innerHTML = tutorHead() + `<div class="sec-empty">${esc(loadError || t("lt.noCourses"))}</div>`;
    hydrate(el);
    el.querySelector<HTMLElement>("#lt-gear")?.addEventListener("click", () => void openOnboard(1));
    return;
  }
  const seq = sequence(course);
  const total = seq.reduce((a, s) => a + s.points, 0);
  const earned = seq.reduce((a, s) => a + (isDone(s.id) ? s.points : 0), 0);
  let lvl = "";
  let html = tutorHead() +
    `<div class="sections"><div class="lt-course">${esc(course.title)}</div>` +
    `<div class="lt-tot"><span class="lp-bar" style="flex:1;margin:0"><i style="width:${total ? (earned / total) * 100 : 0}%"></i></span><span>${esc(t("lt.pts", { earned, total }))}</span></div>`;
  for (const u of activeUnits(course)) {
    const open = !!state.open[u.id];
    const dn = u.steps.filter((s) => isDone(s.id)).length;
    if (u.level !== lvl) { html += `<div class="lt-lvl">${esc(t("level." + u.level))}</div>`; lvl = u.level; }
    html += `<div class="lt-unit${open ? " open" : ""}" data-unit="${esc(u.id)}"><span class="chev">${svg("chev")}</span><span class="nm">${esc(u.title)}</span>${stars(u.difficulty)}<span class="cnt">${dn}/${u.steps.length}</span></div>`;
    if (open) {
      html += u.steps.map((s, i) => {
        const done = isDone(s.id);
        const lock = i > 0 && !isDone(u.steps[i - 1].id);
        const mark = done ? "✓" : lock ? "🔒" : "▶";
        return `<div class="lt-step${state.cur === s.id ? " cur" : ""}${lock ? " lock" : ""}" data-step="${esc(s.id)}"><span class="st">${mark}</span><span class="nm">${esc(s.title)}</span>${stars(s.difficulty, s.kind)}<span class="tag k-${esc(s.kind)}">${esc(t(BADGE[s.kind] || "lt.badge.concept"))}</span><span class="pt">+${s.points}</span></div>`;
      }).join("");
    }
  }
  html += `</div>`;
  el.innerHTML = html;
  hydrate(el);
  el.querySelector<HTMLElement>("#lt-gear")?.addEventListener("click", () => void openOnboard(1));
  el.querySelectorAll<HTMLElement>(".lt-unit").forEach((row) => {
    row.addEventListener("click", () => { const id = row.dataset.unit!; state.open[id] = !state.open[id]; save(); void renderTutor(); });
  });
  el.querySelectorAll<HTMLElement>(".lt-step").forEach((row) => {
    row.addEventListener("click", () => ltOpen(row.dataset.step!));
  });
}

// ─────────────────────────── Vista do passo (VIEW.lt): split Monaco + resultados ───────────────────────────
async function renderStepView(host: HTMLElement): Promise<void> {
  const course = await ensureCourse(state.lang || "");
  const f = course && state.cur ? findStep(course, state.cur) : null;
  if (!f) { host.innerHTML = `<div class="empty"><div>${esc(t("lt.openStep"))}</div></div>`; return; }
  const step = f.step;
  host.innerHTML =
    `<div class="lt"><div class="lt-ed"><div class="lt-bar"><span class="lt-file">● ${esc(fileName(step))}</span><span class="sp"></span>` +
    `<button class="mini" id="lt-hood">${esc(t("lt.underHood"))}</button><button class="mini pri" id="lt-go"></button></div>` +
    `<div id="lt-mon" style="flex:1;min-height:0"></div></div><div class="lt-res" id="lt-res"></div></div>`;
  const mon = host.querySelector<HTMLElement>("#lt-mon")!;
  const ed = ensureEditor();
  mon.appendChild(editorHost!);
  ed.setModel(modelFor(step));
  applyMonacoTheme();
  ed.layout();
  ed.focus();
  host.querySelector<HTMLElement>("#lt-hood")?.addEventListener("click", () => { hoodOpen = !hoodOpen; renderResults(); });
  host.querySelector<HTMLElement>("#lt-go")?.addEventListener("click", () => void onPrimary());
  renderResults();
}

/** (Re)pinta o painel de resultados à direita e actualiza o rótulo do botão primário. */
function renderResults(): void {
  const el = document.getElementById("lt-res");
  const go = document.getElementById("lt-go");
  const step = currentStep();
  if (!el || !step) return;
  const done = isDone(step.id);
  let label = t("lt.continue");
  let h = `<div class="lt-kind"><span>${esc(t("lt." + step.kind))}</span><b>${done ? "✓ " : ""}+${step.points} ${esc(t("lt.ptsShort"))}</b></div>`;

  // «Under the hood»: mostra a intro (briefing) do passo. A telemetria medida
  // (CPU/memória/IO) ainda NÃO está ligada nesta vista — fica honesto e visível.
  if (hoodOpen) {
    h += `<div class="lt-card hood"><h3>${esc(t("lt.underHood"))}</h3>${md(step.intro)}<p class="lt-note">${esc(t("lt.hoodNote"))}</p></div>`;
  }

  if (step.kind === "concept") {
    h += `<div class="lt-card"><h2>${esc(step.title)}</h2>${md(step.body)}</div>`;
    label = t("lt.continue");
  } else if (step.kind === "drill") {
    const d = drillState(step);
    const hide = step.placeholderPolicy !== "shown" && !state.show[dk(step.id)] && !done;
    h += `<div class="lt-card"><h2>${esc(step.title)}</h2>${md(step.prompt)}` +
      `<div class="lt-prog"><span class="lp-bar" style="flex:1;margin:0"><i style="width:${(d.n / d.T.length) * 100}%"></i></span><span>${esc(t("lt.lines", { n: d.n, total: d.T.length }))}</span>` +
      `${hide ? `<button class="mini" id="lt-show">${esc(t("lt.showTarget"))}</button>` : ""}</div>` +
      `<div class="lt-target">${d.T.map((l, i) => {
        const cur = !d.ok[i] && d.ok.slice(0, i).every(Boolean);
        const cls = d.ok[i] ? " ok" : cur ? " cur" : "";
        const code = hide && !d.ok[i] ? "· · ·" : (esc(l) || "&nbsp;");
        const cm = (d.ok[i] || cur) && step.lineComments[i] ? `<small>${mdInline(step.lineComments[i])}</small>` : "";
        return `<div class="tl${cls}"><span class="n">${d.ok[i] ? "✓" : i + 1}</span><div><code>${code}</code>${cm}</div></div>`;
      }).join("")}</div></div>`;
    if (done) {
      h += `<div class="lt-card ok"><h3>${esc(t("lt.matches"))}</h3>${md(step.explanation)}</div>`;
      h += drillOutputCard(step);
    }
    label = done ? t("lt.continue") : t("lt.check");
  } else { // challenge
    h += `<div class="lt-card"><h2>${esc(step.title)}</h2>${md(step.instructions)}</div>`;
    h += challengeResultCard(step, done);
    label = done ? t("lt.continue") : t("lt.submit");
  }

  // Ajuda da tutora + pistas já pedidas (texto apenas; nunca toca no buffer).
  h += `<div class="lt-help"><button class="mini" id="lt-ask">${esc(t("lt.ask"))}</button><span>${esc(t("lt.askNote"))}</span></div>`;
  const hints = hintLog.get(step.id) || [];
  h += hints.map((hint) => `<div class="hint"><b>${esc(t("lt.hint", { n: hint.level }))}</b> ${mdInline(hint.text)}</div>`).join("");

  const top = el.scrollTop;
  el.innerHTML = h;
  el.scrollTop = top;
  if (go) go.textContent = label;

  el.querySelector<HTMLElement>("#lt-show")?.addEventListener("click", () => { state.show[dk(step.id)] = true; save(); renderResults(); });
  el.querySelector<HTMLElement>("#lt-ask")?.addEventListener("click", () => void ltAsk());

  // Dispara a execução real do drill uma vez, quando ficou completo.
  if (step.kind === "drill" && done && !drillRun.has(step.id)) void runDrill(step);
}

function drillOutputCard(step: Step): string {
  const r = drillRun.get(step.id);
  if (r === undefined) return "";
  if (r === "loading") return `<div class="lt-card"><h3>${esc(t("lt.output"))}</h3><p class="lt-note">${esc(t("lt.runningDrill"))}</p></div>`;
  if ("error" in r) return `<div class="lt-card bad"><h3>${esc(t("lt.output"))}</h3><pre>${esc(r.error)}</pre></div>`;
  const outBody = r.stdout.trim() ? `<pre>${esc(r.stdout)}</pre>` : `<p class="lt-note">${esc(t("lt.noOutput"))}</p>`;
  const errBody = r.stderr.trim() ? `<pre>${esc(r.stderr)}</pre>` : "";
  return `<div class="lt-card${r.ok ? "" : " bad"}"><h3>${esc(t("lt.output"))}</h3>${outBody}${errBody}</div>`;
}

function challengeResultCard(step: Step, done: boolean): string {
  const a = submission.get(step.id);
  if (a === "loading") return `<div class="lt-card"><h3>${esc(t("lt.running"))}</h3></div>`;
  if (a && "error" in (a as object) && !("correctness" in (a as object))) {
    return `<div class="lt-card bad"><h3>${esc(t("lt.notYet"))}</h3><pre>${esc((a as { error: string }).error)}</pre></div>`;
  }
  if (a && "correctness" in (a as object)) {
    const asmt = a as Assessment;
    const c = asmt.correctness;
    let out = `<div class="lt-card ${c.passed ? "ok" : "bad"}"><h3>${c.passed ? esc(t("lt.passed")) : esc(t("lt.notYet"))}</h3>` +
      `<div>${esc(c.summary)}</div>${c.raw.trim() ? `<pre>${esc(c.raw)}</pre>` : ""}`;
    if (asmt.complexity) out += `<div class="lt-cx"><span>${esc(t("lt.measured"))} <b>${esc(asmt.complexity.bigO)}</b></span><span>${esc(asmt.complexity.confidence)}</span></div>`;
    out += `</div>`;
    // O gabarito só vem do backend quando os testes passam (gabarito === null numa
    // falha). Mostramos apenas o que chegou — nunca o fabricamos.
    if (asmt.gabarito) {
      const g = asmt.gabarito;
      out += `<div class="lt-card"><h3>${esc(t("lt.refSolution"))}</h3><div class="lt-cx"><span>${esc(t("lt.time"))} <b>${esc(g.time)}</b></span><span>${esc(t("lt.space"))} <b>${esc(g.space)}</b></span></div><pre>${esc(g.solution.replace(/\n$/, ""))}</pre>${md(g.justification)}</div>`;
    }
    return out;
  }
  // Concluído numa sessão anterior: o gabarito não é guardado no dispositivo, por
  // contrato. Re-submeter volta a correr os testes e mostra a solução de referência.
  if (done) return `<div class="lt-card ok"><h3>${esc(t("lt.passed"))}</h3><p class="lt-note">${esc(t("lt.completedNote"))}</p></div>`;
  return "";
}

// ─────────────────────────── Registo na casca ───────────────────────────
export function initLearn(): void {
  registerStrings(LT_STRINGS);
  RP.tutor = () => { void renderTutor(); };
  VIEW.lt = (_tab: Tab, host: HTMLElement) => { void renderStepView(host); };
  addCommand({ id: "lt.continue", label: () => t("lt.cmdContinue"), run: () => { goPane("tutor"); void ltResume(); } });
}

const LT_STRINGS = {
  en: {
    "lt.title": "Learning Track",
    "lt.pickPrompt": "Pick a language and a level to load your guided track.",
    "lt.choose": "Choose what to learn",
    "lt.changeTrack": "Change language or level",
    "lt.noCourses": "No courses available from the backend.",
    "lt.pts": "{earned} / {total} pts",
    "lt.ptsShort": "pts",
    "lt.onbTitle1": "What do you want to learn?",
    "lt.onbSub1": "Pick a language and we'll guide you through a hands-on track, one step at a time.",
    "lt.onbTitle2": "What's your level?",
    "lt.onbSub2": "Pick one or more. Your track loads only the levels you choose — mix Basic and Intermediate, go straight to Advanced, or take all three. You can change this later from the gear icon.",
    "lt.available": "Available",
    "lt.back": "← Back",
    "lt.start": "Start →",
    "lt.continue": "Continue →",
    "lt.check": "Check ▷",
    "lt.submit": "Submit ▷",
    "lt.underHood": "Under the hood",
    "lt.hoodNote": "This shows the step's briefing. Measured CPU / memory / I/O is not wired into this view yet.",
    "lt.ask": "Ask the Tutor",
    "lt.askNote": "The Tutor explains and hints; you write the final code.",
    "lt.concept": "Concept", "lt.drill": "Drill", "lt.challenge": "Challenge",
    "lt.badge.concept": "LEARN", "lt.badge.drill": "DRILL", "lt.badge.challenge": "APPLY",
    "lt.lines": "{n}/{total} lines",
    "lt.showTarget": "Show target",
    "lt.matches": "✓ It matches",
    "lt.notYet": "✗ Not yet",
    "lt.passed": "✓ Passed",
    "lt.running": "Running the hidden tests…",
    "lt.runningDrill": "Running your program…",
    "lt.output": "Output",
    "lt.noOutput": "(no output)",
    "lt.refSolution": "Reference solution",
    "lt.measured": "measured",
    "lt.time": "time", "lt.space": "space",
    "lt.trackComplete": "Track complete",
    "lt.unlockPrev": "Finish the previous step to unlock this one",
    "lt.lineKeepTyping": "{n} of {total} lines match — keep typing",
    "lt.hint": "Hint {n}",
    "lt.openStep": "Open a step from the Learning Track.",
    "lt.conceptSeed": "Read the concept on the right, then press Continue.",
    "lt.completedNote": "You passed this challenge. The reference solution appears right after you pass; it isn't stored on this device.",
    "lt.cmdContinue": "Learning Track: Continue",
  },
  ptAO: {
    "lt.title": "Percurso de aprendizagem",
    "lt.pickPrompt": "Escolhe uma linguagem e um nível para carregar o teu percurso guiado.",
    "lt.choose": "Escolher o que aprender",
    "lt.changeTrack": "Mudar de linguagem ou de nível",
    "lt.noCourses": "Nenhum curso disponível a partir do backend.",
    "lt.pts": "{earned} / {total} pts",
    "lt.ptsShort": "pts",
    "lt.onbTitle1": "O que queres aprender?",
    "lt.onbSub1": "Escolhe uma linguagem e guiamos-te por um percurso prático, um passo de cada vez.",
    "lt.onbTitle2": "Qual é o teu nível?",
    "lt.onbSub2": "Escolhe um ou mais. O teu percurso carrega apenas os níveis que escolheres — mistura Básico e Intermédio, vai directo ao Avançado, ou leva os três. Podes mudar isto depois no ícone de engrenagem.",
    "lt.available": "Disponível",
    "lt.back": "← Voltar",
    "lt.start": "Começar →",
    "lt.continue": "Continuar →",
    "lt.check": "Verificar ▷",
    "lt.submit": "Submeter ▷",
    "lt.underHood": "Nos bastidores",
    "lt.hoodNote": "Mostra o briefing do passo. A telemetria medida (CPU / memória / E/S) ainda não está ligada nesta vista.",
    "lt.ask": "Perguntar ao Tutor",
    "lt.askNote": "O Tutor explica e dá pistas; o código final escreve-lo tu.",
    "lt.concept": "Conceito", "lt.drill": "Treino", "lt.challenge": "Desafio",
    "lt.badge.concept": "LEARN", "lt.badge.drill": "DRILL", "lt.badge.challenge": "APPLY",
    "lt.lines": "{n}/{total} linhas",
    "lt.showTarget": "Mostrar alvo",
    "lt.matches": "✓ Corresponde",
    "lt.notYet": "✗ Ainda não",
    "lt.passed": "✓ Passou",
    "lt.running": "A correr os testes ocultos…",
    "lt.runningDrill": "A correr o teu programa…",
    "lt.output": "Saída",
    "lt.noOutput": "(sem saída)",
    "lt.refSolution": "Solução de referência",
    "lt.measured": "medida",
    "lt.time": "tempo", "lt.space": "espaço",
    "lt.trackComplete": "Percurso concluído",
    "lt.unlockPrev": "Conclui o passo anterior para desbloquear este",
    "lt.lineKeepTyping": "{n} de {total} linhas correspondem — continua a escrever",
    "lt.hint": "Pista {n}",
    "lt.openStep": "Abre um passo do Percurso de aprendizagem.",
    "lt.conceptSeed": "Lê o conceito à direita e carrega em Continuar.",
    "lt.completedNote": "Passaste este desafio. A solução de referência aparece logo que passas; não fica guardada neste dispositivo.",
    "lt.cmdContinue": "Percurso de aprendizagem: Continuar",
  },
};
