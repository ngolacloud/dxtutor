# dxtutor

Um **tutor de programação guiado** e uma **IDE de código**, em Rust. Em *Estudo
Guiado* conduz o aluno de linguagem e objectivo pelas fases de um currículo — um
desafio por fase e, ao resolver, o **gabarito**: a solução de referência com a
análise de complexidade. Em *Projecto* abre um repositório real, navega entre
símbolos, corre testes, revê código offline e pode delegar edições com controlo.

O aluno escreve sempre a implementação final. O percurso essencial funciona
offline; a IA é opcional.

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

## Estrutura

| Crate / pasta       | Papel                                                                |
|---------------------|----------------------------------------------------------------------|
| `tutor-core`        | Modelo de domínio + conteúdo curado (cursos/fases, glossário, guias).|
| `tutor-eval`        | Avaliador (`cargo test` isolado), sonda de complexidade, **review** (analisadores offline + identidade de correcção), CodeMap. |
| `tutor-llm`         | Fornecedores de dica/plano/correcção, chat (Dev Assistant), **`policy`**. |
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
