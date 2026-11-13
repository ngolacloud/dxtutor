// shell/team.ts — Fase 5: Equipa de assistentes + harness + router de modelos.
//
// Esta vista é CONFIGURAÇÃO + PRÉ-VISUALIZAÇÃO do lado do cliente:
//  • Equipa: cartões editáveis por assistente (caminhos onde pode escrever,
//    comandos permitidos, limite de ficheiros, modelo). Estado persistido em
//    localStorage («dxtutor.team»), semeado com os assistentes do protótipo.
//  • Testador de escopo: dado um caminho/comando, mostra que assistente o pode
//    tocar (lógica `inScope`/`canRun` corrida localmente).
//  • Router de modelos: capacidades por provedor × perfis de tarefa; `rankModels`
//    escolhe. Os provedores e a sua disponibilidade vêm do backend REAL
//    (`list_providers`); as capacidades/pesos são config do cliente (editáveis).
//
// HONESTIDADE: NÃO existe comando de backend que IMPONHA este harness em cada
// chamada de ferramenta. Aqui o harness é desenho e pré-visualização — a
// aplicação real em cada chamada de ferramenta do backend ainda não está ligada
// (ver PENDING.md). Nada é simulado em silêncio: `list_providers` é real.

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { hydrate } from "./icons";
import { VIEW, openTab, note, addCommand, type Tab } from "./index";

// ─────────────────────────── Tipos ───────────────────────────
// Espelha `tutor_llm::chat::ProviderInfo` (serde camelCase). Só usamos id/name/
// available; os restantes campos (streaming/cancel/tools/context/note/models)
// são reportados pelo backend mas não são precisos para o router.
interface ProviderInfo { id: string; name: string; available: boolean }

type Cap = "reason" | "code" | "speed" | "cost" | "priv" | "ctx";
type TaskId = "arch" | "code" | "db" | "ui" | "test" | "ops" | "teach" | "sens";

/** Parte editável de um assistente (o que persiste). */
interface AgentState { paths: string[]; cmds: string[]; model: string; max: number }
/** Metadados fixos (semente) de cada assistente. */
interface AgentSeed { col: string; task: TaskId; paths: string[]; cmds: string[]; model: string; max: number }

const CAPS: Cap[] = ["reason", "code", "speed", "cost", "priv", "ctx"];
const TASKS: TaskId[] = ["arch", "code", "db", "ui", "test", "ops", "teach", "sens"];

// Pesos de cada perfil de tarefa (config do cliente; apresentados na vista).
const TASK_WEIGHTS: Record<TaskId, Partial<Record<Cap, number>>> = {
  arch: { reason: 5, ctx: 3, code: 1 },
  code: { code: 5, reason: 2, speed: 1 },
  db: { reason: 4, code: 3, ctx: 1 },
  ui: { code: 3, speed: 3, cost: 2 },
  test: { code: 3, speed: 3, cost: 3 },
  ops: { reason: 3, code: 3, cost: 2 },
  teach: { reason: 5, speed: 2 },
  sens: { priv: 10, cost: 1 },
};

// Ordem canónica dos assistentes (as chaves do objecto preservam-na).
const AGENT_ORDER = ["lead", "arq", "be", "db", "fe", "qa", "ops", "tutor"] as const;
type AgentKey = (typeof AGENT_ORDER)[number];

const AGENT_SEED: Record<AgentKey, AgentSeed> = {
  lead: { col: "#e06c3b", task: "arch", paths: ["**"], cmds: ["*"], model: "auto", max: 20 },
  arq: { col: "#e08a5b", task: "arch", paths: [".dxtutor/**", "docs/**"], cmds: [], model: "auto", max: 4 },
  be: { col: "#dea584", task: "code", paths: ["crates/**"], cmds: ["cargo build", "cargo test", "cargo clippy"], model: "auto", max: 6 },
  db: { col: "#5cc9a7", task: "db", paths: ["db/migrations/**"], cmds: ["cargo test -p store"], model: "auto", max: 3 },
  fe: { col: "#6ea8ff", task: "ui", paths: ["desktop/src/**"], cmds: ["dx lint", "npm run dev", "npm run lint"], model: "auto", max: 6 },
  qa: { col: "#e0b64a", task: "test", paths: ["crates/*/tests/**", "tests/**"], cmds: ["cargo test", "dx lint", "dx test"], model: "auto", max: 6 },
  ops: { col: "#c678dd", task: "ops", paths: ["deploy/**", ".ci/**", "Cargo.toml"], cmds: ["cargo build", "git push"], model: "auto", max: 4 },
  tutor: { col: "#5fcad6", task: "teach", paths: [], cmds: [], model: "auto", max: 0 },
};

// Capacidades-semente por provedor (0–10). Chaveadas pelos ids reais de
// `list_providers`. O «codex» do protótipo é o provedor `openai`.
const CAP_SEED: Record<string, Record<Cap, number>> = {
  claude: { reason: 10, code: 9, speed: 6, cost: 4, priv: 3, ctx: 9 },
  gemini: { reason: 8, code: 8, speed: 8, cost: 7, priv: 3, ctx: 10 },
  openai: { reason: 8, code: 10, speed: 7, cost: 6, priv: 3, ctx: 7 },
  ollama: { reason: 5, code: 6, speed: 5, cost: 10, priv: 10, ctx: 4 },
  copilot: { reason: 6, code: 8, speed: 7, cost: 6, priv: 3, ctx: 6 },
};
const DEFAULT_CAP: Record<Cap, number> = { reason: 5, code: 5, speed: 5, cost: 5, priv: 5, ctx: 5 };

// ─────────────────────────── Estado do cliente ───────────────────────────
const LS_KEY = "dxtutor.team";
interface Persisted {
  agents?: Partial<Record<string, Partial<AgentState>>>;
  caps?: Partial<Record<string, Partial<Record<Cap, number>>>>;
}

const agents: Record<string, AgentState> = {};
const caps: Record<string, Record<Cap, number>> = {};
let providers: ProviderInfo[] = [];
let providersLoaded = false;
let pendingNoted = false;

function seedState(): void {
  for (const k of AGENT_ORDER) {
    const s = AGENT_SEED[k];
    agents[k] = { paths: [...s.paths], cmds: [...s.cmds], model: s.model, max: s.max };
  }
  for (const id of Object.keys(CAP_SEED)) caps[id] = { ...CAP_SEED[id] };
}

function load(): void {
  let raw: string | null = null;
  try { raw = localStorage.getItem(LS_KEY); } catch { raw = null; }
  if (!raw) return;
  let data: Persisted;
  try { data = JSON.parse(raw) as Persisted; } catch { return; }
  if (data.agents) {
    for (const k of AGENT_ORDER) {
      const p = data.agents[k];
      if (!p) continue;
      if (Array.isArray(p.paths)) agents[k].paths = p.paths.map(String);
      if (Array.isArray(p.cmds)) agents[k].cmds = p.cmds.map(String);
      if (typeof p.model === "string") agents[k].model = p.model;
      if (typeof p.max === "number" && Number.isFinite(p.max)) agents[k].max = p.max;
    }
  }
  if (data.caps) {
    for (const id of Object.keys(data.caps)) {
      const cv = data.caps[id];
      if (!cv) continue;
      const base = caps[id] ?? { ...DEFAULT_CAP };
      for (const c of CAPS) if (typeof cv[c] === "number" && Number.isFinite(cv[c] as number)) base[c] = cv[c] as number;
      caps[id] = base;
    }
  }
}

function save(): void {
  const data: Persisted = {
    agents: Object.fromEntries(AGENT_ORDER.map((k) => [k, { paths: agents[k].paths, cmds: agents[k].cmds, model: agents[k].model, max: agents[k].max }])),
    caps,
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* armazenamento indisponível — segue em memória */ }
}

function capsOf(id: string): Record<Cap, number> { return caps[id] ?? CAP_SEED[id] ?? DEFAULT_CAP; }

// ─────────────────────────── Harness (lado do cliente) ───────────────────────────
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const norm = (p: string): string => p.trim().replace(/^\.?\/+/, "");

/** Compila um padrão glob (`*` = um segmento, `**` = qualquer) para RegExp. */
function globRe(g: string): RegExp {
  const body = g
    .split("**")
    .map((s) => s.split("*").map((x) => x.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp("^" + body + "$");
}
const inScope = (key: string, path: string): boolean => agents[key].paths.some((g) => globRe(g).test(path));
const canRun = (key: string, cmd: string): boolean => agents[key].cmds.some((c) => c === "*" || cmd.startsWith(c));

// ─────────────────────────── Router de modelos ───────────────────────────
/** Provedores disponíveis (do backend real), ordenados pela pontuação do perfil. */
function rankModels(task: TaskId): { id: string; name: string; score: number }[] {
  const w = TASK_WEIGHTS[task];
  return providers
    .filter((p) => p.available)
    .map((p) => {
      const cap = capsOf(p.id);
      const score = CAPS.reduce((acc, c) => acc + cap[c] * (w[c] ?? 0), 0);
      return { id: p.id, name: p.name, score };
    })
    .sort((a, b) => b.score - a.score);
}

function provColor(id: string): string { return AGENT_SEED[id as AgentKey]?.col ?? "#8a8f9c"; }

// ─────────────────────────── Vista ───────────────────────────
const teamView = (_tab: Tab, host: HTMLElement): void => { void render(host); };

async function render(host: HTMLElement): Promise<void> {
  if (!providersLoaded) {
    try { providers = await invoke<ProviderInfo[]>("list_providers"); } catch { providers = []; }
    providersLoaded = true;
  }
  if (!pendingNoted) { note(t("team.pendingNote")); pendingNoted = true; }

  let html = `<div class="page"><h1>${esc(t("team.title"))}</h1>` +
    `<div class="sub">${esc(t("team.subtitle"))}</div>` +
    `<div class="sub" style="color:var(--yellow)">${esc(t("team.pendingNote"))}</div>`;

  // Testador de escopo (pré-visualização local).
  html += `<h2>${esc(t("team.scopeHd"))}</h2><div class="tbl-wrap">` +
    `<div class="rowline"><input class="inp" id="tm-path" style="margin:0;width:320px" placeholder="${esc(t("team.scopePathPh"))}"><span id="tm-path-out" style="color:var(--fg-dim);flex:1"></span></div>` +
    `<div class="rowline"><input class="inp" id="tm-cmd" style="margin:0;width:320px" placeholder="${esc(t("team.scopeCmdPh"))}"><span id="tm-cmd-out" style="color:var(--fg-dim);flex:1"></span></div>` +
    `</div>`;

  // Cartões dos assistentes.
  html += `<h2>${esc(t("team.assistantsHd"))}</h2>` +
    `<div class="pgrid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">`;
  for (const k of AGENT_ORDER) {
    const a = agents[k];
    const name = t("team.agent." + k + ".n");
    const desc = t("team.agent." + k + ".d");
    const col = AGENT_SEED[k].col;
    html += `<div class="pcard" data-agent="${k}">` +
      `<div class="ph"><span class="av" style="background:${col}">${esc(name.charAt(0))}</span>${esc(name)}</div>` +
      `<div class="pd">${esc(desc)}</div>` +
      `<div><label>${esc(t("team.pathsLabel"))}</label><textarea rows="2" data-f="paths">${esc(a.paths.join("\n"))}</textarea></div>` +
      `<div><label>${esc(t("team.cmdsLabel"))}</label><textarea rows="2" data-f="cmds">${esc(a.cmds.join("\n"))}</textarea></div>` +
      `<div style="display:grid;grid-template-columns:1fr 90px;gap:8px">` +
      `<div><label>${esc(t("team.modelLabel"))}</label><select data-f="model">${modelOptions(a.model)}</select></div>` +
      `<div><label>${esc(t("team.maxLabel"))}</label><input type="number" min="0" max="50" value="${a.max}" data-f="max"></div>` +
      `</div></div>`;
  }
  html += `</div>`;

  // Router de modelos: capacidades × perfis.
  html += `<h2>${esc(t("team.routerHd"))}</h2><div class="sub">${esc(t("team.routerSub"))}</div>`;
  if (!providers.length) {
    html += `<div class="tbl-wrap"><div class="rowline">${esc(t("team.noProviders"))}</div></div>`;
  } else {
    html += `<div class="tbl-wrap"><table class="tbl"><tr><th>${esc(t("team.provider"))}</th>` +
      CAPS.map((c) => `<th>${esc(t("team.cap." + c))}</th>`).join("") + `</tr>`;
    for (const p of providers) {
      const cap = capsOf(p.id);
      html += `<tr><td><span class="pdot${p.available ? "" : " off"}" style="background:${provColor(p.id)}"></span> ${esc(p.name)}</td>` +
        CAPS.map((c) => `<td class="c"><input type="number" min="0" max="10" value="${cap[c]}" data-prov="${esc(p.id)}" data-cap="${c}" style="width:52px"></td>`).join("") +
        `</tr>`;
    }
    html += `</table></div>`;
    html += `<div class="sub">${esc(t("team.capHint"))}</div>`;
    // Perfis de tarefa → modelo escolhido.
    html += `<div class="tbl-wrap" style="margin-top:10px">`;
    for (const task of TASKS) {
      const w = TASK_WEIGHTS[task];
      const r = rankModels(task);
      const weightsTxt = CAPS.filter((c) => w[c]).map((c) => t("team.cap." + c) + " ×" + w[c]).join(" · ");
      const top = r.length
        ? `<span class="pdot" style="background:${provColor(r[0].id)}"></span>${esc(r[0].name)}`
        : "—";
      html += `<div class="rowline"><b style="width:210px;flex:none">${esc(t("team.task." + task))}</b>` +
        `<span style="color:var(--fg-muted)">${esc(weightsTxt)}</span><span class="sp"></span>${top}</div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  host.innerHTML = html;
  hydrate(host);
  wire(host);
}

/** Opções do selector de modelo: «auto» + provedores reais (preserva escolha fora da lista). */
function modelOptions(current: string): string {
  const opts = [`<option value="auto"${current === "auto" ? " selected" : ""}>${esc(t("team.modelAuto"))}</option>`];
  const ids = new Set(providers.map((p) => p.id));
  for (const p of providers) {
    opts.push(`<option value="${esc(p.id)}"${current === p.id ? " selected" : ""}>${esc(p.name)}</option>`);
  }
  if (current !== "auto" && !ids.has(current)) {
    opts.push(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
  }
  return opts.join("");
}

// ─────────────────────────── Ligação de eventos ───────────────────────────
function wire(host: HTMLElement): void {
  const pathIn = host.querySelector<HTMLInputElement>("#tm-path");
  const pathOut = host.querySelector<HTMLElement>("#tm-path-out");
  const cmdIn = host.querySelector<HTMLInputElement>("#tm-cmd");
  const cmdOut = host.querySelector<HTMLElement>("#tm-cmd-out");

  if (pathIn && pathOut) pathIn.addEventListener("input", () => probePath(pathIn.value, pathOut));
  if (cmdIn && cmdOut) cmdIn.addEventListener("input", () => probeCmd(cmdIn.value, cmdOut));

  host.querySelectorAll<HTMLElement>(".pcard[data-agent]").forEach((card) => {
    const key = card.dataset.agent!;
    const a = agents[key];
    const pathsTa = card.querySelector<HTMLTextAreaElement>('textarea[data-f="paths"]');
    const cmdsTa = card.querySelector<HTMLTextAreaElement>('textarea[data-f="cmds"]');
    const modelSel = card.querySelector<HTMLSelectElement>('select[data-f="model"]');
    const maxIn = card.querySelector<HTMLInputElement>('input[data-f="max"]');
    const lines = (v: string): string[] => v.split("\n").map((s) => s.trim()).filter(Boolean);
    pathsTa?.addEventListener("change", () => { a.paths = lines(pathsTa.value); save(); refresh(host); });
    cmdsTa?.addEventListener("change", () => { a.cmds = lines(cmdsTa.value); save(); refresh(host); });
    modelSel?.addEventListener("change", () => { a.model = modelSel.value; save(); });
    maxIn?.addEventListener("change", () => {
      const n = Math.max(0, Math.min(50, Math.round(Number(maxIn.value) || 0)));
      a.max = n; maxIn.value = String(n); save();
    });
  });

  host.querySelectorAll<HTMLInputElement>("input[data-prov][data-cap]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const id = inp.dataset.prov!;
      const c = inp.dataset.cap as Cap;
      const n = Math.max(0, Math.min(10, Math.round(Number(inp.value) || 0)));
      const row = caps[id] ?? { ...(CAP_SEED[id] ?? DEFAULT_CAP) };
      row[c] = n; caps[id] = row;
      inp.value = String(n);
      save();
      refresh(host);
    });
  });
}

/** Re-renderiza preservando a posição (os provedores já estão em cache). */
function refresh(host: HTMLElement): void { void render(host); }

function probePath(value: string, out: HTMLElement): void {
  const v = norm(value);
  if (!v) { out.textContent = ""; return; }
  const who = AGENT_ORDER.filter((k) => k !== "lead" && inScope(k, v));
  out.innerHTML = who.length
    ? esc(t("team.scopePathCan")) + " " + who.map((k) => `<b style="color:${AGENT_SEED[k].col}">${esc(t("team.agent." + k + ".n"))}</b>`).join(", ")
    : esc(t("team.scopePathNone"));
}

function probeCmd(value: string, out: HTMLElement): void {
  const v = value.trim();
  if (!v) { out.textContent = ""; return; }
  const who = AGENT_ORDER.filter((k) => canRun(k, v));
  out.innerHTML = who.length
    ? esc(t("team.scopeCmdCan")) + " " + who.map((k) => `<b style="color:${AGENT_SEED[k].col}">${esc(t("team.agent." + k + ".n"))}</b>`).join(", ")
    : esc(t("team.scopeCmdNone"));
}

// ─────────────────────────── Arranque ───────────────────────────
export function initTeam(): void {
  registerStrings(TEAM_STRINGS);
  seedState();
  load();
  VIEW.team = teamView;
  addCommand({ id: "team:open", label: () => t("cmd.team"), run: () => openTab({ id: "team", title: t("team.title"), kind: "team" }) });
}

const TEAM_STRINGS = {
  en: {
    "team.title": "Assistant team",
    "team.subtitle": "Each assistant owns a responsibility and a harness: the paths it may write, the commands it may run and a per-task file limit.",
    "team.pendingNote": "Note: this harness is client-side configuration and preview — enforcing it on every backend tool call is not wired yet.",
    "team.scopeHd": "Scope tester",
    "team.scopePathPh": "e.g. db/migrations/0005_x.sql",
    "team.scopeCmdPh": "e.g. cargo test",
    "team.scopePathCan": "Can write:",
    "team.scopePathNone": "No specialist owns this path — only the orchestrator, with your approval.",
    "team.scopeCmdCan": "Can run:",
    "team.scopeCmdNone": "No assistant is allowed to run this command.",
    "team.assistantsHd": "Assistants",
    "team.pathsLabel": "Can write in (one pattern per line)",
    "team.cmdsLabel": "Allowed commands",
    "team.modelLabel": "Model",
    "team.maxLabel": "Max files",
    "team.modelAuto": "Automatic (router)",
    "team.routerHd": "Model router",
    "team.routerSub": "With the model on Automatic, the ranker picks the best available provider for the task. Capabilities and weights are example values, editable here.",
    "team.provider": "Provider",
    "team.noProviders": "No providers reported by the backend.",
    "team.capHint": "Capability values (0–10) are client-side config — editing them re-ranks the profiles below.",
    "team.cap.reason": "Reasoning", "team.cap.code": "Code", "team.cap.speed": "Speed",
    "team.cap.cost": "Cost", "team.cap.priv": "Privacy", "team.cap.ctx": "Context",
    "team.task.arch": "Architecture and decomposition", "team.task.code": "Implementation",
    "team.task.db": "Data modelling", "team.task.ui": "Interface", "team.task.test": "Testing",
    "team.task.ops": "Infra and pipelines", "team.task.teach": "Explanation and tutoring", "team.task.sens": "Sensitive data",
    "team.agent.lead.n": "Co-Dev", "team.agent.lead.d": "Orchestrator: decomposes, delegates and integrates",
    "team.agent.arq.n": "Architect", "team.agent.arq.d": "Requirements, architecture, ADRs and backlog",
    "team.agent.be.n": "Backend", "team.agent.be.d": "Rust crates and Tauri commands",
    "team.agent.db.n": "Database", "team.agent.db.d": "Schema, migrations and indexes",
    "team.agent.fe.n": "Frontend", "team.agent.fe.d": "Interface and Design System",
    "team.agent.qa.n": "QA", "team.agent.qa.d": "Automated tests",
    "team.agent.ops.n": "Platform", "team.agent.ops.d": "Infra, CI/CD and deploy",
    "team.agent.tutor.n": "Tutor", "team.agent.tutor.d": "Explains and guides; never writes for you",
    "cmd.team": "Team: assistants and harness",
  },
  ptAO: {
    "team.title": "Equipa de assistentes",
    "team.subtitle": "Cada assistente tem uma responsabilidade e um harness: os caminhos onde pode escrever, os comandos que pode correr e um limite de ficheiros por tarefa.",
    "team.pendingNote": "Nota: este harness é configuração e pré-visualização do lado do cliente — a aplicação real do harness em cada chamada de ferramenta do backend ainda não está ligada.",
    "team.scopeHd": "Testar o escopo",
    "team.scopePathPh": "ex.: db/migrations/0005_x.sql",
    "team.scopeCmdPh": "ex.: cargo test",
    "team.scopePathCan": "Pode escrever:",
    "team.scopePathNone": "Nenhum assistente especializado é dono deste caminho — só o orquestrador, com a tua aprovação.",
    "team.scopeCmdCan": "Pode correr:",
    "team.scopeCmdNone": "Nenhum assistente tem permissão para correr este comando.",
    "team.assistantsHd": "Assistentes",
    "team.pathsLabel": "Pode escrever em (um padrão por linha)",
    "team.cmdsLabel": "Comandos permitidos",
    "team.modelLabel": "Modelo",
    "team.maxLabel": "Máx. ficheiros",
    "team.modelAuto": "Automático (router)",
    "team.routerHd": "Router de modelos",
    "team.routerSub": "Com o modelo em «Automático», o selector escolhe o melhor provedor disponível para a tarefa. As capacidades e os pesos são valores de exemplo, editáveis aqui.",
    "team.provider": "Provedor",
    "team.noProviders": "O backend não reportou provedores.",
    "team.capHint": "Os valores de capacidade (0–10) são config do lado do cliente — editá-los reordena os perfis abaixo.",
    "team.cap.reason": "Raciocínio", "team.cap.code": "Código", "team.cap.speed": "Rapidez",
    "team.cap.cost": "Economia", "team.cap.priv": "Privacidade", "team.cap.ctx": "Contexto",
    "team.task.arch": "Arquitectura e decomposição", "team.task.code": "Implementação",
    "team.task.db": "Modelação de dados", "team.task.ui": "Interface", "team.task.test": "Testes",
    "team.task.ops": "Infra e pipelines", "team.task.teach": "Explicação e tutoria", "team.task.sens": "Dados sensíveis",
    "team.agent.lead.n": "Co-Dev", "team.agent.lead.d": "Orquestrador: decompõe, delega e integra",
    "team.agent.arq.n": "Arquitecto", "team.agent.arq.d": "Requisitos, arquitectura, ADRs e backlog",
    "team.agent.be.n": "Backend", "team.agent.be.d": "Crates Rust e comandos Tauri",
    "team.agent.db.n": "Base de dados", "team.agent.db.d": "Esquema, migrações e índices",
    "team.agent.fe.n": "Frontend", "team.agent.fe.d": "Interface e Design System",
    "team.agent.qa.n": "QA", "team.agent.qa.d": "Testes automáticos",
    "team.agent.ops.n": "Plataforma", "team.agent.ops.d": "Infra, CI/CD e deploy",
    "team.agent.tutor.n": "Tutor", "team.agent.tutor.d": "Explica e orienta; nunca escreve por ti",
    "cmd.team": "Equipa: assistentes e harness",
  },
};
