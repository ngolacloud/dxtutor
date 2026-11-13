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
- 2026-11-13 — **Vistas do workspace reescritas de raiz** sobre os comandos Tauri reais, em vez de
  portar os módulos antigos (`workspace.ts`/`git.ts`/… acoplados ao DOM antigo de overlays). O
  backend (97 comandos) é a fonte de verdade; capacidades mais ricas (LSP, breakpoints, streaming)
  são trazidas à medida que cada pane/vista é ligado. Os módulos antigos ficam como referência.
