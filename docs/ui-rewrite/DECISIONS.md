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
- 2026-11-13 — **F8 (3.º corte) = ▶ RUN/Stop da stack no PTY real.** O botão ▶ RUN do Studio e o
  menu Run correm `cd <root> && docker compose up --build -d && docker compose ps` / `… down` no
  terminal integrado (PTY real, via `runInTerminal` em terminal.ts + hooks `setRunStackHandler`/
  `setStopStackHandler` em index.ts). Honesto: se docker/compose não existir no host (p.ex. só há
  delonix), o erro aparece no terminal — nada simulado; o scaffold tem de ter sido gerado antes
  (senão `docker compose` não encontra configuração, e di-lo). A **vista estruturada Services**
  (parse de `docker compose ps` em `#pc-services`) fica pendente. Verificação: `tsc+vite` verde.
- 2026-11-13 — **`docs/v2/GAP.md` criado (reconcilia a decisão de 21-24 acima).** A missão v7
  exigiu o Passo-0 num `docs/v2/GAP.md` próprio. Em vez de o recusar como duplicação (decisão
  anterior «docs/v2 == docs/ui-rewrite, não se duplica»), cria-se o GAP.md como **vista de
  síntese agregada por fase** (F1–F8: estado + comandos Tauri + ficheiros + lacuna) que aponta
  para o `PLAN.md`/`PARITY.md`/`PENDING.md` como fonte fina — não os substitui. Motivo: o
  protótipo v7 do anexo perdeu-se no `/clear`; o dono optou por manter o ramo `feat/ui-rewrite`
  (não um `feature/v2-prototype` de `main`) e usar `docs/ui-rewrite` + v3 como fonte de verdade.
- 2026-11-13 — **F8 (4.º corte) = backend `compose_ps` (fonte da vista Services).** Novo comando
  Tauri `compose_ps(root)` corre `docker compose ps --format json` em `root` e devolve a lista
  estruturada (nome/serviço/estado/estado-detalhado/imagem/portas). O parse é uma função PURA
  `parse_compose_ps` (NDJSON uma-linha-por-objecto ou array; tolerante a campos em falta),
  testada primeiro (`parse_compose_ps_*`, 10 testes do crate desktop verdes). Honesto: docker
  ausente → erro do spawn; sem stack/compose → mensagem do compose propagada. **O pane
  `#pc-services` fica por ligar** — vive em `index.ts`/`index.html`, em edição concorrente pelo
  dono, por isso evita-se tocar-lhes agora (só o backend, isolado, entra neste corte).
- 2026-11-13 — **F8 (5.º corte) = vista Services (`#pc-services`) ligada ao `compose_ps`.** Nova
  aba «Services» no painel inferior (botão em `index.html`) que renderiza a lista real de serviços
  da stack: serviço/estado/imagem/portas, com Actualizar e Parar stack. Estados honestos — sem
  pasta, docker/stack ausente (erro do backend propagado + dica), ou stack parada («gera o scaffold
  e ▶ RUN»). Para NÃO colidir com a edição concorrente do dono em `index.ts`/`codev.ts`/`app.ts`, o
  render e o wiring da aba vivem em `studio.ts` (já inicializado no arranque) e só se tocou
  `index.html` (aba) — nenhum ficheiro «quente» do dono foi editado. A linha «Services (pane)» do
  `PENDING.md` fica por remover porque esse ficheiro está em edição concorrente; passa a estar, de
  facto, ligada. Verificação: `tsc+vite` verde; backend `compose_ps` testado em F8d.
- 2026-11-13 — **F4 gestor de missões é construído pelo dono; eu contribuo só o primitivo de
  backend.** Ao tentar o `VIEW.manager` em paralelo, colidiu com trabalho concorrente do dono no
  mesmo espaço (modos/`policy.rs`, loop agêntico em `edit.ts`/`codev.ts`, e brevemente
  `initManager()` em `app.ts`). Para não duplicar nem clobbar, recuei a minha UI (removido
  `shell/manager.ts`, revertido `studio.ts`) e mantive apenas o comando novo **`arch_scaffold_preview`**
  (em `main.rs`): devolve os `(caminho, conteúdo)` do scaffold **sem escrever**, para a delegação
  isolada (`agent_task_submit` → worktree patch → revisão) que o gestor de missões precisa. Testado
  (`scaffold_preview_payload_has_compose`, crate desktop 11 verdes). O resto do F4 (manager/modos/
  conselho) fica para o dono fechar nos ficheiros que está a editar.
- 2026-11-13 — **F4 gestor de missões (`VIEW.manager`) LIGADO** (depois de o dono parar 5 min — via
  monitor de mtime). Reintroduzido `shell/manager.ts` (que tinha recuado na colisão): regista
  `VIEW.manager`, delega o scaffold do desenho como **patch isolado** (`arch_scaffold_preview` →
  `agent_task_submit` → `agent_task_status`/`agent_task_cancel`), mostra o diff para revisão e nunca
  toca na árvore de trabalho. Inicializado a partir de `studio.ts` (`initManager(() =>
  currentArchitecture())`) — **sem** editar ficheiros quentes do dono (modos/`policy.rs`, `codev.ts`,
  `index.ts`, `app.ts` ficam intactos e por-committar, trabalho dele). O `#ag-history` do dock e o
  comando «Mission manager» da casca passam a abrir a vista real. Verificação: `tsc+vite` verde;
  `cargo test` desktop 11. Modos/conselho/juiz: o dono está a construí-los (modos já em `policy.rs`/
  `index.ts` `currentMode`), fora deste commit.
- 2026-11-13 — **Vistas do workspace reescritas de raiz** sobre os comandos Tauri reais, em vez de
  portar os módulos antigos (`workspace.ts`/`git.ts`/… acoplados ao DOM antigo de overlays). O
  backend (97 comandos) é a fonte de verdade; capacidades mais ricas (LSP, breakpoints, streaming)
  são trazidas à medida que cada pane/vista é ligado. Os módulos antigos ficam como referência.
