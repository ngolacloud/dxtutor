# PARITY — funcionalidades existentes × nova casca

Inventário de tudo o que a UI actual faz, mapeado ao local do protótipo onde passa a viver.
Estado: ⬜ por ligar · 🔶 ligado, por verificar · ✅ verificado na nova casca (inspecção/execução).

Verificar = abrir a app na nova casca e observar o comportamento real (não «o código parece certo»).

| # | Funcionalidade | Módulo / comando actual | Local no protótipo | Estado |
|---|----------------|-------------------------|--------------------|--------|
| 1 | Abrir pasta (recentes/clonar pend.) | `fsops::pick_folder` | menu File + empty-state explorer | ✅ |
| 2 | Árvore de ficheiros (Explorer) | `fsops::list_dir/create_path` | pane `explorer` | ✅ |
| 3 | Editor Monaco multi-aba + autosave | `read/write_text_file`, `monaco.ts` | `VIEW.file` + `#tabs` | ✅ |
| 4 | Outline + breadcrumbs + minimap | `file_outline` (LSP/sintáctico) + Monaco | explorer §Outline + breadcrumbs | ✅ |
| 5 | Go-to-def / hover / refs / rename | `lsp_start/did_open/did_change/definition/hover/references/rename` | editor Monaco (reusa lsp.ts) | 🔶 |
| 6 | CodeMap (defs/refs/callers) | `symbol_relations`, `codemap.ts` | pane/vista | ⬜ |
| 7 | Pesquisa (substituir-tudo pend.) | `search_project` | pane `search` | 🔶 |
| 8 | Source Control (discard/diff pend.) | `git_changes/stage/unstage/commit/branch/checkout` | pane `scm` | 🔶 |
| 9 | Grafo de commits (DAG) + diff | `git_log/git_show`, `git.ts` | `VIEW.graph` | ⬜ |
| 10 | Run & Debug (breakpoints/trace) | `debug_*`, `trace_execution`, `debug.ts` | pane `run` | ⬜ |
| 11 | Testes (descobrir/correr) | `list_tests/run_test/run_all_tests` | pane `test` + painel Output + st-tests | 🔶 |
| 12 | Problems (diagnósticos) | markers Monaco ← `lsp://diagnostics` | panel `problems` + st-prob | 🔶 |
| 13 | Terminal (PTY) | `pty_spawn/write/resize`, `pty://data` | panel `terminal` (xterm) | 🔶 |
| 14 | Remote Explorer | `detect_projects`, `remote.ts` | pane `remote` | ⬜ |
| 15 | Dev Containers (sessão/exec/run) | `devcontainer_*`, `remote.ts` | pane `containers` | ⬜ |
| 16 | Explain (resumo lado-a-lado, stream) | `explain.ts`, chat stream | `VIEW` explain (split) | ⬜ |
| 17 | Review (achados; aplicar-fix pend.) | `review_code` (list_review_analyzers/verify_fix pend.) | `VIEW.analysis` + paleta | 🔶 |
| 18 | Quick Open / Command Palette | `list_files`, `quickopen.ts` | `#pal` palette | ⬜ |
| 19 | Dev Assistant (chat, providers) | `assistant_chat_stream`, `assistant.ts` | dock `agent` | ⬜ |
| 20 | Orquestração (plano/continue/auto/verify) | `assistant.ts`, `run_tests` | dock `agent` + run-ctl | ⬜ |
| 21 | Edição ancorada (dxpatch) + conflito | `edit.ts`, `patch.ts`, `agent_isolated_patch` | editor (diff inline) | ⬜ |
| 22 | Tarefa isolada (worktree→patch) | `agent_task_submit/status/cancel` | agent (run in isolation) | ⬜ |
| 23 | Architecture Studio (validar/scaffold) | `arch_validate/arch_scaffold`, `arch.ts` | `VIEW.studio` | ⬜ |
| 24 | Learning Track (cursos/avaliação) | `get_course/submit_step/request_hint/get_glossary`, `tutor-core` | pane `tutor` + `VIEW.lt`/`learn` | ⬜ |
| 25 | Política de estudo (modos) | `study_policy`, `policy.rs` | Co-Dev matriz | ⬜ |
| 26 | Settings (providers, temas, atalhos) | `get/save_providers_config` | `VIEW.settings` | ⬜ |
| 27 | Sandbox engine (host/docker/podman) | `get/set_sandbox_engine` | status / settings | ⬜ |

As fases 4–8 (Co-Dev avançado, Equipa, Gitflow guiado, Board/kanban, RUN de stack) são
funcionalidade **nova** descrita pelo protótipo, rastreada no `PLAN.md` por fase — não entram
nesta tabela de *paridade* (que cobre o que já existe hoje).
