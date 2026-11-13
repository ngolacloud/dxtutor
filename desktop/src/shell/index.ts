// shell/index.ts — orquestrador da casca da IDE dxtutor (Fase 1 da reescrita).
//
// Porta o "chrome" de docs/prototype/index.html para um módulo ES real: barra de
// menus, activity bar, sidebar com panes permutáveis, área de separadores com um
// router de vistas por `kind`, painel inferior com abas, barra de estado, paleta
// de comandos, atalhos, 3 temas e tokens.
//
// Regra de honestidade (ver docs/ui-rewrite/PLAN.md): o que ainda não está ligado
// ao backend aparece VISÍVEL mas DESACTIVADO, com «not implemented yet» e entrada
// em docs/ui-rewrite/PENDING.md. Nada é simulado em silêncio. As funcionalidades
// reais são ligadas nas fases seguintes (paridade, learning track, co-dev, …).

import { svg, hydrate } from "./icons";
import { THEMES, setTheme, currentTheme } from "./theme";
import { t, getLocale, setLocale, type Locale } from "../i18n";

const $ = <T extends HTMLElement = HTMLElement>(s: string): T | null => document.querySelector<T>(s);
const $$ = (s: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(s));
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// ───────────────────────────── estado ──────────────────────────────
export type ViewKind =
  | "file" | "diff" | "agent" | "welcome" | "settings" | "manager"
  | "analysis" | "graph" | "team" | "studio" | "board" | "learn" | "lt";
export interface Tab { id: string; title: string; kind: ViewKind; path?: string }
export type ViewFn = (tab: Tab, host: HTMLElement) => void;

let TB: Tab[] = [];
let cur: string | null = null;
let PANE = "explorer";

/** Registo de renderizadores de vista por `kind`. Preenchido abaixo. */
export const VIEW: Partial<Record<ViewKind, ViewFn>> = {};
/** Registo de renderizadores de pane por id. */
export const RP: Record<string, () => void> = {};

const tabOf = (id: string): Tab | undefined => TB.find((o) => o.id === id);
const getVar = (v: string): string => getComputedStyle(document.body).getPropertyValue(v).trim();
const setVar = (v: string, val: string): void => document.body.style.setProperty(v, val);
const sideOpen = (): boolean => getVar("--side-w") !== "0px";

// ───────────────────────────── toast / notes / clock ──────────────────────────────
let toTimer: number | undefined;
export function toast(m: string): void {
  const el = $("#toast");
  if (!el) return;
  el.textContent = m;
  el.style.opacity = "1";
  el.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(toTimer);
  toTimer = window.setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(20px)";
  }, 1600);
}

/** Aviso padrão para superfícies ainda não ligadas (ver PENDING.md). */
function nyiToast(label?: string): void {
  toast((label ? label + " — " : "") + t("nyi.toast"));
}

const NOTES: Array<{ t: string; m: string }> = [];
let UNREAD = 0;
const hhmm = (): string => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
export function note(m: string): void { NOTES.unshift({ t: hhmm(), m }); UNREAD++; drawBell(); }
function drawBell(): void { const el = $("#st-bell-n"); if (el) el.innerHTML = UNREAD ? `<span class="nb">${UNREAD}</span>` : ""; }
function toggleNotes(): void {
  const n = $("#notes");
  if (!n) return;
  if (n.classList.toggle("show")) {
    UNREAD = 0; drawBell();
    n.innerHTML = NOTES.length
      ? NOTES.slice(0, 20).map((x) => `<div class="nt"><span class="tm">${x.t}</span><span>${esc(x.m)}</span></div>`).join("")
      : `<div class="nt">${t("notes.empty")}</div>`;
  }
}
function tick(): void {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  const m = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"][d.getMonth()];
  const el = $("#clock"); if (el) el.textContent = `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}-${m}`;
}

// ───────────────────────────── placeholder «not implemented yet» ──────────────────────────────
function nyiPage(host: HTMLElement, titleKey: string, phase: number): void {
  host.innerHTML = `<div class="page"><h1>${esc(t(titleKey))}</h1>
    <div class="sub">${esc(t("nyi.page", { phase }))}</div>
    <div class="pcard" style="max-width:520px;margin-top:14px"><div class="ph">${svg("shield")} ${esc(t("nyi.badge"))}</div>
    <div class="pd">${esc(t("nyi.explain"))}</div></div></div>`;
  hydrate(host);
}
function nyiPane(paneId: string, titleKey: string, phase: number): void {
  const el = $("#" + paneId);
  if (!el) return;
  el.innerHTML = paneHead(t(titleKey)) +
    `<div class="sec-empty">${esc(t("nyi.pane", { phase }))}</div>`;
  hydrate(el);
}
const paneHead = (title: string, acts = ""): string =>
  `<div class="side-hd"><span class="t">${esc(title)}</span><span class="acts">${acts}</span></div>`;

// ───────────────────────────── activity bar ──────────────────────────────
interface ActDef { ic: string; pane?: string; run?: () => void; title: string; acc?: boolean; sep?: boolean; spacer?: boolean; overflow?: boolean }
let ACTS: ActDef[] = [];
const OVERFLOW: Array<{ l: string; pane?: string }> = [];

function buildActivity(): void {
  const bar = $("#activity"); if (!bar) return;
  bar.innerHTML = "";
  ACTS.forEach((a) => {
    const el = document.createElement("button");
    el.className = "act" + (a.spacer ? " spacer" : "") + (a.sep ? " sep" : "");
    el.title = a.title;
    el.dataset.pane = a.pane || "";
    el.innerHTML = svg(a.ic) + `<span class="badge${a.acc ? " acc" : ""}" style="display:none"></span>`;
    el.onclick = (e) => { e.stopPropagation(); a.overflow ? openOverflow(el) : a.run ? a.run() : setPane(a.pane!, true); };
    bar.appendChild(el);
  });
  const first = bar.querySelector(".act"); if (first) first.classList.add("on");
}

function openOverflow(btn: HTMLElement): void {
  closeMenus();
  const r = btn.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.className = "menu-pop show";
  document.body.appendChild(pop);
  const title = document.createElement("div");
  title.className = "mi";
  title.style.cssText = "color:var(--fg-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;pointer-events:none";
  title.textContent = t("shell.additionalViews");
  pop.appendChild(title);
  OVERFLOW.forEach((it) => {
    const mi = document.createElement("div");
    mi.className = "mi";
    mi.innerHTML = `<span>${esc(it.l)}</span>`;
    mi.onclick = (e) => { e.stopPropagation(); closeMenus(); if (it.pane) setPane(it.pane); };
    pop.appendChild(mi);
  });
  let y = r.top; const h = pop.offsetHeight;
  if (y + h > innerHeight) y = innerHeight - h - 6;
  pop.style.left = r.right + 4 + "px";
  pop.style.top = y + "px";
}

// ───────────────────────────── sidebar panes ──────────────────────────────
function setPane(p: string, tgl?: boolean): void {
  if (p === "settings") { openSettings(); return; }
  if (tgl === true && PANE === p && sideOpen()) { toggleSide(); return; }
  if (!sideOpen()) toggleSide();
  PANE = p;
  $$(".act").forEach((a) => a.classList.toggle("on", a.dataset.pane === p));
  $$(".pane").forEach((x) => x.classList.remove("show"));
  const pe = $("#pane-" + p); if (pe) pe.classList.add("show");
  if (RP[p]) RP[p]();
  hydrate();
}
const goPane = (p: string): void => setPane(p);

// ───────────────────────────── tab area + view router ──────────────────────────────
function tabIc(t2: Tab): string {
  if (t2.kind === "lt") return `<span class="ic acc">${svg("book")}</span>`;
  const m: Record<string, string> = { agent: "sparkle", welcome: "sparkle", diff: "scm", settings: "settings", manager: "graph", analysis: "book", graph: "scm", team: "account", studio: "cube", board: "split", file: "file" };
  return `<span class="ic acc">${svg(m[t2.kind] || "file")}</span>`;
}

function drawTabs(): void {
  const host = $("#tabs"); if (!host) return;
  host.innerHTML = "";
  TB.forEach((tb) => {
    const el = document.createElement("div");
    el.className = "tab" + (tb.id === cur ? " active" : "");
    el.title = tb.path || tb.title;
    el.innerHTML = `${tabIc(tb)}<span class="nm">${esc(tb.title)}</span><button class="x">${svg("close")}</button>`;
    el.onclick = (e) => { if ((e.target as HTMLElement).closest(".x")) { e.stopPropagation(); closeTab(tb.id); return; } show(tb.id); };
    el.onauxclick = (e) => { if (e.button === 1) closeTab(tb.id); };
    host.appendChild(el);
  });
  const a = host.querySelector(".active") as HTMLElement | null;
  if (a) a.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function openTab(tab: Tab, act?: boolean): void {
  const x = tabOf(tab.id);
  if (x) Object.assign(x, tab); else TB.push(tab);
  if (act === false) drawTabs(); else show(tab.id);
}

function show(id: string | null): void {
  const host = $("#ebody"); if (!host) return;
  host.innerHTML = ""; host.scrollTop = 0; host.scrollLeft = 0;
  const bc = $("#breadcrumbs");
  if (!id || !tabOf(id)) {
    cur = null; drawTabs(); miniOff();
    if (bc) bc.innerHTML = "";
    host.innerHTML = `<div class="empty"><div><b style="color:var(--fg-dim);font-size:14px">dxtutor IDE</b><br><kbd>Ctrl+P</kbd> ${esc(t("empty.goToFile"))} &nbsp; <kbd>Ctrl+Shift+P</kbd> ${esc(t("empty.commands"))}<br><kbd>Ctrl+L</kbd> ${esc(t("empty.codev"))} &nbsp; <kbd>Ctrl+\`</kbd> ${esc(t("empty.terminal"))}</div></div>`;
    stLang(); return;
  }
  const tab = tabOf(id)!;
  cur = id; drawTabs();
  if (bc) bc.innerHTML = (tab.path ? tab.path.split("/") : ["dxtutor", tab.title]).map((s, i, a) => `<span class="crumb"${i === a.length - 1 ? ' style="color:var(--fg)"' : ""}>${esc(s)}</span>`).join('<span class="sep">›</span>');
  miniOff();
  const fn = VIEW[tab.kind];
  const VIEW_PHASE: Record<string, number> = { file: 2, diff: 2, agent: 4, manager: 4, analysis: 2, graph: 6, team: 5, studio: 7, board: 7, learn: 3, lt: 3 };
  if (fn) fn(tab, host); else nyiPage(host, "view." + tab.kind, VIEW_PHASE[tab.kind] || 2);
  hydrate(host);
  stLang();
}

function closeTab(id: string): void {
  const i = TB.findIndex((tb) => tb.id === id); if (i < 0) return;
  TB.splice(i, 1);
  if (cur === id) show(TB.length ? TB[Math.max(0, i - 1)].id : null); else drawTabs();
}
function stepTab(d: number): void {
  if (!TB.length) return;
  const i = TB.findIndex((tb) => tb.id === cur);
  show(TB[(i + d + TB.length) % TB.length].id);
}
const miniOff = (): void => { const m = $("#minimap"); if (m) m.classList.add("hidden"); const e = $("#ebody"); if (e) e.classList.remove("with-mm"); };

// ───────────────────────────── toggles + resizers ──────────────────────────────
function toggleSide(): void { const o = sideOpen(); setVar("--side-w", o ? "0px" : "250px"); $("#tgl-side")?.classList.toggle("on", !o); }
function togglePanel(): void { const o = getVar("--panel-h") !== "0px"; setVar("--panel-h", o ? "0px" : "230px"); $("#tgl-panel")?.classList.toggle("on", !o); }
function toggleAgent(): void { const open = getVar("--agent-w") === "0px"; setVar("--agent-w", open ? "380px" : "0px"); $("#tgl-agent")?.classList.toggle("on", open); }
function focusAgent(): void { if (getVar("--agent-w") === "0px") toggleAgent(); $("#ag-input")?.focus(); }

function mkRz(el: HTMLElement | null, v: string, base: number, min: number, max: number, inv = false): void {
  if (!el) return;
  el.onmousedown = (e) => {
    e.preventDefault(); el.classList.add("drag");
    const sx = e.clientX, start = parseInt(getVar(v)) || base;
    const mv = (ev: MouseEvent) => { let d = ev.clientX - sx; if (inv) d = -d; document.body.style.setProperty(v, Math.min(max, Math.max(min, start + d)) + "px"); };
    const up = () => { el.classList.remove("drag"); removeEventListener("mousemove", mv); removeEventListener("mouseup", up); };
    addEventListener("mousemove", mv); addEventListener("mouseup", up);
  };
}

// ───────────────────────────── bottom panel ──────────────────────────────
function setPanelTab(pt: string): void {
  if (getVar("--panel-h") === "0px") togglePanel();
  $$(".ptab").forEach((b) => b.classList.toggle("on", b.dataset.pt === pt));
  $$(".pcontent").forEach((c) => c.classList.remove("show"));
  $("#pc-" + pt)?.classList.add("show");
}
function termClear(): void {
  const el = $("#term");
  if (el) el.innerHTML = `<span class="dim">${esc(t("term.placeholder"))}</span>`;
}

// ───────────────────────────── command palette ──────────────────────────────
interface Cmd { id: string; label: string; key?: string; run: () => void }
let CMD: Cmd[] = [];
interface PItem { l: string; d?: string; k?: string; ic?: string; run: () => void }
let PIDX = 0; let PITEMS: PItem[] = [];

function buildCmds(): void {
  const c = (id: string, key: string, run: () => void): Cmd => ({ id, label: t("cmd." + id), key, run });
  CMD = [
    c("goToFile", "Ctrl+P", () => palette("")),
    c("allCommands", "Ctrl+Shift+P", () => palette(">")),
    c("goToLine", "Ctrl+G", () => palette(":")),
    c("nextProblem", "F8", () => nyiToast(t("status.problems"))),
    c("explorer", "Ctrl+Shift+E", () => goPane("explorer")),
    c("search", "Ctrl+Shift+F", () => goPane("search")),
    c("scm", "Ctrl+Shift+G", () => goPane("scm")),
    c("run", "", () => goPane("run")),
    c("testing", "", () => goPane("test")),
    c("extensions", "", () => goPane("ext")),
    c("toggleSide", "Ctrl+B", toggleSide),
    c("togglePanel", "Ctrl+J", togglePanel),
    c("terminal", "Ctrl+`", () => setPanelTab("terminal")),
    c("problems", "Ctrl+Shift+M", () => setPanelTab("problems")),
    c("codevFocus", "Ctrl+L", focusAgent),
    c("codevPanel", "Ctrl+Shift+A", () => goPane("codev")),
    c("learningTrack", "", () => goPane("tutor")),
    c("studio", "", () => openView("studio", "view.studio")),
    c("board", "", () => openView("board", "view.board")),
    c("commitGraph", "", () => openView("graph", "view.graph")),
    c("team", "", () => openView("team", "view.team")),
    c("manager", "", () => openView("manager", "view.manager")),
    c("welcome", "", () => openTab({ id: "welcome", title: t("view.welcome"), kind: "welcome" })),
    c("settings", "Ctrl+,", openSettings),
    ...Object.keys(THEMES).map((n) => ({ id: "theme:" + n, label: t("cmd.theme") + " — " + n, key: "", run: () => setTheme(n) })),
    { id: "lang:en", label: t("cmd.lang") + " — English", run: () => setLocale("en") },
    { id: "lang:ptAO", label: t("cmd.lang") + " — Português (Angola)", run: () => setLocale("ptAO" as Locale) },
  ];
}

function palette(pre: string): void {
  closeMenus();
  const inp = $<HTMLInputElement>("#pal-in"); const pal = $("#pal");
  if (!inp || !pal) return;
  pal.classList.add("show");
  inp.value = pre || "";
  inp.placeholder = t("palette.placeholder");
  PIDX = 0; palDraw();
  setTimeout(() => inp.focus(), 0);
}
function closePal(): void { $("#pal")?.classList.remove("show"); }
function fuzzy(q: string, s: string): boolean {
  q = q.toLowerCase(); s = s.toLowerCase(); let i = 0;
  for (const ch of s) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return !q.length;
}
function palDraw(): void {
  const inp = $<HTMLInputElement>("#pal-in"); const list = $("#pal-list");
  if (!inp || !list) return;
  const q = inp.value;
  if (q.startsWith(">")) {
    const f = q.slice(1).trim();
    PITEMS = CMD.filter((cc) => fuzzy(f, cc.label)).map((cc) => ({ l: cc.label, k: cc.key, run: cc.run }));
  } else if (q.startsWith(":")) {
    const n = parseInt(q.slice(1)) || 1;
    PITEMS = [{ l: t("palette.gotoLine", { n }), run: () => nyiToast(t("cmd.goToLine")) }];
  } else {
    // Quick-open de ficheiros depende de uma pasta aberta (Fase 2). Sem workspace,
    // mostra o estado honesto em vez de inventar ficheiros.
    PITEMS = [{ l: t("palette.openFolderFirst"), run: () => { closePal(); nyiToast(t("cmd.goToFile")); } }];
  }
  PIDX = Math.min(PIDX, Math.max(0, PITEMS.length - 1));
  list.innerHTML = PITEMS.length
    ? PITEMS.map((it, i) => `<div class="pi${i === PIDX ? " on" : ""}" data-i="${i}">${it.ic || ""}<span>${esc(it.l)}</span>${it.d ? `<span class="d">${esc(it.d)}</span>` : ""}${it.k ? `<span class="key">${esc(it.k)}</span>` : ""}</div>`).join("")
    : `<div class="pal-empty">${esc(t("palette.noResults"))}</div>`;
  const on = list.querySelector(".on") as HTMLElement | null;
  if (on) on.scrollIntoView({ block: "nearest" });
}
function palRun(i: number): void { const it = PITEMS[i]; if (!it) return; closePal(); it.run(); }

// ───────────────────────────── menu bar ──────────────────────────────
interface MenuItem { l?: string; k?: string; act?: () => void; sep?: boolean; on?: boolean; sub?: MenuItem[] }
interface Menu { t: string; items: MenuItem[] }
let MENUS: Menu[] = [];

function buildMenus(): void {
  const theme = (): MenuItem[] => Object.keys(THEMES).map((n) => ({ l: n, on: n === currentTheme(), act: () => setTheme(n) }));
  const lang = (): MenuItem[] => [
    { l: "English", on: getLocale() === "en", act: () => setLocale("en") },
    { l: "Português (Angola)", on: getLocale() === "ptAO", act: () => setLocale("ptAO" as Locale) },
  ];
  MENUS = [
    { t: t("menu.file"), items: [
      { l: t("menu.newFile"), act: () => nyiToast() },
      { l: t("menu.newFolder"), act: () => nyiToast() },
      { sep: true },
      { l: t("menu.openFile"), k: "Ctrl+P", act: () => palette("") },
      { l: t("menu.openFolder"), act: () => nyiToast() },
      { sep: true },
      { l: t("menu.save"), k: "Ctrl+S", act: () => toast(t("toast.autosave")) },
      { sep: true },
      { l: t("menu.preferences"), sub: [
        { l: t("menu.settings"), k: "Ctrl+,", act: openSettings },
        { l: t("menu.theme"), sub: theme() },
        { l: t("menu.language"), sub: lang() },
      ] },
      { sep: true },
      { l: t("menu.closeTab"), act: () => cur && closeTab(cur) },
    ] },
    { t: t("menu.edit"), items: [
      { l: t("menu.undo"), k: "Ctrl+Z", act: () => nyiToast() },
      { l: t("menu.redo"), k: "Ctrl+Y", act: () => nyiToast() },
      { sep: true },
      { l: t("menu.findInFiles"), k: "Ctrl+Shift+F", act: () => goPane("search") },
    ] },
    { t: t("menu.selection"), items: [
      { l: t("menu.selectAll"), k: "Ctrl+A", act: () => nyiToast() },
      { l: t("menu.sendToCodev"), act: () => nyiToast() },
    ] },
    { t: t("menu.view"), items: [
      { l: t("menu.commandPalette"), k: "Ctrl+Shift+P", act: () => palette(">") },
      { sep: true },
      { l: t("nav.explorer"), k: "Ctrl+Shift+E", act: () => goPane("explorer") },
      { l: t("nav.search"), k: "Ctrl+Shift+F", act: () => goPane("search") },
      { l: t("nav.scm"), k: "Ctrl+Shift+G", act: () => goPane("scm") },
      { l: t("nav.test"), act: () => goPane("test") },
      { l: t("nav.codev"), k: "Ctrl+Shift+A", act: () => goPane("codev") },
      { sep: true },
      { l: t("menu.sidebar"), k: "Ctrl+B", on: sideOpen(), act: toggleSide },
      { l: t("menu.panel"), k: "Ctrl+J", on: getVar("--panel-h") !== "0px", act: togglePanel },
      { l: t("menu.codevPanel"), on: getVar("--agent-w") !== "0px", act: toggleAgent },
      { sep: true },
      { l: t("panel.terminal"), k: "Ctrl+`", act: () => setPanelTab("terminal") },
      { l: t("panel.problems"), k: "Ctrl+Shift+M", act: () => setPanelTab("problems") },
    ] },
    { t: t("menu.go"), items: [
      { l: t("menu.goToFile"), k: "Ctrl+P", act: () => palette("") },
      { l: t("menu.goToLine"), k: "Ctrl+G", act: () => palette(":") },
      { l: t("menu.nextProblem"), k: "F8", act: () => nyiToast() },
      { sep: true },
      { l: t("menu.nextTab"), act: () => stepTab(1) },
      { l: t("menu.prevTab"), act: () => stepTab(-1) },
    ] },
    { t: t("menu.run"), items: [
      { l: t("menu.runStack"), k: "F5", act: () => nyiToast() },
      { l: t("menu.stopStack"), act: () => nyiToast() },
    ] },
    { t: t("menu.project"), items: [
      { l: t("nav.studio"), act: () => openView("studio", "view.studio") },
      { l: t("nav.board"), act: () => openView("board", "view.board") },
      { l: t("menu.team"), act: () => openView("team", "view.team") },
      { l: t("menu.commitGraph"), act: () => openView("graph", "view.graph") },
      { sep: true },
      { l: t("nav.tutor"), act: () => goPane("tutor") },
    ] },
    { t: t("menu.codev"), items: [
      { l: t("codev.focus"), k: "Ctrl+L", act: focusAgent },
      { l: t("codev.newChat"), act: () => nyiToast() },
      { l: t("codev.pickModel"), act: () => nyiToast() },
      { sep: true },
      { l: t("codev.manager"), act: () => openView("manager", "view.manager") },
      { l: t("menu.settings"), act: openSettings },
    ] },
    { t: t("menu.terminal"), items: [
      { l: t("menu.showTerminal"), k: "Ctrl+`", act: () => setPanelTab("terminal") },
      { l: t("panel.clear"), act: termClear },
    ] },
    { t: t("menu.help"), items: [
      { l: t("menu.welcome"), act: () => openTab({ id: "welcome", title: t("view.welcome"), kind: "welcome" }) },
      { l: t("menu.about"), act: () => toast("dxtutor IDE") },
    ] },
  ];
}

let openMenu: HTMLElement | null = null;
function closeMenus(): void { $$(".menu-pop").forEach((p) => p.remove()); $$(".menu-top.open").forEach((m) => m.classList.remove("open")); openMenu = null; }
function buildMenubar(): void {
  const bar = $("#menubar"); if (!bar) return;
  bar.innerHTML = "";
  MENUS.forEach((m) => {
    const el = document.createElement("div");
    el.className = "menu-top"; el.textContent = m.t;
    el.onclick = (e) => { e.stopPropagation(); if (el.classList.contains("open")) { closeMenus(); return; } closeMenus(); el.classList.add("open"); openMenu = el; dropMenu(el, m.items); };
    el.onmouseenter = () => { if (openMenu && openMenu !== el) { closeMenus(); el.classList.add("open"); openMenu = el; dropMenu(el, m.items); } };
    bar.appendChild(el);
  });
}
function dropMenu(anchor: HTMLElement, items: MenuItem[], sub?: { x: number; y: number }): HTMLElement {
  const pop = document.createElement("div");
  pop.className = "menu-pop show";
  document.body.appendChild(pop);
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement("div"); s.className = "mi-sep"; pop.appendChild(s); return; }
    const mi = document.createElement("div");
    mi.className = "mi" + (it.k ? " has-key" : "");
    mi.innerHTML = `${it.on ? '<span class="mi-check">' + svg("check") + "</span>" : ""}<span>${esc(it.l || "")}</span>${it.k ? `<span class="key">${esc(it.k)}</span>` : ""}${it.sub ? `<span class="chev">${svg("chev")}</span>` : ""}`;
    if (it.sub) {
      mi.onmouseenter = () => { pop.querySelectorAll(".menu-pop").forEach((p) => p.remove()); const r = mi.getBoundingClientRect(); dropMenu(mi, it.sub!, { x: r.right - 2, y: r.top }); };
    } else if (it.act) {
      mi.onclick = (e) => { e.stopPropagation(); closeMenus(); it.act!(); };
    }
    pop.appendChild(mi);
    hydrate(mi);
  });
  const r = anchor.getBoundingClientRect();
  pop.style.left = (sub ? sub.x : r.left) + "px";
  pop.style.top = (sub ? sub.y : r.bottom + 2) + "px";
  return pop;
}

// ───────────────────────────── status bar ──────────────────────────────
type ModeKey = "manual" | "assist" | "auto";
const MODES: Record<ModeKey, { l: string; d: string }> = {
  manual: { l: "", d: "" }, assist: { l: "", d: "" }, auto: { l: "", d: "" },
};
let MODE: ModeKey = "manual";
function refreshModes(): void {
  (["manual", "assist", "auto"] as ModeKey[]).forEach((k) => { MODES[k].l = t("mode." + k); MODES[k].d = t("mode." + k + ".d"); });
}
function stMode(): void { const el = $("#st-mode"); if (el) el.textContent = MODES[MODE].l; }
function cycleMode(): void { const ks: ModeKey[] = ["manual", "assist", "auto"]; MODE = ks[(ks.indexOf(MODE) + 1) % 3]; stMode(); drawModebar(); try { localStorage.setItem("dxtutor.mode", MODE); } catch { /* */ } }
function setMode(k: ModeKey): void { MODE = k; stMode(); drawModebar(); try { localStorage.setItem("dxtutor.mode", MODE); } catch { /* */ } }
function stLang(): void { const el = $("#st-lang"); if (el) el.textContent = ""; }

function drawStatus(): void {
  const prob = $("#st-prob"); if (prob) prob.innerHTML = `<span style="color:var(--red)">✖ 0</span> <span style="color:var(--yellow)">⚠ 0</span>`;
  const tests = $("#st-tests"); if (tests) tests.textContent = "";
  const pos = $("#st-pos"); if (pos) pos.textContent = "";
  const ctx = $("#st-ctx"); if (ctx) ctx.textContent = "";
  const model = $("#st-model-l"); if (model) model.textContent = "Co-Dev";
  const branch = $("#st-branch-l"); if (branch) branch.textContent = "—";
  stMode(); stLang(); drawBell();
}

// ───────────────────────────── Co-Dev dock (chrome) ──────────────────────────────
function drawModebar(): void {
  const el = $("#modebar"); if (!el) return;
  el.innerHTML = `<div class="seg">${(["manual", "assist", "auto"] as ModeKey[]).map((k) => `<button data-mode="${k}" class="${k === MODE ? "on" : ""}">${esc(MODES[k].l)}</button>`).join("")}</div><div class="mode-d">${esc(MODES[MODE].d)}</div>`;
  el.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode as ModeKey)));
}
function drawAgentIntro(): void {
  const el = $("#ag-msgs"); if (!el) return;
  el.innerHTML = `<div class="intro"><div class="i-t">Co-Dev</div><div class="i-s">${esc(t("codev.intro"))}</div><div class="i-n">${esc(t("nyi.pane", { phase: 4 }))}</div></div>`;
}

// ───────────────────────────── views (Fase 1: welcome + settings reais) ──────────────────────────────
function openView(kind: ViewKind, titleKey: string): void {
  openTab({ id: kind, title: t(titleKey), kind });
}
function openSettings(): void { openTab({ id: "settings", title: t("view.settings"), kind: "settings" }); }

VIEW.welcome = (_tab, host) => {
  const w = (ic: string, a: string, b: string, run: () => void): string => {
    const id = "wb-" + Math.random().toString(36).slice(2);
    setTimeout(() => { const b2 = document.getElementById(id); if (b2) b2.onclick = run; }, 0);
    return `<button class="wbtn" id="${id}"><span class="wi">${svg(ic)}</span><span><b>${esc(a)}</b><small>${esc(b)}</small></span></button>`;
  };
  host.innerHTML = `<div class="page"><div style="display:flex;align-items:center;gap:14px;margin-bottom:8px"><div style="width:40px;height:40px;display:grid;place-items:center;background:var(--accent-grad);border-radius:11px;color:#fff;box-shadow:var(--sh-acc)">${svg("sparkle")}</div><h1 style="font-weight:300;font-size:26px;margin:0">dxtutor <b style="font-weight:600">IDE</b></h1></div>
    <div class="sub">${esc(t("welcome.sub"))}</div>
    <h2>${esc(t("welcome.learn"))}</h2><div class="wgrid">${w("book", t("welcome.lt"), t("welcome.ltSub"), () => goPane("tutor"))}${w("settings", t("welcome.changeLevel"), t("welcome.changeLevelSub"), () => goPane("tutor"))}</div>
    <h2>${esc(t("welcome.design"))}</h2><div class="wgrid">${w("cube", "1 · " + t("nav.studio"), t("welcome.studioSub"), () => openView("studio", "view.studio"))}${w("split", "2 · " + t("nav.board"), t("welcome.boardSub"), () => openView("board", "view.board"))}${w("account", "3 · " + t("menu.team"), t("welcome.teamSub"), () => openView("team", "view.team"))}${w("scm", "4 · " + t("menu.commitGraph"), t("welcome.graphSub"), () => openView("graph", "view.graph"))}${w("run", "5 · RUN", t("welcome.runSub"), () => nyiToast())}</div>
    <h2>Co-Dev</h2><div class="wgrid">${w("sparkle", t("welcome.mission"), t("welcome.missionSub"), () => goPane("codev"))}${w("graph", t("codev.manager"), t("welcome.managerSub"), () => openView("manager", "view.manager"))}${w("settings", t("welcome.models"), t("welcome.modelsSub"), () => openSettings())}${w("search", t("welcome.palette"), "Ctrl+Shift+P", () => palette(">"))}</div></div>`;
  hydrate(host);
};

VIEW.settings = (_tab, host) => {
  host.innerHTML = `<div class="page"><h1>${esc(t("view.settings"))}</h1>
    <div class="sub">${esc(t("settings.sub"))}</div>
    <h2>${esc(t("settings.language"))}</h2><div class="pgrid">${[["en", "English"], ["ptAO", "Português (Angola)"]].map(([code, label]) => `<button class="pcard${getLocale() === code ? " sel" : ""}" data-loc="${code}"><div class="ph">${esc(label)}${getLocale() === code ? '<span class="tag acc">✓</span>' : ""}</div></button>`).join("")}</div>
    <h2>${esc(t("settings.appearance"))}</h2><div class="pgrid">${Object.keys(THEMES).map((n) => `<button class="pcard${n === currentTheme() ? " sel" : ""}" data-theme="${esc(n)}"><div class="ph">${esc(n)}${n === currentTheme() ? '<span class="tag acc">activo</span>' : ""}</div></button>`).join("")}</div>
    <h2>${esc(t("settings.providers"))}</h2><div class="pcard" style="max-width:520px"><div class="ph">${svg("shield")} ${esc(t("nyi.badge"))}</div><div class="pd">${esc(t("nyi.page", { phase: 4 }))}</div></div>
    <h2>${esc(t("settings.shortcuts"))}</h2><div class="tbl-wrap">${CMD.filter((c) => c.key).map((c) => `<div class="rowline"><span>${esc(c.label)}</span><span class="sp"></span><kbd>${esc(c.key!)}</kbd></div>`).join("")}</div></div>`;
  host.querySelectorAll<HTMLElement>("[data-theme]").forEach((b) => (b.onclick = () => { setTheme(b.dataset.theme!); show("settings"); }));
  host.querySelectorAll<HTMLElement>("[data-loc]").forEach((b) => (b.onclick = () => setLocale(b.dataset.loc as Locale)));
  hydrate(host);
};

// ───────────────────────────── pane renderers (Fase 1: placeholders honestos) ──────────────────────────────
RP.explorer = () => nyiPane("pane-explorer", "nav.explorer", 2);
RP.search = () => nyiPane("pane-search", "nav.search", 2);
RP.scm = () => nyiPane("pane-scm", "nav.scm", 2);
RP.run = () => nyiPane("pane-run", "nav.run", 2);
RP.test = () => nyiPane("pane-test", "nav.test", 2);
RP.ext = () => nyiPane("pane-ext", "nav.ext", 2);
RP.codev = () => nyiPane("pane-codev", "nav.codev", 4);
RP.tutor = () => nyiPane("pane-tutor", "nav.tutor", 3);
RP.remote = () => nyiPane("pane-remote", "nav.remote", 2);
RP.containers = () => nyiPane("pane-containers", "nav.containers", 2);
RP.account = () => nyiPane("pane-account", "nav.account", 5);

// ───────────────────────────── keyboard ──────────────────────────────
function installKeys(): void {
  document.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey, go = (f: () => void) => { e.preventDefault(); f(); };
    if (e.key === "Escape") { if ($("#pal")?.classList.contains("show")) closePal(); closeMenus(); $("#notes")?.classList.remove("show"); return; }
    if (e.key === "F1" || (c && e.shiftKey && k === "p")) go(() => palette(">"));
    else if (e.key === "F8") go(() => nyiToast(t("status.problems")));
    else if (c && e.shiftKey) { if (k === "e") go(() => goPane("explorer")); else if (k === "f") go(() => goPane("search")); else if (k === "g") go(() => goPane("scm")); else if (k === "m") go(() => setPanelTab("problems")); else if (k === "a") go(() => goPane("codev")); }
    else if (c) { if (k === "p") go(() => palette("")); else if (k === "b") go(toggleSide); else if (k === "j") go(togglePanel); else if (k === "`") go(() => setPanelTab("terminal")); else if (k === ",") go(openSettings); else if (k === "l") go(focusAgent); else if (k === "g") go(() => palette(":")); else if (k === "s") go(() => toast(t("toast.autosave"))); }
  }, true);
}

// ───────────────────────────── wiring de elementos estáticos ──────────────────────────────
function wireStatic(): void {
  const on = (sel: string, fn: () => void) => { const el = $(sel); if (el) el.onclick = fn; };
  on("#cmd-center", () => palette(""));
  on("#tgl-side", toggleSide);
  on("#tgl-panel", togglePanel);
  on("#tgl-agent", toggleAgent);
  on("#tb-account", () => goPane("account"));
  on("#pt-clear", termClear);
  on("#pt-close", togglePanel);
  on("#ag-model", () => nyiToast(t("codev.pickModel")));
  on("#ag-popout", () => nyiToast());
  on("#ag-history", () => openView("manager", "view.manager"));
  on("#ag-new", () => nyiToast());
  on("#ag-send", () => nyiToast());
  on("#pill-ctx", () => nyiToast());
  on("#pill-test", () => nyiToast());
  on("#pill-lint", () => nyiToast());
  on("#st-remote", () => palette(">"));
  on("#st-branch", () => nyiToast(t("status.switchBranch")));
  on("#st-prob", () => setPanelTab("problems"));
  on("#st-tests", () => goPane("test"));
  on("#st-pos", () => palette(":"));
  on("#st-ctx", () => openView("manager", "view.manager"));
  on("#st-model", () => nyiToast(t("status.model")));
  on("#st-mode", cycleMode);
  on("#st-bell", toggleNotes);
  // Painel inferior
  $$(".ptab").forEach((b) => (b.onclick = () => setPanelTab(b.dataset.pt!)));
  // Paleta
  const pi = $<HTMLInputElement>("#pal-in");
  if (pi) {
    pi.oninput = () => { PIDX = 0; palDraw(); };
    pi.onkeydown = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); PIDX = Math.min(PITEMS.length - 1, PIDX + 1); palDraw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); PIDX = Math.max(0, PIDX - 1); palDraw(); }
      else if (e.key === "Enter") { e.preventDefault(); palRun(PIDX); }
    };
  }
  const pal = $("#pal");
  if (pal) pal.onclick = (e) => { const it = (e.target as HTMLElement).closest(".pi") as HTMLElement | null; if (it) palRun(+it.dataset.i!); else if (!(e.target as HTMLElement).closest(".pal-box")) closePal(); };
  document.addEventListener("click", () => closeMenus());
  // Co-Dev compose: Enter envia (Fase 4 liga o backend)
  const ai = $<HTMLTextAreaElement>("#ag-input");
  if (ai) ai.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); nyiToast(); } };
}

// ───────────────────────────── boot ──────────────────────────────
/** Reconstrói todo o chrome localizável. Chamado no arranque e a cada troca de locale. */
export function rebuildChrome(): void {
  refreshModes();
  buildMenus(); buildMenubar();
  buildCmds();
  ACTS = [
    { ic: "explorer", pane: "explorer", title: t("nav.explorer") },
    { ic: "search", pane: "search", title: t("nav.search") },
    { ic: "scm", pane: "scm", title: t("nav.scm") },
    { ic: "run", pane: "run", title: t("nav.run") },
    { ic: "test", pane: "test", title: t("nav.test") },
    { ic: "ext", pane: "ext", title: t("nav.ext") },
    { ic: "sparkle", pane: "codev", title: t("nav.codev"), acc: true, sep: true },
    { ic: "book", pane: "tutor", title: t("nav.tutor") },
    { ic: "cube", run: () => openView("studio", "view.studio"), title: t("nav.studio") },
    { ic: "split", run: () => openView("board", "view.board"), title: t("nav.board") },
    { ic: "dots", overflow: true, title: t("nav.more"), spacer: true },
    { ic: "account", pane: "account", title: t("nav.account") },
    { ic: "settings", pane: "settings", title: t("nav.settings") },
  ];
  OVERFLOW.length = 0;
  OVERFLOW.push({ l: t("nav.remote"), pane: "remote" }, { l: t("nav.containers"), pane: "containers" });
  buildActivity();
  $$(".act").forEach((a) => a.classList.toggle("on", a.dataset.pane === PANE));
  drawModebar(); drawAgentIntro(); drawStatus(); termClear();
  if (RP[PANE]) RP[PANE](); // pinta o pane visível (ex.: placeholder do explorer)
  if (cur) show(cur);
  hydrate();
}

export function bootShell(): void {
  const brand = $("#brand"); if (brand) brand.innerHTML = svg("sparkle");
  try { const m = localStorage.getItem("dxtutor.mode"); if (m === "manual" || m === "assist" || m === "auto") MODE = m; } catch { /* */ }
  mkRz($("#rsz-side"), "--side-w", 250, 170, 460);
  mkRz($("#rsz-agent"), "--agent-w", 380, 300, 640, true);
  installKeys();
  wireStatic();
  rebuildChrome();
  tick(); setInterval(tick, 1000);
  TB = [{ id: "welcome", title: t("view.welcome"), kind: "welcome" }];
  show("welcome");
  if (innerWidth < 1000) setVar("--side-w", "0px"); else $("#tgl-side")?.classList.add("on");
  $("#tgl-panel")?.classList.add("on");
  note(t("notes.ready"));
  hydrate();
}
