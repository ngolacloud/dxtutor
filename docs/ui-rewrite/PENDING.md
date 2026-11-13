# PENDING — o que está visível mas desactivado («not implemented yet»)

Cada entrada corresponde a uma superfície que aparece na UI (para fidelidade ao protótipo)
mas ainda não está ligada ao backend real. Regra: nunca simular em silêncio; mostrar o estado
«not implemented yet» e registar aqui, com a fase em que será ligada.

| Superfície | Onde | Porquê pendente | Fase que liga |
|------------|------|-----------------|---------------|
| Outline (LSP) | pane explorer §Outline | `file_outline` por ligar | 2 |
| Substituir-tudo (pesquisa) | pane `search` | sem comando backend; replace client-side por fazer | 2 |
| Descartar/diff (SCM) | pane `scm` | `git checkout --` (sem comando) / `git_diff` por ligar | 2 |
| Run and Debug | pane `run` | `debug_*`/`trace_execution` por ligar | 2 |
| Testing | pane `test` | `list_tests`/`run_*` por ligar | 2 |
| Extensions | pane `ext` | catálogo de extensões por definir | 2 |
| Remote Explorer | pane `remote` | `detect_projects` por ligar | 2 |
| Containers | pane `containers` | `devcontainer_*` por ligar | 2 |
| Editor (Monaco) | `VIEW.file` | editor Monaco por montar | 2 |
| Diff | `VIEW.diff` | `diff_lines` por ligar | 2 |
| Commit graph | `VIEW.graph` | `git_log`/`git_show` por ligar | 6 |
| Analysis/Review | `VIEW.analysis` | `review_code` por ligar | 2 |
| Problems | panel `problems` | `get_diagnostics` por ligar | 2 |
| Output · Co-Dev | panel `output` | log do Co-Dev por ligar | 4 |
| Services | panel `services` | RUN de stack por ligar | 8 |
| Quick-open (ficheiros) | paleta (sem prefixo) | precisa de pasta aberta (`list_files`) | 2 |
| Ir para a linha | paleta `:` | precisa do editor Monaco | 2 |
| Co-Dev (chat/orquestração) | dock `agent` | `assistant_chat_stream`+modos por ligar | 4 |
| Escolher modelo / providers | dock + Settings | `list_providers`/config por ligar | 4 |
| Learning Track | pane `tutor`, `VIEW.lt`/`learn` | `get_course`/`submit_step` por ligar | 3 |
| Account | pane `account` | identidade/registo por definir | 5 |
| Architecture Studio | `VIEW.studio` | `arch_validate`/`arch_scaffold` por ligar | 7 |
| Board / kanban | `VIEW.board` | modelo de issues/sprints por ligar | 7 |
| Team / harness | `VIEW.team` | harness no backend por ligar | 5 |
| Mission manager | `VIEW.manager` | missões/checkpoints por ligar | 4 |
| RUN / Stop (stack) | menu Run/Project, status | `docker compose up --build` por ligar | 8 |

Na Fase 1 todas estas superfícies aparecem **visíveis mas desactivadas**, com o aviso
«not implemented yet (fase N)». Nenhuma devolve dados inventados.

> Actualizar a cada fase: remover a linha quando a superfície passar a usar o backend real.
