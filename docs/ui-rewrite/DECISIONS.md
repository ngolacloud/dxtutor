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
- 2026-11-13 — **Vistas do workspace reescritas de raiz** sobre os comandos Tauri reais, em vez de
  portar os módulos antigos (`workspace.ts`/`git.ts`/… acoplados ao DOM antigo de overlays). O
  backend (97 comandos) é a fonte de verdade; capacidades mais ricas (LSP, breakpoints, streaming)
  são trazidas à medida que cada pane/vista é ligado. Os módulos antigos ficam como referência.
