# PLAN — reescrita da UI do dxtutor a partir do protótipo

Fonte de verdade visual: `docs/prototype/index.html` (protótipo navegável, single-file).
Fonte de verdade de comportamento: comandos Tauri (`desktop/src-tauri/`) + crates `tutor-*`.

## Arquitectura-alvo (do protótipo)

A casca do protótipo é um grid de três linhas: **titlebar (34px) / mid (1fr) / status (24px)**.
`mid` é um grid de quatro colunas: **activity (48px) / side (var `--side-w`) / edit (1fr) / agent (var `--agent-w`)**.

Difere da casca actual (que é dual-mode `learning|workspace` + overlays). O alvo unifica em:

- **Uma `side`** com *panes* permutáveis (`setPane`): explorer, search, scm, run, test, ext, codev, tutor (Learning Track), remote, containers, account.
- **Uma `edit`** com um *router de vistas por `kind` de separador* (`VIEW[kind]`):
  `file, diff, agent, welcome, settings, manager, analysis, graph, team, studio, board, learn, lt`.
- **Um dock `agent`** (Co-Dev) à direita, destacável para separador central.
- **Um `panel`** inferior com abas: terminal, problems, output, services.
- **Uma `status`** bar.
- **Command palette** (`F1`/`Ctrl+Shift+P`) com prefixos `>` (comandos), `:` (linha), sem prefixo (quick-open), e modo *input*.
- **3 temas** (Grafite laranja default, Slate índigo, Papel claro) por variáveis CSS.
- **i18n** via `desktop/src/i18n.ts` existente (EN fonte, ptAO fallback→EN); texto novo = chave nova.

### Princípio de implementação

O **chrome** do protótipo (activity bar, panes, router de vistas, palette, panel, status, temas,
menus) é portado para TS/CSS reais. As **simulações** do protótipo (FS/git/terminal/LSP/debug/
cursos/i18n-por-DOM em JS) **não** são portadas — ligam-se aos 97 comandos Tauri e aos crates.
O editor é **Monaco**, não o textarea do protótipo.

O que não estiver ligado numa fase fica **visível mas desactivado** com «not implemented yet» e
entrada em `PENDING.md`. Nunca dados inventados como reais. Push/destrutivo exigem aprovação.

## Fases (um commit convencional por fase; verificação no fim de cada)

1. **Casca** — grid titlebar/mid/status; activity bar; side+panes (vazios/placeholder); edit+router
   de vistas (welcome real); agent dock; panel (terminal real via pty, resto placeholder); status;
   palette; atalhos; 3 temas; menus. Tokens CSS do protótipo.
2. **Paridade** — ligar tudo o que já existe à nova casca: explorer (fsops), editor Monaco multi-aba,
   search, SCM + grafo (git.ts), run & debug (debug.ts), testes (tests.ts), remote/containers
   (remote.ts), explain (explain.ts), review (review.ts), quick open (quickopen.ts), assistant +
   orquestração (assistant.ts), codemap, edição ancorada (edit/patch), arch. Inventário em `PARITY.md`.
3. **Learning Track** — onboarding linguagem/nível, árvore de unidades com estrelas, LEARN/DRILL/APPLY,
   pontos e bloqueio, vista de passo (editor+resultados), Under the hood, Continue. Sobre `tutor-core`/
   `get_course`/`submit_step`/`request_hint`; progresso (localStorage; `tutor-track` fica em PENDING se
   não ligado).
4. **Co-Dev** — modos Manual/Assistido/Auto com a matriz de política (de `policy.rs`), conselho de
   modelos com juiz, auto-avaliação com limiar+correcção, checkpoints, registo de decisões, gestor de
   missões. Sobre `assistant.ts`/providers.
5. **Equipa** — vários assistentes com harness (paths/comandos/limite de ficheiros) aplicado no backend
   em cada chamada de ferramenta; router de modelos sobre `tutor-llm`, provedores Claude/Gemini/Codex/
   Ollama.
6. **Gitflow** — fluxo guiado feature/fix/release/hotfix sobre o git real (git.ts/crate `git`).
7. **Studio** — catálogo de tecnologias por cloud, validação do desenho (`arch_validate`), geração de
   backlog e sprints, kanban com teste automático ao entrar em «Teste» e validação funcional humana.
8. **Artefactos e RUN** — geração de esqueletos/Dockerfile/compose/Makefile/.env/k8s a partir do desenho
   (`arch_scaffold`); RUN/Stop reais (`docker compose up --build` via backend); vista de serviços.

## Verificação por fase

`scripts/verify.sh` + `( cd desktop && npm run build )` (tsc+vite) + testes dos crates afectados +
inspecção visual contra o protótipo. Só então o commit. Nunca avançar com verificação a falhar.

## Entrega

`docs/ui-rewrite/REPORT.md` no fim: o feito por fase, tabela de paridade final, decisões, pendências e
comandos para correr/verificar.
