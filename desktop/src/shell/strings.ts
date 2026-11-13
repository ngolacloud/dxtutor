// shell/strings.ts — strings da casca (Fase 1), em en (canónico) e ptAO (tradução).
//
// Registadas em i18n.ts via registerStrings() no arranque. Namespace `nav.*` para
// os rótulos da activity bar/panes/vistas (evita colisão com `act.*` da UI antiga).
// Regra: todo o texto novo da UI entra aqui, nunca hardcoded num componente.

export const SHELL_STRINGS: { en: Record<string, string>; ptAO: Record<string, string> } = {
  en: {
    "shell.cmdCenter": "dxtutor — files and commands",
    "shell.toggleSide": "Toggle sidebar (Ctrl+B)",
    "shell.togglePanel": "Toggle panel (Ctrl+J)",
    "shell.toggleAgent": "Co-Dev panel",
    "shell.additionalViews": "Additional Views",

    "nav.explorer": "Explorer", "nav.search": "Search", "nav.scm": "Source Control",
    "nav.run": "Run and Debug", "nav.test": "Testing", "nav.ext": "Extensions",
    "nav.codev": "Co-Dev", "nav.tutor": "Learning Track", "nav.studio": "Architecture Studio",
    "nav.board": "Board", "nav.more": "More views…", "nav.account": "Account",
    "nav.settings": "Settings", "nav.remote": "Remote Explorer", "nav.containers": "Containers",

    "panel.clear": "Clear terminal", "panel.close": "Close panel",
    "panel.terminal": "Terminal", "panel.problems": "Problems",

    "codev.pickModel": "Choose model", "codev.popout": "Open in center",
    "codev.manager": "Mission manager", "codev.newChat": "New conversation",
    "codev.placeholder": "Describe what you want to build, fix or review…",
    "codev.ctx": "Include the active file as context", "codev.runTests": "Run the tests",
    "codev.lint": "Design System lint", "codev.send": "Send",
    "codev.focus": "Focus the conversation",
    "codev.intro": "Describe a goal and Co-Dev plans, edits, runs tests and self-evaluates before delivering.",

    "status.commands": "Commands", "status.switchBranch": "Switch branch",
    "status.problems": "Problems", "status.tests": "Tests", "status.goToLine": "Go to line",
    "status.context": "Context used in the conversation", "status.model": "Conversation model",
    "status.mode": "Toggle autonomy mode", "status.notifications": "Notifications",

    "nyi.toast": "not implemented yet",
    "nyi.page": "This surface belongs to phase {phase} of the UI rewrite — visible but not wired to the backend yet.",
    "nyi.pane": "Not implemented yet (phase {phase}).",
    "nyi.badge": "Not implemented yet",
    "nyi.explain": "Nothing is simulated here: the shell is in place and this view is wired to the real backend in a later phase. See docs/ui-rewrite/PENDING.md.",

    "notes.empty": "No notifications.", "notes.ready": "dxtutor IDE shell ready",

    "empty.goToFile": "go to file", "empty.commands": "commands",
    "empty.codev": "talk to Co-Dev", "empty.terminal": "terminal",

    "term.placeholder": "Terminal — connected in phase 2 (real PTY).",

    "cmd.goToFile": "Go to file…", "cmd.allCommands": "Show all commands",
    "cmd.goToLine": "Go to line…", "cmd.nextProblem": "Go to next problem",
    "cmd.explorer": "View: Explorer", "cmd.search": "View: Search", "cmd.scm": "View: Source Control",
    "cmd.run": "View: Run and Debug", "cmd.testing": "View: Testing", "cmd.extensions": "View: Extensions",
    "cmd.toggleSide": "View: Toggle sidebar", "cmd.togglePanel": "View: Toggle panel",
    "cmd.terminal": "View: Terminal", "cmd.problems": "View: Problems",
    "cmd.codevFocus": "Co-Dev: Focus the conversation", "cmd.codevPanel": "Co-Dev: Knowledge panel",
    "cmd.learningTrack": "Learning Track: Continue", "cmd.studio": "Project: Architecture Studio",
    "cmd.board": "Project: Board (kanban)", "cmd.commitGraph": "Git: Commit graph",
    "cmd.team": "Team: Assistants and harness", "cmd.manager": "Co-Dev: Mission manager",
    "cmd.welcome": "Help: Welcome", "cmd.settings": "Preferences: Settings",
    "cmd.theme": "Preferences: Theme", "cmd.lang": "Preferences: Language",

    "palette.placeholder": "File name  ·  > commands  ·  : line",
    "palette.gotoLine": "Go to line {n}", "palette.openFolderFirst": "Open a folder first (phase 2)",
    "palette.noResults": "No results.",

    "menu.file": "File", "menu.newFile": "New file…", "menu.newFolder": "New folder…",
    "menu.openFile": "Open file…", "menu.openFolder": "Open folder…", "menu.save": "Save",
    "menu.preferences": "Preferences", "menu.settings": "Settings", "menu.theme": "Theme",
    "menu.language": "Language", "menu.closeTab": "Close tab",
    "menu.edit": "Edit", "menu.undo": "Undo", "menu.redo": "Redo", "menu.findInFiles": "Find in files",
    "menu.selection": "Selection", "menu.selectAll": "Select all", "menu.sendToCodev": "Send selection to Co-Dev",
    "menu.view": "View", "menu.commandPalette": "Command palette…", "menu.sidebar": "Sidebar",
    "menu.panel": "Bottom panel", "menu.codevPanel": "Co-Dev panel",
    "menu.go": "Go", "menu.goToFile": "Go to file…", "menu.goToLine": "Go to line…",
    "menu.nextProblem": "Next problem", "menu.nextTab": "Next tab", "menu.prevTab": "Previous tab",
    "menu.run": "Run", "menu.runStack": "▶ RUN the whole stack", "menu.stopStack": "Stop the stack",
    "menu.project": "Project", "menu.team": "Team and harness", "menu.commitGraph": "Commit graph",
    "menu.codev": "Co-Dev", "menu.terminal": "Terminal", "menu.showTerminal": "Show terminal",
    "menu.help": "Help", "menu.welcome": "Welcome", "menu.about": "About",

    "mode.manual": "Manual", "mode.manual.d": "You approve every edit and command before it runs.",
    "mode.assist": "Assisted", "mode.assist.d": "Edits apply automatically with a diff; destructive actions still ask.",
    "mode.auto": "Auto", "mode.auto.d": "Co-Dev chains steps automatically; push and destructive actions always ask.",

    "view.welcome": "Welcome", "view.settings": "Settings", "view.studio": "Studio",
    "view.board": "Board", "view.graph": "Commit graph", "view.team": "Team",
    "view.manager": "Mission manager", "view.file": "File", "view.diff": "Diff",
    "view.analysis": "Analysis", "view.learn": "Lesson", "view.lt": "Step", "view.agent": "Co-Dev",

    "settings.sub": "Stored in this app. Real keys and endpoints live in the OS keychain.",
    "settings.language": "Language", "settings.appearance": "Appearance",
    "settings.providers": "Models and providers", "settings.shortcuts": "Keyboard shortcuts",

    "welcome.sub": "Learn a language step by step, or design an architecture and let a team of assistants build it: backlog, branches, tests, containers — then run everything with one command.",
    "welcome.learn": "Learn", "welcome.lt": "Learning Track", "welcome.ltSub": "Rust and Go, from zero to confident",
    "welcome.changeLevel": "Change language or level", "welcome.changeLevelSub": "Basic, Intermediate, Advanced",
    "welcome.design": "From design to a running stack",
    "welcome.studioSub": "Design with AWS, Azure, GCP and open-source components",
    "welcome.boardSub": "Sprints, issues and automatic tests",
    "welcome.teamSub": "Assistants, harness and model router",
    "welcome.graphSub": "Branches, merges and gitflow", "welcome.runSub": "Build and start every service",
    "welcome.mission": "Mission: persistent chat history", "welcome.missionSub": "Council, self-evaluation and correction",
    "welcome.managerSub": "Decisions, checkpoints and usage",
    "welcome.models": "Models and autonomy", "welcome.modelsSub": "Providers, routing, modes, language",
    "welcome.palette": "Command palette",

    "toast.autosave": "Auto Save is on — already saved",
  },
  ptAO: {
    "shell.cmdCenter": "dxtutor — ficheiros e comandos",
    "shell.toggleSide": "Alternar barra lateral (Ctrl+B)",
    "shell.togglePanel": "Alternar painel (Ctrl+J)",
    "shell.toggleAgent": "Painel do Co-Dev",
    "shell.additionalViews": "Vistas adicionais",

    "nav.explorer": "Explorador", "nav.search": "Pesquisa", "nav.scm": "Controlo de versões",
    "nav.run": "Correr e depurar", "nav.test": "Testes", "nav.ext": "Extensões",
    "nav.codev": "Co-Dev", "nav.tutor": "Percurso de aprendizagem", "nav.studio": "Studio de arquitectura",
    "nav.board": "Quadro", "nav.more": "Mais vistas…", "nav.account": "Conta",
    "nav.settings": "Definições", "nav.remote": "Explorador remoto", "nav.containers": "Contentores",

    "panel.clear": "Limpar terminal", "panel.close": "Fechar painel",
    "panel.terminal": "Terminal", "panel.problems": "Problemas",

    "codev.pickModel": "Escolher modelo", "codev.popout": "Abrir no centro",
    "codev.manager": "Gestor de missões", "codev.newChat": "Nova conversa",
    "codev.placeholder": "Descreve o que queres construir, corrigir ou rever…",
    "codev.ctx": "Incluir o ficheiro activo como contexto", "codev.runTests": "Correr os testes",
    "codev.lint": "Lint do Design System", "codev.send": "Enviar",
    "codev.focus": "Focar a conversa",
    "codev.intro": "Descreve um objectivo e o Co-Dev planeia, edita, corre testes e auto-avalia antes de entregar.",

    "status.commands": "Comandos", "status.switchBranch": "Mudar de ramo",
    "status.problems": "Problemas", "status.tests": "Testes", "status.goToLine": "Ir para a linha",
    "status.context": "Contexto usado na conversa", "status.model": "Modelo da conversa",
    "status.mode": "Alternar o modo de autonomia", "status.notifications": "Notificações",

    "nyi.toast": "ainda não implementado",
    "nyi.page": "Esta superfície pertence à fase {phase} da reescrita da UI — visível mas ainda não ligada ao backend.",
    "nyi.pane": "Ainda não implementado (fase {phase}).",
    "nyi.badge": "Ainda não implementado",
    "nyi.explain": "Nada é simulado aqui: a casca está pronta e esta vista é ligada ao backend real numa fase posterior. Ver docs/ui-rewrite/PENDING.md.",

    "notes.empty": "Sem notificações.", "notes.ready": "Casca da IDE dxtutor pronta",

    "empty.goToFile": "ir para ficheiro", "empty.commands": "comandos",
    "empty.codev": "falar com o Co-Dev", "empty.terminal": "terminal",

    "term.placeholder": "Terminal — ligado na fase 2 (PTY real).",

    "cmd.goToFile": "Ir para ficheiro…", "cmd.allCommands": "Mostrar todos os comandos",
    "cmd.goToLine": "Ir para a linha…", "cmd.nextProblem": "Ir para o próximo problema",
    "cmd.explorer": "Ver: Explorador", "cmd.search": "Ver: Pesquisa", "cmd.scm": "Ver: Controlo de versões",
    "cmd.run": "Ver: Correr e depurar", "cmd.testing": "Ver: Testes", "cmd.extensions": "Ver: Extensões",
    "cmd.toggleSide": "Ver: Alternar barra lateral", "cmd.togglePanel": "Ver: Alternar painel",
    "cmd.terminal": "Ver: Terminal", "cmd.problems": "Ver: Problemas",
    "cmd.codevFocus": "Co-Dev: Focar a conversa", "cmd.codevPanel": "Co-Dev: Painel de conhecimento",
    "cmd.learningTrack": "Percurso: Continuar", "cmd.studio": "Projecto: Studio de arquitectura",
    "cmd.board": "Projecto: Quadro (kanban)", "cmd.commitGraph": "Git: Grafo de commits",
    "cmd.team": "Equipa: Assistentes e harness", "cmd.manager": "Co-Dev: Gestor de missões",
    "cmd.welcome": "Ajuda: Bem-vindo", "cmd.settings": "Preferências: Definições",
    "cmd.theme": "Preferências: Tema", "cmd.lang": "Preferências: Idioma",

    "palette.placeholder": "Nome do ficheiro  ·  > comandos  ·  : linha",
    "palette.gotoLine": "Ir para a linha {n}", "palette.openFolderFirst": "Abre uma pasta primeiro (fase 2)",
    "palette.noResults": "Sem resultados.",

    "menu.file": "Ficheiro", "menu.newFile": "Novo ficheiro…", "menu.newFolder": "Nova pasta…",
    "menu.openFile": "Abrir ficheiro…", "menu.openFolder": "Abrir pasta…", "menu.save": "Guardar",
    "menu.preferences": "Preferências", "menu.settings": "Definições", "menu.theme": "Tema",
    "menu.language": "Idioma", "menu.closeTab": "Fechar separador",
    "menu.edit": "Editar", "menu.undo": "Anular", "menu.redo": "Refazer", "menu.findInFiles": "Procurar nos ficheiros",
    "menu.selection": "Selecção", "menu.selectAll": "Seleccionar tudo", "menu.sendToCodev": "Enviar selecção ao Co-Dev",
    "menu.view": "Ver", "menu.commandPalette": "Paleta de comandos…", "menu.sidebar": "Barra lateral",
    "menu.panel": "Painel inferior", "menu.codevPanel": "Painel do Co-Dev",
    "menu.go": "Ir", "menu.goToFile": "Ir para ficheiro…", "menu.goToLine": "Ir para a linha…",
    "menu.nextProblem": "Próximo problema", "menu.nextTab": "Separador seguinte", "menu.prevTab": "Separador anterior",
    "menu.run": "Correr", "menu.runStack": "▶ Correr a stack completa", "menu.stopStack": "Parar a stack",
    "menu.project": "Projecto", "menu.team": "Equipa e harness", "menu.commitGraph": "Grafo de commits",
    "menu.codev": "Co-Dev", "menu.terminal": "Terminal", "menu.showTerminal": "Mostrar terminal",
    "menu.help": "Ajuda", "menu.welcome": "Bem-vindo", "menu.about": "Sobre",

    "mode.manual": "Manual", "mode.manual.d": "Aprovas cada edição e comando antes de correr.",
    "mode.assist": "Assistido", "mode.assist.d": "As edições aplicam-se automaticamente com diff; acções destrutivas continuam a pedir.",
    "mode.auto": "Auto", "mode.auto.d": "O Co-Dev encadeia os passos; push e acções destrutivas pedem sempre.",

    "view.welcome": "Bem-vindo", "view.settings": "Definições", "view.studio": "Studio",
    "view.board": "Quadro", "view.graph": "Grafo de commits", "view.team": "Equipa",
    "view.manager": "Gestor de missões", "view.file": "Ficheiro", "view.diff": "Diff",
    "view.analysis": "Análise", "view.learn": "Lição", "view.lt": "Passo", "view.agent": "Co-Dev",

    "settings.sub": "Guardadas nesta aplicação. Chaves e endpoints reais ficam no keychain do sistema.",
    "settings.language": "Idioma", "settings.appearance": "Aparência",
    "settings.providers": "Modelos e provedores", "settings.shortcuts": "Atalhos de teclado",

    "welcome.sub": "Aprende uma linguagem passo a passo, ou desenha uma arquitectura e deixa uma equipa de assistentes construí-la: backlog, ramos, testes, contentores — depois corre tudo com um comando.",
    "welcome.learn": "Aprender", "welcome.lt": "Percurso de aprendizagem", "welcome.ltSub": "Rust e Go, do zero à confiança",
    "welcome.changeLevel": "Mudar de linguagem ou nível", "welcome.changeLevelSub": "Básico, Intermédio, Avançado",
    "welcome.design": "Do desenho a uma stack a correr",
    "welcome.studioSub": "Desenhar com AWS, Azure, GCP e componentes open-source",
    "welcome.boardSub": "Sprints, issues e testes automáticos",
    "welcome.teamSub": "Assistentes, harness e router de modelos",
    "welcome.graphSub": "Ramos, merges e gitflow", "welcome.runSub": "Construir e arrancar cada serviço",
    "welcome.mission": "Missão: histórico de conversas persistente", "welcome.missionSub": "Conselho, auto-avaliação e correcção",
    "welcome.managerSub": "Decisões, checkpoints e uso",
    "welcome.models": "Modelos e autonomia", "welcome.modelsSub": "Provedores, routing, modos, idioma",
    "welcome.palette": "Paleta de comandos",

    "toast.autosave": "Auto Save activo — já está guardado",
  },
};
