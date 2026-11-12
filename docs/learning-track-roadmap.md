# Learning Track universitário — roteiro (RF-LT-01…06)

Estende o tutor (trilha linear de fases) para o que uma **instituição** precisa: competências
com pré-requisitos, unidades, evidência de domínio honesta, autoria docente e continuidade
institucional. Aditivo — o percurso individual existente continua a funcionar.

## ADR-LT-001 — Modelo de competências + CS2023 (RF-LT-01) · FEITO

**Decisão.** Um módulo `tutor-core::curriculum` (carregável de TOML, como o resto do conteúdo)
com:

- `Competency { id, title, description, cs2023: Vec<String> }` — resultado de aprendizagem
  mapeado a áreas de conhecimento do **CS2023** (ACM/IEEE) por código (ex.: `AL`, `AR`, `SE`,
  `SDF`). O docente escolhe os códigos; o modelo não os fecha.
- `Unit { id, title, objective, prerequisites, develops, activity, evidence }` — pré-requisitos
  e competências desenvolvidas são **ids de competência**; `activity` referencia uma fase/lab.
- `EvidenceKind { Tests, Measurement, Simulation, Proof }` — preserva o **contrato de
  honestidade**: uma medição empírica NÃO é prova; uma simulação observa um modelo; só `Proof`
  é demonstração matemática.
- `Program { ComputerScience, ComputerEngineering, SoftwareEngineering }` — o currículo adapta-se.
- `Curriculum::next_unit(mastered)` — a próxima actividade disponível (pré-requisitos
  satisfeitos) e ainda não concluída; `progress()` separa dominado/em-falta («mostrar ao aluno o
  que já domina»).

**Porquê.** Separa o *grafo* de aprendizagem (competências/pré-requisitos) do *conteúdo* (fases),
para o docente desenhar progressão e mapear a CS2023 sem tocar nos desafios. Testes:
`next_unit_respects_prerequisites_and_completion`, `evidence_distinguishes_measurement_from_proof`.

## Próximos

- **RF-LT-03 — três labs-piloto** (CS: comparar algoritmos/explicar custo = `Measurement`; CE:
  prever/observar acessos à memória num tracer declarado = `Simulation`; SE: reproduzir uma
  regressão, corrigir e justificar o teste = `Tests`). Cada um: enunciado, ambiente
  reproduzível, teste/medição, rubrica e pergunta de transferência. Vertical do autor ao aluno.
- **RF-LT-04 — autoria docente**: pré-visualização como aluno, versionamento, publicação por
  turma, rubrica; separar testes públicos / de avaliação / solução de referência (o gabarito já
  só viaja após os testes passarem — manter para avaliação reservada).
- **RF-LT-05 — registo**: tentativa/versão/competência/pistas/resultado/feedback; padrões de
  turma para o docente; progresso para o aluno; privacidade (um aluno não vê registos de outro).
- **RF-LT-06 — institucional**: identidade aluno/docente, turmas, exportação, sync idempotente ao
  recuperar ligação; distinguir prática offline de avaliação institucional supervisionada.

Estes dependem de um serviço (identidade/turmas/sync) fora do âmbito local-only do tutor actual —
será um crate/back-end próprio (candidato a reutilizar DORM/Seiva do ecossistema NgolaCloud).
