# Decisões — reescrita da UI

Uma linha por decisão tomada perante ambiguidade (ordem cronológica).

- 2026-11-13 — **Protótipo-fonte = `(2)`** (`dxtutor IDE — protótipo navegável(2).html`,
  941 KB, o mais recente) em vez do `(1)` citado na linha «fonte code» do prompt. `(2)` é
  superset: inclui explicitamente *Learning Track* e *Architecture Studio* e muito mais
  conteúdo de Co-Dev. Copiado para `docs/prototype/index.html` (a pasta estava vazia).
- 2026-11-13 — **Base do ramo = HEAD de `feat/ide-reskin-and-multi-lsp`**, não `main`. O
  prompt diz «criado a partir do ramo principal», mas `main` está 20 commits atrás e não
  tem o backend `desktop/src-tauri/src/lsp.rs` (+648) multi-linguagem nem `chat.rs`/`review.rs`
  recentes. Ramificar de `main` **regrediria** capacidades reais do backend — proibido pela
  regra «nada de regressões». A regra de não-regressão prevalece sobre a instrução literal.
- 2026-11-13 — **WIP não commitado preservado** como commit `chore(ide): snapshot reskin WIP`
  antes de iniciar as fases, para separar o trabalho pré-existente dos commits de fase.
- 2026-11-13 — Contratos de sessão em `.claude/sessions/` **não** são commitados (efémeros).
- 2026-11-13 — **Fase 2 em sub-commits coerentes** (ex.: «workspace core», «git», …) em vez de
  um único commit gigante. A Fase 2 (paridade) é grande demais para um só commit sem acumular
  trabalho não guardado por muitos turnos; cada sub-commit é um corte verificável. O humano pode
  fazer squash no merge se quiser um commit por fase.
- 2026-11-13 — **`docs/v2/` do prompt genérico = `docs/ui-rewrite/` deste repo.** O template
  de missão fala em `docs/v2/GAP.md`/`DECISIONS.md`; o contrato de sessão e os docs desta
  reescrita já vivem em `docs/ui-rewrite/`. O Passo-0 (inventário GAP) é o `PENDING.md` +
  `PLAN.md` já existentes (estado por superfície + fase que liga); não se duplica num `docs/v2/`.
- 2026-11-13 — **F4 em sub-commits** (como a Fase 2). 1.º corte: selector de modelo real
  (`list_providers`/`assistant_models`, escolha persistida), painel **Output·Co-Dev**
  (registo honesto de enviado/resposta/erro) e **provedores em Settings**
  (`get_providers_config`/`save_providers_config`, via hook `setProvidersPanel`). Conselho de
  modelos, juiz, auto-avaliação+correcção, checkpoints e gestor de missões ficam para
  sub-commits seguintes — até lá, honestamente desactivados (PENDING.md). Verificação deste
  corte: `tsc --noEmit`+`vite build` verdes e `cargo test` (tutor-eval/tutor-llm + desktop) sem
  regressão (Rust intocado); a superfície é UI sobre comandos já testados.
- 2026-11-13 — **F8 (1.º corte) = backend `arch_scaffold` estendido** (crate `tutor-eval::arch`).
  Além das pastas de código + `ARCHITECTURE.md`, o scaffold passa a emitir, DERIVADO do desenho
  real: `Dockerfile` (multi-stage, não-root) por componente vivo; `docker-compose.yml` com um
  serviço por componente vivo + infra local; `Makefile` (run/stop/logs/test); `.env.example`; e
  `deploy/k8s/<comp>.yaml` + `00-infra.yaml`. Stores→`postgres:16-alpine`, brokers→
  `rabbitmq:3.13-management-alpine` (stand-ins locais honestos; o modelo não carrega escolha de
  tecnologia). A ligação `DATABASE_URL`/`AMQP_URL` é inferida das arestas writes/reads/publishes/
  consumes. Teste-primeiro: `arch::tests::scaffold_emits_cloud_native_artifacts` (falha sem a
  feature; 114 testes tutor-eval verdes). A acção da UI (botão «gerar» no Studio) e o RUN/Stop
  ficam para sub-commits seguintes de F8.
- 2026-11-13 — **F8 (2.º corte) = acção «Gerar scaffold» no Studio.** O botão primário do
  Studio (antes desactivado) passa a chamar `arch_scaffold(root, toArchitecture(SD))`: escreve o
  esqueleto na pasta aberta (nunca sobrepõe) e lista os caminhos devolvidos no inspector. Estado
  honesto quando não há pasta (`open a folder first`) ou o desenho tem erros de validação. O
  resultado é invalidado a cada alteração do desenho. ▶ RUN (stack via docker compose) fica para
  o corte seguinte. Verificação: `tsc+vite` verde; backend `arch_scaffold` já testado em F8a.
- 2026-11-13 — **Vistas do workspace reescritas de raiz** sobre os comandos Tauri reais, em vez de
  portar os módulos antigos (`workspace.ts`/`git.ts`/… acoplados ao DOM antigo de overlays). O
  backend (97 comandos) é a fonte de verdade; capacidades mais ricas (LSP, breakpoints, streaming)
  são trazidas à medida que cada pane/vista é ligado. Os módulos antigos ficam como referência.
