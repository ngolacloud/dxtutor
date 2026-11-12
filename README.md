# dxtutor

Um **tutor de programação guiado** e uma **IDE de código**, em Rust. Em *Estudo
Guiado* conduz o aluno de linguagem e objectivo pelas fases de um currículo — um
desafio por fase e, ao resolver, o **gabarito**: a solução de referência com a
análise de complexidade. Em *Projecto* abre um repositório real, navega entre
símbolos, corre testes, revê código offline e pode delegar edições com controlo.

O aluno escreve sempre a implementação final. O percurso essencial funciona
offline; a IA é opcional.

## O princípio do mentor

O dxtutor não é uma enciclopédia nem um gerador de respostas: é um **mentor**. Um mentor
**corta caminho** e **foca no que realmente importa**. Perante a vastidão de um tema —
arquitectura de software, infraestrutura, segurança, dados, mensageria — o papel do mentor
é destilar o percurso até ao essencial para a vida de quem aprende:

- **transformar ideias em coisas concretas** (entregar, não só saber);
- **ser competente no que faz** (domínio real, provado por evidência);
- **ganhar com isso** (a competência tem valor económico);
- **um futuro melhor para a família**;
- **uma vida mais tranquila**.

Na prática isto governa as decisões de produto: cada fase tem um **objectivo mensurável** e
uma **actividade de transferência** (aplicar a um caso inédito), não cobertura exaustiva; o
tutor **dá a próxima acção útil** (`curriculum::next_unit`) em vez de despejar matéria; a IA
**tutora** (explica, questiona, dá a pista mínima) em vez de entregar a solução; e a
honestidade abaixo garante que o atalho nunca é uma ilusão de competência.

## Princípios de honestidade (contratos)

Inferir a complexidade (Big-O) de código arbitrário é **indecidível** em geral. Por isso:

- **A correcção é julgada por testes**, nunca por um modelo. A complexidade medida ao
  aluno é uma **estimativa empírica**, rotulada como tal — nunca uma prova.
- **O gabarito só viaja no payload depois de os testes passarem.** Numa tentativa
  falhada, `gabarito` é `null` — nenhum caminho da aplicação revela a solução.
- **Em modo de estudo, as superfícies de IA tutoram** (explicam, questionam, dão
  pistas) — nunca entregam o corpo final, um patch equivalente, nem escrevem no buffer
  do aluno. A política é decidida no backend (`tutor-llm::policy`).
- **Uma revisão fica atada à revisão que analisou.** Uma correcção/marcador calculado
  sobre um buffer é recusado noutro (`content_version` + `verify_fix`), preservando as
  alterações do programador.

Os agentes de engenharia que modificam o repositório são distintos do tutor dentro da
IDE: as permissões de um não se tornam, por herança, as do outro.

## IDE de código (modo Projecto)

Em *Projecto* a casca desktop aproxima-se da experiência VSCode / Antigravity, mantendo
os contratos de honestidade acima:

- **Casca** — ecrã de boas-vindas (abrir pasta / clonar / espaços recentes), *activity bar*
  com cada ícone a abrir a sua vista, *command palette* (`Ctrl+Shift+P`), e vistas que
  **substituem a sidebar** (não flutuam).
- **Editor** — Monaco multi-aba, *go-to-definition* resolvido por LSP, CodeMap sintáctico.
- **Git** — *Source Control* real: *stage/unstage*, *commit*, troca/criação de *branch*, e um
  **grafo de commits multi-faixa** (DAG) com diff por commit.
- **Run and Debug** — *breakpoints* no *gutter* do editor: **resilientes à edição** (ancorados
  em decorações do modelo), **condicionais** (`Alt+clique`, avaliados contra as variáveis do
  passo), **persistentes** entre sessões, com um **painel** (lista / activar / remover / salto).
- **Remote / Dev Containers** — detecta/cria `devcontainer.json`, **abre no contentor** uma
  **sessão persistente** (constrói do `Dockerfile` se preciso), com **terminal interactivo**
  (PTY), *Run* e **LSP** a correr **dentro** do contentor, e um indicador na barra de estado
  para reatar.
- **Explain** — resumo de código gerado pela IA, organizado (visão geral + secção por
  símbolo), em **aba real** com **divisão lado-a-lado** código\|resumo (divisor arrastável),
  **em streaming**, para um ficheiro ou uma **pasta/módulo**. As âncoras `[L<n>]` e os saltos
  usam o **outline real** (documentSymbol via LSP → AST do Rust → heurística Py/Go/JS/TS).
- **Dev Assistant (Agent)** — focado no **projecto seleccionado**, com *templates* de *prompt*
  (`/`) que o programador preenche; assiste a intenção do *dev*, não a define. Edita por
  **bloco/método** com *diff* e **detecção de conflito** (se editas durante o *stream*, pára e
  preserva a tua alteração); **continua** ficheiros incompletos por **anexação** (sem
  reescrever); corre e **cita** os testes do projecto (comando + saída real).
- **Orquestração (observar→planear→actuar→verificar)** — o Agent emite um **plano** (`dxplan`),
  renderizado como *checklist* de progresso; **«Continue →»** conduz o passo seguinte e o
  *toggle* **Auto** encadeia-os (limitado ao nº de passos, parável com **Stop**); ao concluir,
  **auto-verifica** (corre os testes).
- **Tarefa isolada (forma cloud)** — «**Run in isolation**» executa uma proposta numa *worktree*
  descartável de HEAD e devolve um **patch** revisível — a árvore de trabalho não é tocada. A
  API `submit → status → collect` é a mesma que um *backend* remoto exporia.
- **Architecture Studio** — modela um *System Design* orientado a eventos e **valida a
  arquitectura** (*outbox* sem *relay*, evento publicado sem consumidor, subscrição órfã,
  *broker*/aresta pendurados) antes de gerar código.

## Trilha universitária (institucional)

Para além do percurso individual, o dxtutor modela o que uma **instituição** precisa:

- **Competências + CS2023** (`tutor-core::curriculum`) — competências mapeadas às áreas de
  conhecimento do **CS2023** (ACM/IEEE), unidades com pré-requisitos, e **evidência honesta**
  (`Tests` / `Measurement` / `Simulation` / `Proof` — uma medição nunca é uma prova).
  `next_unit` dá a **próxima actividade** disponível; adaptável a CS / CE / SE.
- **Labs-piloto** — três laboratórios verticais (CS: comparar algoritmos = medição; CE: padrão
  de acesso à memória = simulação; SE: reproduzir/corrigir regressão = testes), cada um com
  rubrica e pergunta de transferência.
- **Registo institucional** (`tutor-track`) — tentativas por aluno com **sincronização
  idempotente** e **privacidade** (um aluno só vê o seu), padrões de falha por turma, em
  memória ou **SQLite durável** atrás do mesmo `trait Store`.

## Estrutura

| Crate / pasta       | Papel                                                                |
|---------------------|----------------------------------------------------------------------|
| `tutor-core`        | Modelo de domínio + conteúdo curado (cursos/fases, glossário, guias), **`curriculum`** (competências/CS2023/labs). |
| `tutor-eval`        | Avaliador (`cargo test` isolado), sonda de complexidade, **review**, CodeMap, LSP, `git` (DAG + *worktree* isolada), **`arch`** (validação de System Design). |
| `tutor-llm`         | Fornecedores de dica/plano/correcção, chat (Dev Assistant), capacidades por fornecedor, **`policy`**. |
| `tutor-track`       | Registo institucional de tentativas (`Store`): sync idempotente + privacidade; `MemStore` e **`SqliteStore`**. |
| `tutor-tui`         | Editor TUI (`ratatui`).                                              |
| `tutor-cli`         | Prova ponta-a-ponta do cérebro (`dxt demo`).                         |
| `desktop/`          | Shell desktop Tauri + frontend Monaco (Estudo Guiado + Projecto).    |

## Verificação

```bash
scripts/verify.sh                 # contratos (P0) + build do frontend + testes do workspace
scripts/verify.sh --contracts-only
scripts/verify.sh --all           # + e2e com analisadores (clippy/go/ruff), se existirem
cargo run -p tutor-cli -- demo    # prova do cérebro (gabarito O(n) vs O(n²))
```

Os três contratos de confiança (fuga de solução, chat que contorna o estudo, correcção
obsoleta) estão fechados e cada um tem um teste de regressão nomeado — ver
[docs/code-intelligence-roadmap.md](docs/code-intelligence-roadmap.md) §7. O que ainda
carece de validação ao vivo (necessita de ecrã / modelo) está listado nessa secção.

## Licença

Projecto *open source* sob **dupla licença**, à convenção do ecossistema Rust:

- Apache License 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

Podes escolher qualquer uma das duas. Ambas preservam o aviso de direitos de
autor (© angolardevops / NgolaCloud): quem usa, copia ou deriva o projecto é
obrigado a manter a atribuição. A Apache-2.0 acrescenta uma concessão explícita
de patentes; a MIT é mais curta e permissiva — manter as duas dá ao utilizador a
liberdade de escolher a que melhor se encaixa no seu projecto.

Salvo indicação expressa em contrário, qualquer contribuição submetida para
inclusão neste projecto, nos termos da Apache-2.0, fica sob esta mesma dupla
licença, sem termos ou condições adicionais.
