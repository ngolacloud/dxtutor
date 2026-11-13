// shell/gitflow.ts — Fase 6 (paridade): grafo de commits (DAG) + Gitflow.
//
// Liga ao backend REAL (crate tutor-eval::git): `git_log` desenha o grafo
// multi-faixa (SVG, faixas por ramo, curvas pai/filho), `git_show` mostra o
// detalhe de um commit, `git_branch`/`git_branches` dão o estado, e
// `git_create_branch`/`git_checkout` arrancam os ramos Gitflow a partir da base
// certa. Sem simulação.
//
// HONESTIDADE: NÃO existe comando de merge no backend. Por isso o «finish» do
// Gitflow (merge para develop/main + tag) NÃO é executado aqui — é apresentado
// como os comandos git exactos a correr no terminal, com a nota de que não há
// merge no backend. Nunca se finge que o merge foi feito.

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { svg, hydrate } from "./icons";
import { VIEW, openTab, toast, addCommand, type Tab } from "./index";
import { workspaceRoot } from "./workspace";

// Espelha tutor_eval::git::GitCommit (serde camelCase). `date` já vem relativo
// (git %cr) e `refs` já vem sem o prefixo "HEAD -> "; as tags chegam como "tag: x".
interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  refs: string[];
}

interface Row { h: string; col: number; pl: number[] }
interface Layout { rows: Row[]; idx: Map<string, number>; max: number }

// Cores das faixas do grafo — categóricas (uma por ramo), não tokens de tema.
// Mantêm-se fixas como no protótipo; a CSS .gl-ref recebe a cor por `--c`.
const LANE = ["#e08a5b", "#6ea8ff", "#5cc9a7", "#c678dd", "#e0b64a", "#5fcad6", "#f1707a"];

// Convenção Gitflow: feature/fix/release saem de develop; hotfix sai de main.
const FLOW = /^(feature|fix|release|hotfix)\//;
const isFlow = (b: string): boolean => FLOW.test(b);

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Normaliza um nome em slug de ramo; mantém pontos (ex.: versões 0.3.0). */
function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
}

// ───────────────────────────── estado ──────────────────────────────
let host: HTMLElement | null = null;      // host da vista actual (p/ re-render)
let commits: GitCommit[] = [];
let branch = "";
let branchCount = 0;
let selected: string | null = null;       // commit expandido (detalhe)
let showFinish = false;                    // banner «finish» do ramo actual
let errorMsg = "";
const showCache = new Map<string, string>(); // hash → saída de git_show (ou erro)

// ───────────────────────────── layout do DAG ──────────────────────────────
// Porta de docs/prototype/index.html (graphLayout): atribui uma faixa (coluna)
// a cada commit, reaproveitando faixas livres e seguindo os pais.
function layout(list: GitCommit[]): Layout {
  const lanes: Array<string | null> = [];
  const rows: Row[] = [];
  const idx = new Map<string, number>();
  let max = 1;
  list.forEach((c, i) => {
    let col = lanes.indexOf(c.hash);
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) col = lanes.length; }
    for (let k = 0; k < lanes.length; k++) if (lanes[k] === c.hash) lanes[k] = null;
    lanes[col] = null;
    const pl: number[] = [];
    c.parents.forEach((ph, k) => {
      let l: number;
      if (k === 0) { l = col; lanes[col] = ph; }
      else {
        l = lanes.indexOf(ph);
        if (l < 0) { l = lanes.indexOf(null); if (l < 0) l = lanes.length; lanes[l] = ph; }
      }
      pl.push(l);
    });
    idx.set(c.hash, i);
    rows.push({ h: c.hash, col, pl });
    max = Math.max(max, lanes.length, col + 1);
  });
  return { rows, idx, max };
}

// Constrói os caminhos (curvas) e os pontos do SVG. Porta de VIEW.graph do protótipo.
function buildSvg(L: Layout, byHash: Map<string, GitCommit>): { paths: string; dots: string; gw: number; height: number } {
  const W = 18, H = 32;
  const X = (c: number): number => 14 + c * W;
  const Y = (i: number): number => H / 2 + i * H;
  const gw = 28 + L.max * W;
  let paths = "", dots = "";
  L.rows.forEach((r, i) => {
    const c = byHash.get(r.h);
    if (!c) return;
    c.parents.forEach((ph, k) => {
      const j = L.idx.get(ph);
      if (j === undefined) return; // pai fora da janela carregada — ignora, honesto
      const pr = L.rows[j];
      const x0 = X(r.col), y0 = Y(i), xl = X(r.pl[k]), xp = X(pr.col), y1 = Y(j);
      const col = LANE[(k === 0 ? r.col : r.pl[k]) % LANE.length];
      let d = `M${x0} ${y0}`;
      if (j === i + 1) {
        d += x0 === xp ? `L${xp} ${y1}` : `C${x0} ${y0 + H * 0.6} ${xp} ${y1 - H * 0.6} ${xp} ${y1}`;
      } else {
        d += xl === x0 ? `L${xl} ${y0 + H}` : `C${x0} ${y0 + H * 0.6} ${xl} ${y0 + H * 0.4} ${xl} ${y0 + H}`;
        d += `L${xl} ${y1 - H}`;
        d += xp === xl ? `L${xp} ${y1}` : `C${xl} ${y1 - H * 0.4} ${xp} ${y1 - H * 0.6} ${xp} ${y1}`;
      }
      paths += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round"/>`;
    });
    const col = LANE[r.col % LANE.length];
    const mg = c.parents.length > 1;
    dots += `<circle cx="${X(r.col)}" cy="${Y(i)}" r="${mg ? 4 : 5}" fill="${mg ? "var(--bg-editor)" : col}" stroke="${col}" stroke-width="2"/>`;
  });
  return { paths, dots, gw, height: L.rows.length * H };
}

// Cor estável do avatar do autor (determinística a partir do nome).
function authorColor(name: string): string {
  let n = 0;
  for (let i = 0; i < name.length; i++) n = (n * 31 + name.charCodeAt(i)) >>> 0;
  return LANE[n % LANE.length];
}

function refsHtml(c: GitCommit, laneCol: string): string {
  return c.refs.map((ref) => {
    if (ref.startsWith("tag:")) {
      return `<span class="gl-ref tagr">${esc(ref.slice(4).trim())}</span>`;
    }
    const head = ref === branch;
    return `<span class="gl-ref${head ? " head" : ""}" style="--c:${laneCol}">${head ? "● " : ""}${esc(ref)}</span>`;
  }).join("");
}

// ───────────────────────────── Gitflow «finish» (só mostra; não funde) ──────────────────────────────
/** Os comandos git exactos que o «finish» faria — para correr no terminal. */
function finishPlan(b: string): string[] {
  const kind = b.split("/")[0];
  const name = b.slice(b.indexOf("/") + 1);
  if (kind === "feature" || kind === "fix") {
    return [`git checkout develop`, `git merge --no-ff ${b}`, `git branch -d ${b}`];
  }
  // release / hotfix: para main (com tag) e para develop.
  return [
    `git checkout main`, `git merge --no-ff ${b}`, `git tag ${name}`,
    `git checkout develop`, `git merge --no-ff ${b}`, `git branch -d ${b}`,
  ];
}

function finishBanner(): string {
  if (!showFinish || !isFlow(branch)) return "";
  const cmds = finishPlan(branch);
  return `<div class="gl-det" style="display:block">`
    + `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><b>${esc(t("gitflow.finishTitle", { branch }))}</b>`
    + `<button class="mini" id="gf-finish-x" style="margin-left:auto">${esc(t("gitflow.dismiss"))}</button></div>`
    + `<div style="color:var(--fg-muted);font-size:11.5px;margin-bottom:6px">⚠ ${esc(t("gitflow.finishNote"))}</div>`
    + `<pre style="white-space:pre-wrap;margin:0;font-family:var(--font-mono);font-size:11.5px">${esc(cmds.join("\n"))}</pre>`
    + `<pre style="white-space:pre-wrap;margin:6px 0 0;font-family:var(--font-mono);font-size:11px;color:var(--fg-dim)">${esc(cmds.join(" && "))}</pre>`
    + `</div>`;
}

// ───────────────────────────── render ──────────────────────────────
function detailHtml(hash: string): string {
  const txt = showCache.get(hash);
  if (txt === undefined) return `<div class="gl-det">${esc(t("gitflow.detailLoading"))}</div>`;
  if (!txt.trim()) return `<div class="gl-det">${esc(t("gitflow.detailEmpty"))}</div>`;
  return `<div class="gl-det" style="display:block"><pre style="white-space:pre-wrap;margin:0;font-family:var(--font-mono);font-size:11.5px;max-height:360px;overflow:auto">${esc(txt)}</pre></div>`;
}

function barHtml(): string {
  let actions = "";
  if (branch === "develop") {
    actions = `<button class="mini" id="gf-feature">${esc(t("gitflow.btnFeature"))}</button>`
      + `<button class="mini" id="gf-fix">${esc(t("gitflow.btnFix"))}</button>`
      + `<button class="mini" id="gf-release">${esc(t("gitflow.btnRelease"))}</button>`;
  } else if (branch === "main" || branch === "master") {
    actions = `<button class="mini" id="gf-hotfix">${esc(t("gitflow.btnHotfix"))}</button>`;
  } else if (isFlow(branch)) {
    actions = `<button class="mini pri" id="gf-finish">${esc(t("gitflow.btnFinish", { branch }))}</button>`;
  }
  return `<div class="gl-bar">`
    + `<button class="mini" id="gf-branch">${svg("scm")} ${esc(branch || "—")}</button>`
    + `<button class="mini" id="gf-refresh" title="${esc(t("gitflow.refresh"))}">${svg("refresh")}</button>`
    + actions
    + `<span class="sp"></span>`
    + `<span style="color:var(--fg-muted);font-size:11.5px">${esc(t("gitflow.counts", { c: commits.length, b: branchCount }))}</span>`
    + `</div>`;
}

function renderGraph(): void {
  if (!host) return;
  if (errorMsg) {
    host.innerHTML = `<div class="page"><h1>${esc(t("gitflow.graph"))}</h1><div class="sub">${esc(errorMsg)}</div></div>`;
    return;
  }
  if (!commits.length) {
    host.innerHTML = `<div class="gl">${barHtml()}<div class="page"><div class="sub">${esc(workspaceRoot() ? t("gitflow.empty") : t("gitflow.noFolder"))}</div></div></div>`;
    hydrate(host); wireBar(); return;
  }
  const L = layout(commits);
  const byHash = new Map(commits.map((c): [string, GitCommit] => [c.hash, c]));
  const { paths, dots, gw, height } = buildSvg(L, byHash);
  const rowsHtml = L.rows.map((r) => {
    const c = byHash.get(r.h);
    if (!c) return "";
    const laneCol = LANE[r.col % LANE.length];
    const sel = selected === r.h;
    const aCol = authorColor(c.author);
    const initial = (c.author.trim()[0] || "?").toUpperCase();
    const row = `<div class="gl-row${sel ? " sel" : ""}" data-h="${esc(r.h)}">`
      + `<span class="gl-refs">${refsHtml(c, laneCol)}</span>`
      + `<span class="gl-msg">${esc(c.subject)}</span>`
      + `<span class="gl-au"><i style="background:${aCol}">${esc(initial)}</i>${esc(c.author)}</span>`
      + `<span class="gl-h">${esc(c.short)}</span>`
      + `<span class="gl-t">${esc(c.date)}</span>`
      + `</div>`;
    return row + (sel ? detailHtml(r.h) : "");
  }).join("");
  host.innerHTML = `<div class="gl">${barHtml()}${finishBanner()}`
    + `<div class="gl-body" style="--gw:${gw}px">`
    + `<svg class="gl-svg" width="${gw}" height="${height}">${paths}${dots}</svg>`
    + rowsHtml
    + `</div></div>`;
  hydrate(host);
  wireBar();
  host.querySelectorAll<HTMLElement>(".gl-row").forEach((el) => {
    el.onclick = () => {
      const h = el.dataset.h as string;
      selected = selected === h ? null : h;
      if (selected && !showCache.has(selected)) void loadShow(selected);
      renderGraph();
    };
  });
}

function wireBar(): void {
  if (!host) return;
  const on = (id: string, fn: () => void): void => { host?.querySelector<HTMLElement>("#" + id)?.addEventListener("click", fn); };
  on("gf-branch", () => void showBranch());
  on("gf-refresh", () => void load());
  on("gf-feature", () => void startFlow("feature"));
  on("gf-fix", () => void startFlow("fix"));
  on("gf-release", () => void startFlow("release"));
  on("gf-hotfix", () => void startFlow("hotfix"));
  on("gf-finish", () => { showFinish = true; renderGraph(); });
  on("gf-finish-x", () => { showFinish = false; renderGraph(); });
}

// ───────────────────────────── carregamento (backend real) ──────────────────────────────
async function load(): Promise<void> {
  errorMsg = "";
  const root = workspaceRoot();
  if (!root) { commits = []; branch = ""; branchCount = 0; renderGraph(); return; }
  try {
    commits = await invoke<GitCommit[]>("git_log", { root, max: 300 });
  } catch (e) { commits = []; errorMsg = String(e); renderGraph(); return; }
  try { branch = (await invoke<string | null>("git_branch", { root })) || ""; } catch { branch = ""; }
  try { branchCount = (await invoke<string[]>("git_branches", { root })).length; } catch { branchCount = 0; }
  if (!isFlow(branch)) showFinish = false;
  showCache.clear();
  renderGraph();
}

async function loadShow(hash: string): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  try { showCache.set(hash, await invoke<string>("git_show", { root, hash })); }
  catch (e) { showCache.set(hash, String(e)); }
  if (selected === hash) renderGraph();
}

// ───────────────────────────── comandos Gitflow ──────────────────────────────
/** Faz checkout da base Gitflow certa; devolve o nome usado ou null se não existir. */
async function checkoutBase(root: string, kind: string): Promise<string | null> {
  const bases = kind === "hotfix" ? ["main", "master"] : ["develop"];
  for (const b of bases) {
    try { await invoke("git_checkout", { root, branch: b }); return b; } catch { /* tenta a próxima */ }
  }
  return null;
}

async function startFlow(kind: "feature" | "fix" | "release" | "hotfix"): Promise<void> {
  const root = workspaceRoot();
  if (!root) { toast(t("gitflow.noFolder")); return; }
  const raw = window.prompt(t("gitflow.prompt" + cap(kind)));
  if (raw === null) return;
  const s = slug(raw);
  if (!s) { toast(t("gitflow.emptyName")); return; }
  const name = kind + "/" + s;
  // Arranca da base certa: checkout da base e só depois cria o ramo a partir dela.
  // Honesto: se a base não existir, NÃO cria a partir de um sítio errado em silêncio.
  const base = await checkoutBase(root, kind);
  if (base === null) { toast(t("gitflow.baseMissing", { base: kind === "hotfix" ? "main" : "develop" })); return; }
  try {
    await invoke("git_create_branch", { root, name });
    branch = name;
    toast(t("gitflow.created", { branch: name }));
    openTab({ id: "graph", title: t("gitflow.graph"), kind: "graph" });
    await load();
  } catch (e) { toast(String(e)); }
}

async function showBranch(): Promise<void> {
  const root = workspaceRoot();
  if (!root) { toast(t("gitflow.noFolder")); return; }
  try {
    const b = await invoke<string | null>("git_branch", { root });
    branch = b || "";
    toast(t("gitflow.onBranch", { branch: b || "—" }));
  } catch (e) { toast(String(e)); }
}

async function openFinish(): Promise<void> {
  const root = workspaceRoot();
  if (!root) { toast(t("gitflow.noFolder")); return; }
  try { branch = (await invoke<string | null>("git_branch", { root })) || ""; } catch { /* mantém */ }
  if (!isFlow(branch)) { toast(t("gitflow.finishNotFlow", { branch: branch || "—" })); return; }
  showFinish = true;
  openTab({ id: "graph", title: t("gitflow.graph"), kind: "graph" });
}

// Vista do grafo (router por `kind:"graph"`).
const graphView = (_tab: Tab, h: HTMLElement): void => {
  host = h;
  selected = null;
  errorMsg = "";
  h.innerHTML = `<div class="page"><div class="sub">${esc(t("gitflow.loading"))}</div></div>`;
  void load();
};

export function initGitflow(): void {
  registerStrings(GITFLOW_STRINGS);
  VIEW.graph = graphView;
  addCommand({ id: "gitflow:feature", label: () => t("gitflow.startFeature"), run: () => void startFlow("feature") });
  addCommand({ id: "gitflow:fix", label: () => t("gitflow.startFix"), run: () => void startFlow("fix") });
  addCommand({ id: "gitflow:release", label: () => t("gitflow.startRelease"), run: () => void startFlow("release") });
  addCommand({ id: "gitflow:hotfix", label: () => t("gitflow.startHotfix"), run: () => void startFlow("hotfix") });
  addCommand({ id: "gitflow:finish", label: () => t("gitflow.finishCmd"), run: () => void openFinish() });
  addCommand({ id: "gitflow:branch", label: () => t("gitflow.branchCmd"), run: () => void showBranch() });
}

const GITFLOW_STRINGS = {
  en: {
    "gitflow.graph": "Commit graph",
    "gitflow.loading": "Loading the commit graph…",
    "gitflow.noFolder": "Open a folder with a git repository.",
    "gitflow.empty": "No commits to show (empty or not a git repository).",
    "gitflow.refresh": "Refresh",
    "gitflow.counts": "{c} commits · {b} branches",
    "gitflow.onBranch": "On branch {branch}",
    "gitflow.detailLoading": "Loading commit detail…",
    "gitflow.detailEmpty": "No detail for this commit.",
    "gitflow.btnFeature": "+ feature", "gitflow.btnFix": "+ fix",
    "gitflow.btnRelease": "+ release", "gitflow.btnHotfix": "+ hotfix",
    "gitflow.btnFinish": "Finish {branch}",
    "gitflow.dismiss": "Dismiss",
    "gitflow.startFeature": "Gitflow: start feature",
    "gitflow.startFix": "Gitflow: start fix",
    "gitflow.startRelease": "Gitflow: start release",
    "gitflow.startHotfix": "Gitflow: start hotfix",
    "gitflow.finishCmd": "Gitflow: finish (show commands)",
    "gitflow.branchCmd": "Gitflow: current branch",
    "gitflow.promptFeature": "Feature name (e.g. export-report)",
    "gitflow.promptFix": "Fix name (e.g. login-crash)",
    "gitflow.promptRelease": "Release version (e.g. 0.3.0)",
    "gitflow.promptHotfix": "Hotfix version (e.g. 0.3.1)",
    "gitflow.emptyName": "Give the branch a name.",
    "gitflow.created": "Branch created: {branch}",
    "gitflow.baseMissing": "Base branch {base} not found — create or check it out first.",
    "gitflow.finishTitle": "Finish {branch}",
    "gitflow.finishNote": "Run these in the terminal — there is no merge command in the backend, so nothing was merged.",
    "gitflow.finishNotFlow": "Finish applies only to feature/fix/release/hotfix branches. Current: {branch}",
  },
  ptAO: {
    "gitflow.graph": "Grafo de commits",
    "gitflow.loading": "A carregar o grafo de commits…",
    "gitflow.noFolder": "Abre uma pasta com um repositório git.",
    "gitflow.empty": "Sem commits para mostrar (vazio ou não é um repositório git).",
    "gitflow.refresh": "Actualizar",
    "gitflow.counts": "{c} commits · {b} ramos",
    "gitflow.onBranch": "No ramo {branch}",
    "gitflow.detailLoading": "A carregar o detalhe do commit…",
    "gitflow.detailEmpty": "Sem detalhe para este commit.",
    "gitflow.btnFeature": "+ feature", "gitflow.btnFix": "+ fix",
    "gitflow.btnRelease": "+ release", "gitflow.btnHotfix": "+ hotfix",
    "gitflow.btnFinish": "Finalizar {branch}",
    "gitflow.dismiss": "Fechar",
    "gitflow.startFeature": "Gitflow: iniciar feature",
    "gitflow.startFix": "Gitflow: iniciar fix",
    "gitflow.startRelease": "Gitflow: iniciar release",
    "gitflow.startHotfix": "Gitflow: iniciar hotfix",
    "gitflow.finishCmd": "Gitflow: finalizar (mostrar comandos)",
    "gitflow.branchCmd": "Gitflow: ramo actual",
    "gitflow.promptFeature": "Nome da feature (ex.: exportar-relatorio)",
    "gitflow.promptFix": "Nome do fix (ex.: login-crash)",
    "gitflow.promptRelease": "Versão da release (ex.: 0.3.0)",
    "gitflow.promptHotfix": "Versão do hotfix (ex.: 0.3.1)",
    "gitflow.emptyName": "Dá um nome ao ramo.",
    "gitflow.created": "Ramo criado: {branch}",
    "gitflow.baseMissing": "Ramo base {base} não encontrado — cria-o ou faz-lhe checkout primeiro.",
    "gitflow.finishTitle": "Finalizar {branch}",
    "gitflow.finishNote": "Corre isto no terminal — não há comando de merge no backend, portanto nada foi fundido.",
    "gitflow.finishNotFlow": "Finalizar só se aplica a ramos feature/fix/release/hotfix. Actual: {branch}",
  },
};
