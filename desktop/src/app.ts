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
import { bootShell, rebuildChrome, setOpenFolderHandler, setSwitchBranchHandler, setGotoLineHandler, setFileListProvider } from "./shell";
import { initWorkspace, openFolder, revealLine, listWorkspaceFiles } from "./shell/workspace";
import { initTerminal } from "./shell/terminal";
import { initSearch } from "./shell/search";
import { initScm, switchBranch } from "./shell/scm";
import { initProblems } from "./shell/problems";
import { initTests } from "./shell/tests";
import { initReview } from "./shell/review";
import { initRemote } from "./shell/remote";
import { initCodemap } from "./shell/codemap";
import { initDebug } from "./shell/debug";
import { initStudio } from "./shell/studio";
import { initLearn } from "./shell/learn";
import { initCodev } from "./shell/codev";
import { initEdit } from "./shell/edit";
import { initExplain } from "./shell/explain";
import { initSandbox } from "./shell/sandbox";
import { initPolicyMatrix } from "./shell/policyMatrix";
import { initGitflow } from "./shell/gitflow";
import { initTeam } from "./shell/team";
import { initBoard } from "./shell/board";

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
  initTests();                           // RP.test → list_tests/run_*
  initReview();                          // VIEW.analysis + comandos → review_code
  initRemote();                          // RP.remote/containers → detect_projects/devcontainer_*
  initCodemap();                         // comando → symbol_relations (defs/refs/callers)
  initDebug();                           // RP.run → run_path/run_measured/trace_execution/debug_capabilities
  initStudio();                          // VIEW.studio + comando → arch_validate (Fase 7)
  initLearn();                           // RP.tutor + VIEW.lt → list_courses/get_course/submit_step/request_hint (Fase 3)
  initGitflow();                         // VIEW.graph (DAG) + comandos Gitflow → git_* (Fase 6)
  initTeam();                            // VIEW.team → list_providers + harness/router (Fase 5)
  initBoard();                           // VIEW.board → kanban + run_all_tests (Fase 7)
  setOpenFolderHandler(() => void openFolder());
  setSwitchBranchHandler(() => void switchBranch());
  setGotoLineHandler((n) => revealLine(n));
  setFileListProvider(() => listWorkspaceFiles());
  onLocaleChange(() => rebuildChrome());
  initEdit();                            // VIEW.diff → edição ancorada (dxpatch) revista no diff (Fase 2)
  initExplain();                         // VIEW.explain → resumo lado-a-lado em stream (Fase 2)
  initSandbox();                         // Settings → selector de motor de sandbox (get/set_sandbox_engine) (Fase 2)
  initPolicyMatrix();                    // paleta → matriz de política dos modos Co-Dev (lê codev_policy) (Fase 4)
  bootShell();
  initCodev();                           // chat do dock Co-Dev → assistant_chat_stream (Fase 2→4)
  initTerminal();                        // terminal real (PTY) no painel inferior
  hideBoot();
}

main();
