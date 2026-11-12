// dxtutor desktop — tiny, dependency-free i18n for the UI CHROME.
//
// Scope: this translates the SHELL the user sees (menus, panels, buttons,
// onboarding, settings, status bar, overlays). It deliberately does NOT touch
// the COURSE CONTENT (exercises, glossary entries, briefings) — that prose comes
// from the backend in the language of the course and stays in that language.
//
// Design:
//   • `t(key, params?)`  → looks up the active locale, falls back to English,
//     finally to the raw key; `{name}` placeholders are interpolated.
//   • `getLocale()` / `setLocale(locale)` persist to localStorage ("dxtutor.locale",
//     default "en") and fire change listeners so visible views re-render live.
//   • `applyI18n(root?)` walks `[data-i18n*]` elements and re-applies text /
//     attributes, so static markup needs no per-string JS.
//   • `onLocaleChange(cb)` lets the controller re-render JS-built strings
//     (status bar, sandbox label, onboarding cards) when the locale flips.

export type Locale = "en" | "ptAO";

const LS_LOCALE = "dxtutor.locale";
export const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "ptAO", label: "Português (Angola)" },
];

// English is the source of truth and must stay complete; any pt-AO gap falls
// back to the English string (never a bare key).
const en: Record<string, string> = {
  // Boot splash
  "boot.subtitle": "Loading your workspace…",

  // Menu bar
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.view": "View",
  "menu.run": "Run",
  "menu.help": "Help",
  "menu.newFile": "New File",
  "menu.openFolder": "Open Folder…",
  "menu.save": "Save",
  "menu.saveAll": "Save All",
  "menu.runFile": "Run File",

  // Activity bar (tooltips)
  "act.learning": "Learning track",
  "act.explorer": "Explorer — open a real project",
  "act.run": "Run and Submit",
  "act.debug": "Run and Debug — step through a real trace",
  "act.hint": "Hints",
  "act.glossary": "Glossary — reserved words",
  "act.underhood": "Under the hood — what the machine really does",
  "act.visualize": "Visualize execution — run a program step by step",
  "act.settings": "Change course / reset profile",

  // Learning sidebar
  "sidebar.learningTrack": "Learning Track",
  "sidebar.resetProfile": "Change course / reset profile",
  "sidebar.collapse": "Collapse / expand the track",
  "common.loading": "Loading…",

  // Workspace / Explorer sidebar
  "ws.explorer": "Explorer",
  "ws.newFile": "New File",
  "ws.newFolder": "New Folder",
  "ws.refresh": "Refresh",
  "ws.openFolder": "Open Folder",
  "ws.noFolder": "NO FOLDER OPENED",
  "ws.rootHint": "Open a folder to start a real project",
  "ws.emptyText": "Build a real project with what you have learned.",
  "ws.save": "Save",
  "ws.saveTitle": "Save (Ctrl+S)",
  "ws.saveAll": "Save All",
  "ws.saveAllTitle": "Save all modified files",
  "ws.run": "Run",
  "ws.runTitle": "Run the active file",
  "ws.welcomeTitle": "Workspace",
  "ws.welcomeText": "Open a folder and build a real project with the skills from your Learning track.",
  "ws.cloneRepo": "Clone Repository",
  "ws.clone": "Clone",
  "ws.workspaces": "Workspaces",
  "ws.noRecents": "No recent folders yet.",

  // Editor topbar
  "btn.underhood": "Under the hood",
  "btn.underhood.title":
    "Under the hood — real, measured CPU / memory / I/O for this code, plus the compiler pipeline",
  "btn.run": "Run / Submit",
  "btn.run.title": "Run / Submit (Ctrl+Enter)",
  "btn.hint": "Hint",
  "btn.hint.title": "Request a hint (F1)",
  "btn.continue": "Continue",
  "btn.continue.title": "Continue (Ctrl+Enter)",
  "btn.start": "Start",
  "btn.start.title": "Start the exercise (Ctrl+Enter)",
  "btn.next": "Next",
  "btn.next.title": "Next step (Ctrl+Enter)",
  "btn.showPlaceholder": "Show placeholder",
  "btn.hidePlaceholder": "Hide placeholder",

  // Panels
  "panel.terminal": "Terminal",
  "panel.closeTerminal": "Close panel (Ctrl+`)",
  "panel.results": "Results",
  "panel.output": "Output",
  "panel.hideOutput": "Hide output",
  "results.empty": "Your guided track appears here. Correctness is decided by the hidden tests — never by AI.",

  // Status bar
  "status.points": "★ {points} pts",
  "status.pointsTitle": "Points earned on this track",
  "status.sandboxTitle": "Your code runs inside a Delonix container. Click to change the sandbox engine.",
  "status.honesty": "Tests decide correctness",
  "status.honestyTitle": "Correctness is decided by the hidden tests, never by AI.",
  "status.allLevels": "All levels",

  // Onboarding
  "onb.language.title": "What do you want to learn?",
  "onb.language.sub": "Pick a language and we'll guide you through a hands-on track, one step at a time.",
  "onb.level.title": "What's your level?",
  "onb.level.sub":
    "Pick one or more. Your track loads only the levels you choose — mix Basic and Intermediate, go straight to Advanced, or take all three. You can change this later from the ⚙ gear icon.",
  "onb.back": "← Back",
  "onb.start": "Start →",
  "onb.available": "Available",
  "onb.comingSoon": "Coming soon",
  "onb.fallbackNote":
    "Showing a minimal offline set — the full language catalogue loads inside the Delonix Tutor app.",

  // Levels
  "level.basic": "Basic",
  "level.intermediate": "Intermediate",
  "level.advanced": "Advanced",
  "level.basic.blurb": "Start from the ground up — syntax and first programs.",
  "level.intermediate.blurb": "Build on the basics with real-world patterns.",
  "level.advanced.blurb": "Deep dives, performance and the tricky corners.",

  // Settings overlay
  "settings.title": "Settings",
  "common.close": "Close (Esc)",
  "settings.sandbox.h": "Sandbox engine",
  "settings.sandbox.note":
    "Your code runs in an isolated sandbox. Pick the engine that executes it. The first run on a container engine can be slower (it starts the engine and pulls the image/packages); Host is the fastest but the least isolated.",
  "settings.sandbox.appnote":
    "Sandbox selection applies only inside the Delonix Tutor app. Run <code>npm run tauri dev</code> to execute code.",
  "settings.sandbox.default": "default",
  "sandbox.delonix.desc": "runs your code in a Delonix container — the engine that powers Delonix",
  "sandbox.docker.desc": "runs your code in a Docker container",
  "sandbox.podman.desc": "runs your code in a Podman container (rootless, daemonless)",
  "sandbox.host.name": "Host (direct)",
  "sandbox.host.desc": "runs on this machine without a container — fastest, less isolated",
  "settings.course.h": "Course",
  "settings.course.note":
    "Start over with a different language or level. This clears your saved profile, points and progress on this device.",
  "settings.reset": "Change course / reset profile",
  "settings.language.h": "Language / Idioma",
  "settings.language.note":
    "Choose the language of the app's interface. Course content (exercises, glossary and guides) stays in the language of the course.",

  // Sandbox status-bar labels
  "sandbox.label.delonix": "⬡ Delonix sandbox",
  "sandbox.label.docker": "⬡ Docker sandbox",
  "sandbox.label.podman": "⬡ Podman sandbox",
  "sandbox.label.host": "⌂ Host (direct)",
  "sandbox.tip.delonix":
    "Your code runs inside a Delonix container — the engine that powers Delonix. The first run can be slower (engine start + image/package pull). Click to change.",
  "sandbox.tip.docker":
    "Your code runs inside a Docker container. The first run can be slower (image/package pull). Click to change.",
  "sandbox.tip.podman":
    "Your code runs inside a Podman container. The first run can be slower (image/package pull). Click to change.",
  "sandbox.tip.host":
    "Your code runs directly on this machine — no container: fastest, less isolated. Click to change.",

  // Glossary overlay
  "gloss.title": "Glossary",
  "gloss.sub": "reserved words",
  "gloss.filter": "Filter keywords…",

  // Study-guide overlay
  "study.title": "Study guide",

  // Under-the-hood overlay
  "uh.title": "Under the hood",
  "uh.sub": "real & measured",
  "uh.remeasure": "Re-measure",
  "uh.remeasureTitle": "Compile and measure the current code again",

  // Visualize overlay
  "viz.title": "Visualize execution",
  "viz.sub": "step by step",
  "viz.run": "Visualize",
  "viz.runTitle": "Run this program step by step",
  "viz.back": "Step back",
  "viz.play": "Play",
  "viz.pause": "Pause",
  "viz.playTitle": "Play / Pause",
  "viz.fwd": "Step",
  "viz.fwdTitle": "Step forward",
  "viz.backTitle": "Step back",
  "viz.speed": "Speed",
  "viz.speedTitle": "Playback speed",
  "viz.variables": "Variables",
  "viz.callstack": "Call stack",
  "viz.output": "Output",
  "viz.stdoutSoFar": "stdout so far",

  // Run and Debug overlay
  "dbg.title": "Run and Debug",
  "dbg.sub": "real trace",
  "dbg.start": "Start Debugging",
  "dbg.startTitle": "Start Debugging (F5)",
  "dbg.continue": "Continue",
  "dbg.continueTitle": "Continue to next breakpoint (F5)",
  "dbg.stepover": "Step Over",
  "dbg.stepoverTitle": "Step Over (F10)",
  "dbg.stepinto": "Step Into",
  "dbg.stepintoTitle": "Step Into (F11)",
  "dbg.stepback": "Step Back",
  "dbg.stepbackTitle": "Step Back (Shift+F11)",
  "dbg.stop": "Stop",
  "dbg.stopTitle": "Stop (Shift+F5)",
  "dbg.variables": "Variables",
  "dbg.callstack": "Call Stack",
  "dbg.breakpoints": "Breakpoints",
  "dbg.console": "Debug Console",
  "dbg.stdoutSoFar": "stdout so far",
};

// Portuguese (Angola), pré-AO90 spelling (acção, correcção, óptimo, directo).
const ptAO: Record<string, string> = {
  "boot.subtitle": "A carregar o seu espaço de trabalho…",

  "menu.file": "Ficheiro",
  "menu.edit": "Editar",
  "menu.view": "Ver",
  "menu.run": "Correr",
  "menu.help": "Ajuda",
  "menu.newFile": "Novo ficheiro",
  "menu.openFolder": "Abrir pasta…",
  "menu.save": "Guardar",
  "menu.saveAll": "Guardar tudo",
  "menu.runFile": "Correr ficheiro",

  "act.learning": "Percurso de aprendizagem",
  "act.explorer": "Explorador — abrir um projecto real",
  "act.run": "Correr e submeter",
  "act.debug": "Correr e depurar — percorrer um traço real",
  "act.hint": "Dicas",
  "act.glossary": "Glossário — palavras reservadas",
  "act.underhood": "Nos bastidores — o que a máquina faz de facto",
  "act.visualize": "Visualizar execução — correr um programa passo a passo",
  "act.settings": "Mudar de curso / repor perfil",

  "sidebar.learningTrack": "Percurso de aprendizagem",
  "sidebar.resetProfile": "Mudar de curso / repor perfil",
  "sidebar.collapse": "Colapsar / expandir o percurso",
  "common.loading": "A carregar…",

  "ws.explorer": "Explorador",
  "ws.newFile": "Novo ficheiro",
  "ws.newFolder": "Nova pasta",
  "ws.refresh": "Actualizar",
  "ws.openFolder": "Abrir pasta",
  "ws.noFolder": "NENHUMA PASTA ABERTA",
  "ws.rootHint": "Abre uma pasta para começar um projecto real",
  "ws.emptyText": "Constrói um projecto real com o que aprendeste.",
  "ws.save": "Guardar",
  "ws.saveTitle": "Guardar (Ctrl+S)",
  "ws.saveAll": "Guardar tudo",
  "ws.saveAllTitle": "Guardar todos os ficheiros modificados",
  "ws.run": "Correr",
  "ws.runTitle": "Correr o ficheiro activo",
  "ws.welcomeTitle": "Espaço de trabalho",
  "ws.welcomeText":
    "Abre uma pasta e constrói um projecto real com as competências do teu percurso de aprendizagem.",
  "ws.cloneRepo": "Clonar repositório",
  "ws.clone": "Clonar",
  "ws.workspaces": "Espaços de trabalho",
  "ws.noRecents": "Ainda não há pastas recentes.",

  "btn.underhood": "Nos bastidores",
  "btn.underhood.title":
    "Nos bastidores — CPU / memória / E/S reais e medidos para este código, mais o pipeline do compilador",
  "btn.run": "Correr / Submeter",
  "btn.run.title": "Correr / Submeter (Ctrl+Enter)",
  "btn.hint": "Dica",
  "btn.hint.title": "Pedir uma dica (F1)",
  "btn.continue": "Continuar",
  "btn.continue.title": "Continuar (Ctrl+Enter)",
  "btn.start": "Começar",
  "btn.start.title": "Começar o exercício (Ctrl+Enter)",
  "btn.next": "Seguinte",
  "btn.next.title": "Passo seguinte (Ctrl+Enter)",
  "btn.showPlaceholder": "Mostrar modelo",
  "btn.hidePlaceholder": "Ocultar modelo",

  "panel.terminal": "Terminal",
  "panel.closeTerminal": "Fechar painel (Ctrl+`)",
  "panel.results": "Resultados",
  "panel.output": "Saída",
  "panel.hideOutput": "Ocultar saída",
  "results.empty":
    "O teu percurso guiado aparece aqui. A correcção é decidida pelos testes ocultos — nunca pela IA.",

  "status.points": "★ {points} pts",
  "status.pointsTitle": "Pontos ganhos neste percurso",
  "status.sandboxTitle":
    "O teu código corre dentro de um contentor Delonix. Clica para mudar o motor de isolamento.",
  "status.honesty": "Os testes decidem a correcção",
  "status.honestyTitle": "A correcção é decidida pelos testes ocultos, nunca pela IA.",
  "status.allLevels": "Todos os níveis",

  "onb.language.title": "O que queres aprender?",
  "onb.language.sub":
    "Escolhe uma linguagem e guiamos-te por um percurso prático, um passo de cada vez.",
  "onb.level.title": "Qual é o teu nível?",
  "onb.level.sub":
    "Escolhe um ou mais. O teu percurso carrega apenas os níveis que escolheres — mistura Básico e Intermédio, vai directo ao Avançado, ou leva os três. Podes mudar isto depois no ícone de engrenagem ⚙.",
  "onb.back": "← Voltar",
  "onb.start": "Começar →",
  "onb.available": "Disponível",
  "onb.comingSoon": "Em breve",
  "onb.fallbackNote":
    "A mostrar um conjunto mínimo offline — o catálogo completo de linguagens carrega dentro da app Delonix Tutor.",

  "level.basic": "Básico",
  "level.intermediate": "Intermédio",
  "level.advanced": "Avançado",
  "level.basic.blurb": "Começa do zero — sintaxe e primeiros programas.",
  "level.intermediate.blurb": "Assenta nos fundamentos com padrões do mundo real.",
  "level.advanced.blurb": "Mergulhos profundos, desempenho e os cantos complicados.",

  "settings.title": "Definições",
  "common.close": "Fechar (Esc)",
  "settings.sandbox.h": "Motor de isolamento",
  "settings.sandbox.note":
    "O teu código corre num isolamento (sandbox). Escolhe o motor que o executa. A primeira execução num motor de contentores pode ser mais lenta (arranca o motor e puxa a imagem/pacotes); o Host é o mais rápido mas o menos isolado.",
  "settings.sandbox.appnote":
    "A escolha de isolamento aplica-se apenas dentro da app Delonix Tutor. Corre npm run tauri dev para executar código.",
  "settings.sandbox.default": "por omissão",
  "sandbox.delonix.desc": "corre o teu código num contentor Delonix — o motor que move o Delonix",
  "sandbox.docker.desc": "corre o teu código num contentor Docker",
  "sandbox.podman.desc": "corre o teu código num contentor Podman (rootless, sem daemon)",
  "sandbox.host.name": "Host (directo)",
  "sandbox.host.desc": "corre nesta máquina sem contentor — o mais rápido, menos isolado",
  "settings.course.h": "Curso",
  "settings.course.note":
    "Recomeça com outra linguagem ou nível. Isto limpa o teu perfil guardado, os pontos e o progresso neste dispositivo.",
  "settings.reset": "Mudar de curso / repor perfil",
  "settings.language.h": "Language / Idioma",
  "settings.language.note":
    "Escolhe o idioma da interface da app. O conteúdo do curso (exercícios, glossário e guias) permanece na língua do curso.",

  "sandbox.label.delonix": "⬡ Isolamento Delonix",
  "sandbox.label.docker": "⬡ Isolamento Docker",
  "sandbox.label.podman": "⬡ Isolamento Podman",
  "sandbox.label.host": "⌂ Host (directo)",
  "sandbox.tip.delonix":
    "O teu código corre dentro de um contentor Delonix — o motor que move o Delonix. A primeira execução pode ser mais lenta (arranque do motor + puxar imagem/pacotes). Clica para mudar.",
  "sandbox.tip.docker":
    "O teu código corre dentro de um contentor Docker. A primeira execução pode ser mais lenta (puxar imagem/pacotes). Clica para mudar.",
  "sandbox.tip.podman":
    "O teu código corre dentro de um contentor Podman. A primeira execução pode ser mais lenta (puxar imagem/pacotes). Clica para mudar.",
  "sandbox.tip.host":
    "O teu código corre directamente nesta máquina — sem contentor: o mais rápido, menos isolado. Clica para mudar.",

  "gloss.title": "Glossário",
  "gloss.sub": "palavras reservadas",
  "gloss.filter": "Filtrar palavras-chave…",

  "study.title": "Guia de estudo",

  "uh.title": "Nos bastidores",
  "uh.sub": "real e medido",
  "uh.remeasure": "Remedir",
  "uh.remeasureTitle": "Compilar e medir novamente o código actual",

  "viz.title": "Visualizar execução",
  "viz.sub": "passo a passo",
  "viz.run": "Visualizar",
  "viz.runTitle": "Correr este programa passo a passo",
  "viz.back": "Recuar",
  "viz.play": "Reproduzir",
  "viz.pause": "Pausar",
  "viz.playTitle": "Reproduzir / Pausar",
  "viz.fwd": "Avançar",
  "viz.fwdTitle": "Avançar um passo",
  "viz.backTitle": "Recuar um passo",
  "viz.speed": "Velocidade",
  "viz.speedTitle": "Velocidade de reprodução",
  "viz.variables": "Variáveis",
  "viz.callstack": "Pilha de chamadas",
  "viz.output": "Saída",
  "viz.stdoutSoFar": "stdout até agora",

  "dbg.title": "Correr e depurar",
  "dbg.sub": "traço real",
  "dbg.start": "Iniciar depuração",
  "dbg.startTitle": "Iniciar depuração (F5)",
  "dbg.continue": "Continuar",
  "dbg.continueTitle": "Continuar até ao próximo ponto de paragem (F5)",
  "dbg.stepover": "Passar por cima",
  "dbg.stepoverTitle": "Passar por cima (F10)",
  "dbg.stepinto": "Entrar",
  "dbg.stepintoTitle": "Entrar (F11)",
  "dbg.stepback": "Recuar",
  "dbg.stepbackTitle": "Recuar (Shift+F11)",
  "dbg.stop": "Parar",
  "dbg.stopTitle": "Parar (Shift+F5)",
  "dbg.variables": "Variáveis",
  "dbg.callstack": "Pilha de chamadas",
  "dbg.breakpoints": "Pontos de paragem",
  "dbg.console": "Consola de depuração",
  "dbg.stdoutSoFar": "stdout até agora",
};

const DICTS: Record<Locale, Record<string, string>> = { en, ptAO };

function isLocale(v: unknown): v is Locale {
  return v === "en" || v === "ptAO";
}

let current: Locale = (() => {
  try {
    const v = localStorage.getItem(LS_LOCALE);
    return isLocale(v) ? v : "en";
  } catch {
    return "en";
  }
})();

export function getLocale(): Locale {
  return current;
}

const listeners = new Set<(locale: Locale) => void>();

export function onLocaleChange(cb: (locale: Locale) => void): void {
  listeners.add(cb);
}

export function setLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === current) return;
  current = locale;
  try {
    localStorage.setItem(LS_LOCALE, locale);
  } catch {
    /* storage may be unavailable; keep the in-memory choice */
  }
  document.documentElement.setAttribute("lang", locale === "ptAO" ? "pt" : "en");
  applyI18n();
  for (const cb of listeners) cb(locale);
}

// Translate `key` for the active locale with `{name}` interpolation. Falls back
// to English, then to the raw key, so a missing pt-AO string is never a blank.
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = DICTS[current][key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

// Walk a subtree and (re)apply every data-i18n* binding. Static markup carries
// the keys, so there is no per-element wiring in the controller.
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.dataset.i18nTitle!));
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder!));
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria!));
  });
}

// Set <html lang> and paint the initial strings. Called once at boot.
export function initI18n(): void {
  document.documentElement.setAttribute("lang", current === "ptAO" ? "pt" : "en");
  applyI18n();
}
