# GAP — inventário da missão v7 (Passo 0)

Inventário obrigatório antes de qualquer trabalho da missão v7: uma linha por
funcionalidade, com **estado**, **comandos Tauri** envolvidos, **ficheiros** que a
implementam e a **lacuna** (o que falta). É uma fotografia do que *já existe*, não um plano.

## Fonte de verdade (e por que não é o protótipo v7)

O protótipo v7 veio como anexo de uma conversa anterior e **não sobreviveu ao `/clear`**:
não está em disco (o único `docs/prototype/index.html`, 942 KB, é o **v3** — o `/* v3 */` na
linha 465 é um comentário de secção CSS) nem no contexto deste agente. Por decisão do dono,
a fonte de verdade deste inventário é, portanto:

- **Comportamento alvo e fases:** [`docs/ui-rewrite/PLAN.md`](../ui-rewrite/PLAN.md) — define as 8 fases que esta missão chama F1–F8.
- **Estado por superfície existente:** [`docs/ui-rewrite/PARITY.md`](../ui-rewrite/PARITY.md) e [`docs/ui-rewrite/PENDING.md`](../ui-rewrite/PENDING.md).
- **Fonte visual:** [`docs/prototype/index.html`](../prototype/index.html) (v3).
- **Backend real:** os 97 comandos `#[tauri::command]` registados em [`desktop/src-tauri/src/main.rs`](../../desktop/src-tauri/src/main.rs) (`generate_handler![…]`, linhas 2201–2299) + crates `tutor-*`.
- **Implementação da casca:** [`desktop/src/shell/*.ts`](../../desktop/src/shell/) no ramo **`feat/ui-rewrite`** (ainda **não integrado** em `main`).

> ⚠️ **Aviso de fidelidade.** Como o v7 não está disponível, as «8 funcionalidades» deste
> GAP são as **8 fases do `PLAN.md`** do ui-rewrite. O prompt da missão sugere que coincidem
> (F1–F3/F5–F7 feitas, F4/F8 em curso), mas se o v7 definir um conjunto diferente este
> inventário tem de ser revisto contra ele.

## Legenda de estado

- **existe** — portado para a nova casca e ligado ao backend real (falta só verificação visual/execução).
- **parcial** — o essencial liga, mas há superfícies honestamente desactivadas («not implemented yet») ou por verificar.
- **falta** — a funcionalidade (ou o seu backend) ainda não existe.

Estado por funcionalidade existente (27 itens, granularidade fina) em [`PARITY.md`](../ui-rewrite/PARITY.md); aqui agrega-se por fase.

## Inventário (uma linha por funcionalidade)

| # | Funcionalidade (fase v7) | Estado | Comandos Tauri envolvidos | Ficheiros | O que falta (lacuna) |
|---|--------------------------|--------|---------------------------|-----------|----------------------|
| **F1** | **Casca da IDE** — grid titlebar/mid/status, activity bar, panes permutáveis, router de vistas `VIEW[kind]`, command palette (`F1`/`Ctrl+Shift+P`, prefixos `>` `:` quick-open), panel inferior, status bar, 3 temas, menus, i18n | **existe** | — (chrome puro; sem backend). `list_files`/`revealLine` só para quick-open/go-to-linha | [`shell/index.ts`](../../desktop/src/shell/index.ts), [`strings.ts`](../../desktop/src/shell/strings.ts), [`theme.ts`](../../desktop/src/shell/theme.ts), [`icons.ts`](../../desktop/src/shell/icons.ts) · commit `db3393e` | Só verificação visual contra o protótipo. |
| **F2** | **Paridade** — explorer, editor Monaco multi-aba+autosave, outline/breadcrumbs, LSP (def/hover/refs/rename), Problems, pesquisa, SCM, terminal, testes, CodeMap, review, remote/containers, edição ancorada | **parcial** | `fsops::*`, `read_text_file`/`write_text_file`, `file_outline`, `lsp_start`/`did_open`/`did_change`/`definition`/`hover`/`references`/`rename`/`prepare_rename`, `get_diagnostics`/`diff_lines`, `search_project`, `git_changes`/`stage`/`unstage`/`commit`/`branches`/`checkout`, `pty_spawn`/`write`/`resize`, `list_tests`/`run_test`/`run_all_tests`, `symbol_relations`, `review_code`/`list_review_analyzers`/`verify_review_fix`, `detect_projects`/`devcontainer_*`, `run_path`/`run_measured`/`trace_execution`/`debug_capabilities`, `agent_isolated_patch`/`agent_task_*` | [`workspace.ts`](../../desktop/src/shell/workspace.ts), [`search.ts`](../../desktop/src/shell/search.ts), [`scm.ts`](../../desktop/src/shell/scm.ts), [`tests.ts`](../../desktop/src/shell/tests.ts), [`problems.ts`](../../desktop/src/shell/problems.ts), [`codemap.ts`](../../desktop/src/shell/codemap.ts), [`review.ts`](../../desktop/src/shell/review.ts), [`debug.ts`](../../desktop/src/shell/debug.ts), [`remote.ts`](../../desktop/src/shell/remote.ts), [`terminal.ts`](../../desktop/src/shell/terminal.ts), [`edit.ts`](../../desktop/src/shell/edit.ts) · commits `b4dc649`→`5b0c0dd` | **Explain** (resumo lado-a-lado em stream) não portado (sem `shell/explain.ts`); **orquestração** (plano/continue/auto/verify) por ligar; **breakpoints** no gutter «not implemented yet» ([debug.ts:197](../../desktop/src/shell/debug.ts#L197)); **substituir-tudo** na pesquisa, **discard/diff** no SCM e **aplicar-fix** no review (`verify_review_fix`+`content_version`) por ligar; edição ancorada (dxpatch) com diff inline por verificar. |
| **F3** | **Learning Track** — onboarding linguagem/nível, árvore de unidades c/ estrelas, LEARN/DRILL/APPLY, pontos+bloqueio, vista de passo (editor+resultados), «Under the hood», Continue | **existe** (progresso local) | `list_courses`, `get_course`, `submit_step`, `request_hint`, `run_drill`, `list_phases`, `get_glossary`, `get_study_guide` | [`shell/learn.ts`](../../desktop/src/shell/learn.ts) (662 l) · commit `7c532ee` | Progresso persiste em `localStorage`; o backend `tutor-track` fica por ligar (ver PENDING). Superfícies menores com «not implemented yet». |
| **F4** | **Co-Dev** — modos Manual/Assistido/Auto com matriz de política, conselho de modelos c/ juiz, auto-avaliação c/ limiar+correcção, checkpoints, registo de decisões, gestor de missões | **parcial** | `list_providers`, `assistant_models`, `assistant_chat`/`assistant_chat_stream`/`assistant_cancel`, `get_providers_config`/`save_providers_config`, `study_policy`, `request_plan`/`request_fix`, `agent_task_submit`/`status`/`cancel` | [`shell/codev.ts`](../../desktop/src/shell/codev.ts) (465 l) · commit `47949cd` (F4a) | **F4a feito:** selector de modelo real, Output·Co-Dev (enviado/resposta/erro), provedores em Settings. **Falta** (desactivado honestamente, ver [codev.ts:9](../../desktop/src/shell/codev.ts#L9)): matriz de modos a **governar de facto** a aprovação de edições/comandos (`study_policy`/`policy.rs`); `VIEW.manager` (gestor de missões sobre `agent_task_*`) + checkpoints restauráveis + registo de decisões; conselho de modelos + juiz + auto-avaliação (real só com múltiplos provedores). |
| **F5** | **Equipa** — vários assistentes com harness (paths/comandos/limite de ficheiros) imposto no backend por chamada de ferramenta; router de modelos sobre `tutor-llm`; provedores Claude/Gemini/Codex/Ollama | **parcial** | `list_providers`, `get_providers_config`/`save_providers_config`, `assistant_models` | [`shell/team.ts`](../../desktop/src/shell/team.ts) (402 l) · commit `5f8309f` | Config + preview do harness + router de modelos ligados sobre provedores reais. **Falta:** o backend **não impõe** o harness (não bloqueia escrita/comando fora dos paths/limites por chamada); pane **Account** (identidade/registo) por definir. |
| **F6** | **Gitflow** — fluxo guiado feature/fix/release/hotfix sobre o git real + grafo de commits (DAG) + diff | **parcial** | `git_log`, `git_show`, `git_branches`/`git_branch`, `git_create_branch`, `git_checkout`, `git_diff` | [`shell/gitflow.ts`](../../desktop/src/shell/gitflow.ts) (411 l) · commit `2e49ff0` | Grafo DAG + **gitflow start** ligados. **Falta — lacuna de backend:** **gitflow finish (merge+tag) não é possível** porque `git_merge`/`git_tag` **não existem** no backend (grep em `main.rs` = 0); a UI mostra os comandos para o utilizador correr no terminal em vez de os executar. |
| **F7** | **Architecture Studio** — catálogo de tecnologias por cloud, canvas interactivo (adicionar/ligar/apagar nós), validação do desenho, persistência | **existe** | `arch_validate` (+ `arch_scaffold`, partilhado com F8) | [`shell/studio.ts`](../../desktop/src/shell/studio.ts) (589 l) · commit `539bfa4` (+ `c638e07`/`a5b0d39`/`64943bc` em main: canvas+persistência) | Catálogo, canvas e validação ligados; desenho persiste entre sessões. Geração de artefactos e RUN pertencem a F8 (abaixo). |
| **F8** | **Artefactos e RUN** — scaffold Dockerfile/compose/Makefile/.env/k8s a partir do desenho; RUN/Stop reais da stack; vista de serviços; backlog+sprints do Studio (Board/kanban) | **parcial** | `arch_scaffold` (crate `tutor-eval::arch`), `pty_spawn`/`pty_spawn_in_session` (RUN via terminal real), `run_tests` (auto-teste do kanban) | [`shell/studio.ts`](../../desktop/src/shell/studio.ts), [`terminal.ts`](../../desktop/src/shell/terminal.ts), [`board.ts`](../../desktop/src/shell/board.ts), [`index.ts:173-178`](../../desktop/src/shell/index.ts#L173) · commits `91a2fd1`, `6ec7682`, `929ed3b` | **Feito:** `arch_scaffold` emite Dockerfile/compose/Makefile/.env/k8s derivados do desenho (stores→postgres, brokers→rabbitmq); acção «Gerar scaffold» no Studio; **▶ RUN/Stop da stack** no terminal PTY real. **Falta:** vista **Services** dedicada no painel inferior (`#pc-services`); **Board** gerar backlog do Studio / executar sprint é **orquestração por ligar** (kanban + auto-teste já ligam; delegação real de trabalho a assistentes marcada `disabled` em [board.ts:243](../../desktop/src/shell/board.ts#L243)); não há comando `docker` no backend — RUN é conduzido pelo terminal (docker/podman podem estar ausentes → erro honesto). |

## Resumo

| Estado | Fases |
|--------|-------|
| **existe** | F1, F3, F7 |
| **parcial** | F2, F4, F5, F6, F8 |
| **falta** (fase inteira) | — nenhuma; só lacunas pontuais acima |

As lacunas que exigem **backend novo** (não só UI): `git_merge`/`git_tag` para F6 (gitflow
finish); imposição do harness por chamada de ferramenta em F5; persistência de progresso
(`tutor-track`) em F3; comando real de RUN de stack (hoje via PTY) em F8. As restantes são
superfícies de UI por ligar a comandos Tauri **que já existem**.

> **Nota de ramo.** Tudo o que este inventário marca «existe/parcial» vive no ramo
> `feat/ui-rewrite`, ainda não integrado em `main`. A missão v7 deve **estender**, não
> reescrever; em particular **F4 e F8** (as fases «em curso») são o trabalho genuinamente a
> continuar — alinhar com o que já está nos `shell/*.ts` antes de duplicar.
