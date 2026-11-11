# dxtutor

Um **editor de texto-tutor** em Rust. Quando começas um projecto numa linguagem,
o editor funciona como preceptor: conduz-te do básico ao avançado em fases, dá-te
um desafio por fase, e — quando resolves — mostra o **gabarito**: a solução de
referência com a análise de complexidade algorítmica e matemática.

## Princípio de honestidade

Inferir a complexidade (Big-O) de código arbitrário é **indecidível** em geral
(reduz ao problema da paragem). Por isso:

- **A correcção é julgada por testes**, nunca por um modelo de linguagem.
- **A complexidade de referência vive atada ao gabarito curado** (provada por quem
  o escreveu), não adivinhada do código do aluno.
- **Ao código do aluno medimos a complexidade empiricamente**: corremos a solução
  em entradas de tamanho crescente, cronometramos, e ajustamos a curva. Dizemos
  «o teu comportamento parece ~O(n²); o óptimo é O(n log n)» — honesto, sem fingir
  uma prova.
- Uma camada de LLM (opcional) só dá **dicas e feedback de estilo**, nunca é juiz.

## Estrutura

| Crate         | Papel                                                              |
|---------------|-------------------------------------------------------------------|
| `tutor-core`  | Modelo de domínio + banco de conteúdo curado (projectos/fases).   |
| `tutor-eval`  | Avaliador: *runner* `cargo test` isolado + sonda de complexidade. |
| `tutor-cli`   | Demo de prova ponta-a-ponta do cérebro.                           |
| `tutor-tui`   | *(próximo)* Editor TUI (`ratatui`) — a casca.                     |

## Demo

```bash
cargo run -p tutor-cli -- demo
```

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
