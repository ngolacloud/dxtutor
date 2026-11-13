# PENDING — o que está visível mas desactivado («not implemented yet»)

Cada entrada corresponde a uma superfície que aparece na UI (para fidelidade ao protótipo)
mas ainda não está ligada ao backend real. Regra: nunca simular em silêncio; mostrar o estado
«not implemented yet» e registar aqui, com a fase em que será ligada.

| Superfície | Onde | Porquê pendente | Fase que liga |
|------------|------|-----------------|---------------|
| Substituir-tudo (pesquisa) | pane `search` | sem comando backend; replace client-side por fazer | 2 |
| Descartar/diff (SCM) | pane `scm` | `git checkout --` (sem comando) / `git_diff` por ligar | 2 |
| Aplicar correcção (review) | `VIEW.analysis` | `verify_review_fix` + content_version por ligar | 2 |
| Extensions | pane `ext` | catálogo de extensões por definir | 2 |
| Diff | `VIEW.diff` | `diff_lines` por ligar | 2 |
| Gitflow finish (merge+tag) | `VIEW.graph`/paleta | sem `git_merge`/`git_tag` no backend; mostra comandos p/ terminal | 6 |
| Co-Dev: conselho de modelos + juiz + auto-avaliação | dock `agent` | só reais com MÚLTIPLOS provedores configurados; sem eles ficam visíveis+desactivados, nunca simulados (os modos Manual/Assistido/Auto governam DE FACTO edições — `edit.ts` — e comandos de stack — `studio.ts` — via matriz `codev_policy`; orquestração de planos também) | 4 |
| Account | pane `account` | identidade/registo por definir | 5 |
| Board: gerar backlog do Studio / executar sprint | `VIEW.board` | orquestração por ligar (kanban+auto-teste já ligam; `arch_scaffold` pronto) | 8 |
| Team: imposição do harness no backend | `VIEW.team` | backend não bloqueia escrita/comando por chamada (config+preview já ligam; providers reais) | 5 |
| Checkpoints restauráveis (gestor de missões) | `VIEW.manager` | o gestor já LIGA (`VIEW.manager` @52eaa37: delega o scaffold do desenho como patch isolado via `arch_scaffold_preview`→`agent_task_submit/status/cancel`, mostra o diff, não toca na árvore); falta só o checkpoint restaurável — precisa de snapshot/restore no backend, inexistente | 4 |
| Breakpoints (gutter) | editor Monaco | acoplamento ao gutter em workspace.ts por fazer | — |
| Explain de PASTA (multi-ficheiro) | `VIEW.explain` | `read_folder_sources` + links `[open f:l]` por ligar (ficheiro único já liga) | — |

Na Fase 1 todas estas superfícies aparecem **visíveis mas desactivadas**, com o aviso
«not implemented yet (fase N)». Nenhuma devolve dados inventados.

> Actualizar a cada fase: remover a linha quando a superfície passar a usar o backend real.
