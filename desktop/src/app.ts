// app.ts — ponto de entrada da nova casca da IDE dxtutor (reescrita da UI).
//
// Substitui o antigo main.ts (casca dual-mode) pela casca do protótipo. Ordem de
// arranque: registar as strings → aplicar o tema → pintar i18n estático → montar
// a casca → esconder o splash. As fases seguintes ligam o backend real (editor
// Monaco, fsops, git, lsp, testes, Co-Dev, learning track, studio, RUN).

import "./shell.css";
import { registerStrings, initI18n, onLocaleChange } from "./i18n";
import { SHELL_STRINGS } from "./shell/strings";
import { initTheme } from "./shell/theme";
import { bootShell, rebuildChrome, setOpenFolderHandler, setSwitchBranchHandler } from "./shell";
import { initWorkspace, openFolder } from "./shell/workspace";
import { initTerminal } from "./shell/terminal";
import { initSearch } from "./shell/search";
import { initScm, switchBranch } from "./shell/scm";
import { initProblems } from "./shell/problems";

function hideBoot(): void {
  const b = document.getElementById("boot");
  if (!b) return;
  b.classList.add("boot-hiding");
  setTimeout(() => b.remove(), 400);
}

function main(): void {
  registerStrings(SHELL_STRINGS);
  initTheme();
  initI18n();
  initWorkspace();                       // regista VIEW.file + RP.explorer reais
  initSearch();                          // RP.search → search_project
  initScm();                             // RP.scm → git_*
  initProblems();                        // panel Problems ← markers (LSP)
  setOpenFolderHandler(() => void openFolder());
  setSwitchBranchHandler(() => void switchBranch());
  onLocaleChange(() => rebuildChrome());
  bootShell();
  initTerminal();                        // terminal real (PTY) no painel inferior
  hideBoot();
}

main();
