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
| Services | panel `services` | RUN de stack por ligar | 8 |
| Co-Dev avançado (conselho/juiz/auto-avaliação/checkpoints/cancelar) | dock `agent` | orquestração por ligar (chat-base + selector de modelo já ligam) | 4 |
| Account | pane `account` | identidade/registo por definir | 5 |
| Studio: gerar backlog / RUN | `VIEW.studio` | `arch_scaffold` + orquestração por ligar (validação já liga) | 8 |
| Board: gerar backlog do Studio / executar sprint | `VIEW.board` | `arch_scaffold`+orquestração por ligar (kanban+auto-teste já ligam) | 8 |
| Team: imposição do harness no backend | `VIEW.team` | backend não bloqueia escrita/comando por chamada (config+preview já ligam; providers reais) | 5 |
| Mission manager | `VIEW.manager` | missões/checkpoints por ligar | 4 |
| RUN / Stop (stack) | menu Run/Project, status | `docker compose up --build` por ligar | 8 |
| Breakpoints (gutter) | editor Monaco | acoplamento ao gutter em workspace.ts por fazer | — |
| Explain (resumo stream lado-a-lado) | `VIEW` explain | stream IA por ligar | 2 |

Na Fase 1 todas estas superfícies aparecem **visíveis mas desactivadas**, com o aviso
«not implemented yet (fase N)». Nenhuma devolve dados inventados.

> Actualizar a cada fase: remover a linha quando a superfície passar a usar o backend real.
