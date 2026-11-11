//! Modelo do **modo de aprendizado guiado** (cursos para principiantes).
//!
//! Um [`Course`] é uma trilha para iniciantes, organizada em [`Unit`]s; cada
//! unidade tem [`Step`]s **em ordem**, de três tipos (campo `kind`):
//!
//! - **concept** — uma explicação (markdown) a ler;
//! - **drill** — musculação *type-along*: o aluno reescreve um programa Rust
//!   COMPLETO (`target`) e, quando bate certo, executa-se;
//! - **challenge** — aplicar: implementar uma função e ser julgado pelos **testes**
//!   (reusa o avaliador existente `tutor_eval::assess`), mantendo o princípio de
//!   **honestidade** (a correcção é dos testes, não de heurística).
//!
//! # Desenho TOML-friendly
//!
//! O [`Step`] é **achatado**: um campo `kind` (string) + campos *opcionais* por
//! tipo, todos `#[serde(default)]`. Evita de propósito o par
//! *internally-tagged enum* + `flatten` do serde (que não casa bem com o parser
//! TOML de arrays-de-tabelas). Assim cada passo é só uma `[[unit.step]]` com os
//! campos que o seu tipo precisa.

use serde::Deserialize;

use crate::model::{Gabarito, Level, Phase};

/// Uma trilha de aprendizado guiado numa linguagem, para principiantes.
#[derive(Debug, Clone, Deserialize)]
pub struct Course {
    pub id: String,
    pub language: String,
    pub title: String,
    /// Nível pedagógico do curso em texto livre (ex.: `"beginner"`). É puramente
    /// de apresentação — os passos `challenge` recebem um [`Level`] tipado via
    /// [`Step::as_phase`].
    pub level: String,
    pub summary: String,
    #[serde(rename = "unit")]
    pub units: Vec<Unit>,
}

impl Course {
    /// Procura um passo pelo seu `id`, percorrendo todas as unidades.
    pub fn step(&self, id: &str) -> Option<&Step> {
        self.units
            .iter()
            .flat_map(|u| u.steps.iter())
            .find(|s| s.id == id)
    }
}

/// Uma unidade do curso: uma introdução e uma lista ordenada de passos.
#[derive(Debug, Clone, Deserialize)]
pub struct Unit {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub intro: String,
    /// Dificuldade crescente (0 = sem marca). Puramente de apresentação — o
    /// frontend pode usá-la para desenhar uma escala. `#[serde(default)]` para o
    /// conteúdo que ainda não a declara.
    #[serde(default)]
    pub difficulty: u8,
    /// Nível pedagógico da unidade: `"basic"` | `"intermediate"` | `"advanced"`.
    /// Permite organizar e filtrar a trilha por nível. `#[serde(default = ...)]`
    /// devolve `"basic"` para o conteúdo que ainda não o declara.
    #[serde(default = "default_unit_level")]
    pub level: String,
    #[serde(rename = "step")]
    pub steps: Vec<Step>,
}

/// Default da [`Unit::level`]: a unidade conta como básica quando o TOML não
/// declara o nível.
fn default_unit_level() -> String {
    "basic".to_string()
}

/// O tipo de um [`Step`]. Serializa como `"concept"`/`"drill"`/`"challenge"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    Concept,
    Drill,
    Challenge,
}

/// Um passo do curso — achatado: `kind` + campos opcionais por tipo.
///
/// Que campos cada tipo usa:
/// - `concept` → `body` (markdown).
/// - `drill` → `prompt` (o quê/porquê), `target` (o programa Rust COMPLETO a
///   reescrever) e `explanation` (mostrado depois de correr).
/// - `challenge` → `instructions`, `entry` (nome da função), `starter` e, ocultos
///   do aluno, `tests` + `gabarito` (consumidos por [`Step::as_phase`]).
#[derive(Debug, Clone, Deserialize)]
pub struct Step {
    pub kind: StepKind,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub points: u32,
    /// Briefing pedagógico (markdown) mostrado ANTES do exercício: explica, em
    /// linguagem de ciência da computação, como a computação resolve este
    /// problema. Preenchido para todos os tipos de passo. `#[serde(default)]`
    /// para o conteúdo antigo que ainda não o traz.
    #[serde(default)]
    pub intro: String,
    /// Dificuldade crescente do passo (0 = sem marca). Apresentação apenas.
    #[serde(default)]
    pub difficulty: u8,

    // ── concept ──────────────────────────────────────────────────────────────
    /// Explicação em markdown (passos `concept`).
    #[serde(default)]
    pub body: String,

    // ── drill ────────────────────────────────────────────────────────────────
    /// O quê/porquê do drill, em markdown (passos `drill`).
    #[serde(default)]
    pub prompt: String,
    /// O programa Rust COMPLETO e executável a reescrever (passos `drill`).
    #[serde(default)]
    pub target: String,
    /// Texto mostrado depois de o drill correr (passos `drill`).
    #[serde(default)]
    pub explanation: String,
    /// Explicação **linha-a-linha** do `target` (passos `drill`). Alinhada por
    /// índice às linhas do `target`: `line_comments[i]` comenta a i-ésima linha de
    /// `target.split('\n')`. Linhas em branco no meio recebem `""` para manter o
    /// alinhamento; a linha vazia final (do `\n` terminal) fica sem entrada. Vazio
    /// quando o passo não traz comentários por linha.
    #[serde(default)]
    pub line_comments: Vec<String>,
    /// Política de revelação do placeholder/alvo: `"shown"` (unidades básicas: o
    /// alvo aparece logo) ou `"on_demand"` (unidades avançadas: escondido até o
    /// aluno pedir *Show placeholder*). Default `"shown"`.
    #[serde(default = "default_placeholder_policy")]
    pub placeholder_policy: String,

    // ── package manager teaching (display only) ───────────────────────────────
    /// Shell commands shown to the student to install the external packages this
    /// exercise depends on (e.g. `["go get github.com/google/uuid"]`). Empty when
    /// the exercise needs only the standard library. These are for TEACHING/display
    /// — the evaluator resolves modules on its own (`go mod tidy`); they show the
    /// learner how the package manager works.
    #[serde(default)]
    pub install_commands: Vec<String>,
    /// Shell command shown to the student to run this exercise on the CLI (e.g.
    /// `"go run ."` or `"go test ./..."`). Empty when not applicable. Display only.
    #[serde(default)]
    pub run_command: String,

    // ── challenge ────────────────────────────────────────────────────────────
    /// Instruções em markdown (passos `challenge`).
    #[serde(default)]
    pub instructions: String,
    /// Nome da função a implementar (passos `challenge`).
    #[serde(default)]
    pub entry: String,
    /// Código inicial com `todo!` (passos `challenge`).
    #[serde(default)]
    pub starter: String,
    /// Testes ocultos que julgam a correcção (passos `challenge`). **Não** são
    /// expostos ao aluno — a honestidade exige que a verdade fique escondida.
    #[serde(default)]
    pub tests: String,
    /// Solução de referência e complexidade curada (passos `challenge`).
    pub gabarito: Option<Gabarito>,
    /// Extra Cargo dependencies for the student crate (Rust) this step needs, as
    /// raw `[dependencies]` lines — e.g. `rusqlite = { version = "0.31", features
    /// = ["bundled"] }`. Empty for std-only steps. For Go the evaluator resolves
    /// imports with `go mod tidy`, so this stays empty there. Unlike
    /// `install_commands` (display/teaching only), these are actually written into
    /// the scaffolded `Cargo.toml` so drills and challenges compile.
    #[serde(default)]
    pub dependencies: Vec<String>,
}

impl Step {
    /// Constrói um [`Phase`] equivalente a este passo `challenge`, para reusar o
    /// avaliador existente (`tutor_eval::assess`). Devolve `None` quando o passo
    /// não é um `challenge` ou lhe falta o `gabarito`.
    ///
    /// O passo guiado não cronometra complexidade, por isso o [`Phase`] resultante
    /// não tem sonda (`probe = None`) — a avaliação resume-se à correcção pelos
    /// testes, que é o que o modo guiado precisa.
    pub fn as_phase(&self, language: &str, level: Level) -> Option<Phase> {
        if self.kind != StepKind::Challenge {
            return None;
        }
        let gabarito = self.gabarito.clone()?;
        Some(Phase {
            id: self.id.clone(),
            title: self.title.clone(),
            level,
            language: language.to_string(),
            instructions: self.instructions.clone(),
            entry: self.entry.clone(),
            starter: self.starter.clone(),
            tests: self.tests.clone(),
            gabarito,
            probe: None,
            dependencies: self.dependencies.clone(),
        })
    }
}

/// Default da [`Step::placeholder_policy`]: o placeholder aparece de imediato.
fn default_placeholder_policy() -> String {
    "shown".to_string()
}

const RUST_BEGINNER: &str = include_str!("../content/rust-beginner.toml");
const GO_BASICS: &str = include_str!("../content/go-basics.toml");

/// Todos os cursos guiados embebidos no binário.
pub fn builtin_courses() -> Vec<Course> {
    vec![
        parse("rust-beginner", RUST_BEGINNER),
        parse("go-basics", GO_BASICS),
    ]
}

/// Carrega um curso guiado pelo seu `id`.
pub fn load_course(id: &str) -> Option<Course> {
    builtin_courses().into_iter().find(|c| c.id == id)
}

fn parse(name: &str, raw: &str) -> Course {
    toml::from_str(raw).unwrap_or_else(|e| panic!("curso inválido em {name}.toml: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_beginner_parseia_com_a_forma_esperada() {
        let course = load_course("rust-beginner").expect("curso rust-beginner");
        assert_eq!(course.id, "rust-beginner");
        assert_eq!(course.language, "rust");
        assert_eq!(course.level, "beginner");
        assert!(!course.title.trim().is_empty());

        // Curso sério: 9 unidades de fundação + o track avançado de sistema de
        // tipos (7 unidades) + o track avançado de concorrência (4 unidades), de
        // dificuldade crescente.
        assert!(
            course.units.len() >= 20,
            "esperadas >= 20 unidades (9 fundação + 7 tipos + 4 concorrência), vieram {}",
            course.units.len()
        );

        // Os tracks avançados (sistema de tipos + concorrência) existem, com as
        // suas unidades esperadas, na ordem de dificuldade crescente.
        let advanced_ids = [
            "u10-traits",
            "u11-generics",
            "u12-trait-bounds",
            "u13-associated-types",
            "u14-dispatch",
            "u15-lifetimes",
            "u16-send-sync",
            "u17-threads",
            "u18-channels",
            "u19-shared-state",
            "u20-parallelism",
        ];
        for id in advanced_ids {
            let unit = course
                .units
                .iter()
                .find(|u| u.id == id)
                .unwrap_or_else(|| panic!("unidade avançada {id} em falta"));
            // Todo o track avançado esconde o placeholder até o aluno pedir.
            for drill in unit.steps.iter().filter(|s| s.kind == StepKind::Drill) {
                assert_eq!(
                    drill.placeholder_policy, "on_demand",
                    "drill {} do track avançado devia ser on_demand",
                    drill.id
                );
            }
            // Cada unidade avançada tem dificuldade >= 10 (segue a numeração).
            assert!(
                unit.difficulty >= 10,
                "unidade avançada {id} devia ter difficulty >= 10, tem {}",
                unit.difficulty
            );
        }

        for unit in &course.units {
            // Cada unidade começa num concept, tem >= 2 drills e termina num challenge.
            let concepts = unit.steps.iter().filter(|s| s.kind == StepKind::Concept).count();
            let drills = unit.steps.iter().filter(|s| s.kind == StepKind::Drill).count();
            let challenges = unit.steps.iter().filter(|s| s.kind == StepKind::Challenge).count();
            assert_eq!(concepts, 1, "unidade {} devia ter 1 concept", unit.id);
            assert!(drills >= 2, "unidade {} devia ter >= 2 drills", unit.id);
            assert_eq!(challenges, 1, "unidade {} devia ter 1 challenge", unit.id);

            assert_eq!(unit.steps.first().map(|s| s.kind), Some(StepKind::Concept));
            assert_eq!(unit.steps.last().map(|s| s.kind), Some(StepKind::Challenge));

            // Cada drill é um programa Rust completo com line_comments alinhados às
            // suas linhas (uma entrada por linha até à última linha com código).
            for drill in unit.steps.iter().filter(|s| s.kind == StepKind::Drill) {
                assert!(
                    drill.target.contains("fn main"),
                    "drill {} sem fn main no target",
                    drill.id
                );
                assert!(
                    !drill.line_comments.is_empty(),
                    "drill {} sem line_comments",
                    drill.id
                );
                let target_lines: Vec<&str> = drill.target.split('\n').collect();
                assert!(
                    drill.line_comments.len() <= target_lines.len(),
                    "drill {}: {} comentários para {} linhas (desalinhado)",
                    drill.id,
                    drill.line_comments.len(),
                    target_lines.len()
                );
                // Alinhamento REAL linha-a-linha: `line_comments[i]` comenta a
                // i-ésima linha do `target`. Uma linha de código (não-vazia) exige
                // um comentário não-vazio; uma linha em branco exige entrada vazia.
                // Apanha a deriva de índice quando uma linha de código fica sem
                // comentário e desloca todos os seguintes.
                for (i, comment) in drill.line_comments.iter().enumerate() {
                    let code_is_blank = target_lines[i].trim().is_empty();
                    let comment_is_blank = comment.trim().is_empty();
                    assert_eq!(
                        code_is_blank, comment_is_blank,
                        "drill {}: line_comments[{}] desalinhado — linha {:?} vs comentário {:?}",
                        drill.id, i, target_lines[i], comment
                    );
                }
                // A política de placeholder é sempre uma das duas conhecidas.
                assert!(
                    drill.placeholder_policy == "shown" || drill.placeholder_policy == "on_demand",
                    "drill {}: placeholder_policy inesperada {:?}",
                    drill.id,
                    drill.placeholder_policy
                );
            }

            // O challenge da unidade vira um Phase utilizável pelo avaliador.
            let challenge = unit
                .steps
                .iter()
                .find(|s| s.kind == StepKind::Challenge)
                .expect("passo challenge");
            assert!(
                !challenge.tests.trim().is_empty(),
                "challenge {} sem testes",
                challenge.id
            );
            assert!(!challenge.entry.trim().is_empty(), "challenge {} sem entry", challenge.id);
            let phase = challenge
                .as_phase(&course.language, Level::Basico)
                .unwrap_or_else(|| panic!("challenge {} devia virar Phase", challenge.id));
            assert_eq!(phase.entry, challenge.entry);
            assert_eq!(phase.language, "rust");
            assert!(
                !phase.gabarito.solution.trim().is_empty(),
                "challenge {} sem gabarito",
                challenge.id
            );
        }

        // A dificuldade das unidades é não-decrescente (progressão pedagógica).
        for pair in course.units.windows(2) {
            assert!(
                pair[1].difficulty >= pair[0].difficulty,
                "dificuldade devia ser crescente: {} ({}) antes de {} ({})",
                pair[0].id,
                pair[0].difficulty,
                pair[1].id,
                pair[1].difficulty
            );
        }

        // O nível pedagógico é não-decrescente ao longo da trilha: nunca se volta
        // de advanced para intermediate, nem de intermediate para basic. Garante o
        // ramp limpo basic → intermediate → advanced.
        fn level_rank(level: &str) -> u8 {
            match level {
                "basic" => 0,
                "intermediate" => 1,
                "advanced" => 2,
                other => panic!("nível inesperado {other:?}"),
            }
        }
        for pair in course.units.windows(2) {
            assert!(
                level_rank(&pair[1].level) >= level_rank(&pair[0].level),
                "nível devia ser não-decrescente: {} ({}) antes de {} ({})",
                pair[0].id,
                pair[0].level,
                pair[1].id,
                pair[1].level
            );
        }

        // Política de placeholder: a 1ª unidade é "shown"; a última é "on_demand".
        let first_drill = course.units[0]
            .steps
            .iter()
            .find(|s| s.kind == StepKind::Drill)
            .expect("1ª unidade tem drill");
        assert_eq!(first_drill.placeholder_policy, "shown");
        let last_drill = course
            .units
            .last()
            .unwrap()
            .steps
            .iter()
            .find(|s| s.kind == StepKind::Drill)
            .expect("última unidade tem drill");
        assert_eq!(last_drill.placeholder_policy, "on_demand");

        // Default da política é "shown" quando o TOML não a declara.
        assert_eq!(default_placeholder_policy(), "shown");

        // Cada unidade traz um nível válido e os três níveis estão representados.
        let mut has_basic = false;
        let mut has_intermediate = false;
        let mut has_advanced = false;
        for unit in &course.units {
            assert!(
                matches!(unit.level.as_str(), "basic" | "intermediate" | "advanced"),
                "unidade {} com nível inválido {:?}",
                unit.id,
                unit.level
            );
            match unit.level.as_str() {
                "basic" => has_basic = true,
                "intermediate" => has_intermediate = true,
                "advanced" => has_advanced = true,
                _ => {}
            }
        }
        assert!(
            has_basic && has_intermediate && has_advanced,
            "os três níveis (basic/intermediate/advanced) deviam estar representados"
        );
        // Default do nível de unidade é "basic" quando o TOML não o declara.
        assert_eq!(default_unit_level(), "basic");

        // Um passo não-challenge não produz Phase.
        assert!(course.units[0].steps[0].as_phase("rust", Level::Basico).is_none());
    }

    #[test]
    fn go_basics_parseia_com_a_forma_esperada() {
        let course = load_course("go-basics").expect("curso go-basics");
        assert_eq!(course.id, "go-basics");
        assert_eq!(course.language, "go");
        assert!(!course.title.trim().is_empty());

        // get_course("go") (via linguagem) encontra o curso Go.
        let by_lang = builtin_courses()
            .into_iter()
            .find(|c| c.language.eq_ignore_ascii_case("go"))
            .expect("curso para a linguagem go");
        assert_eq!(by_lang.id, "go-basics");

        // Curso basic→intermediate→advanced: 10 unidades de fundação + o track
        // avançado de concorrência (4 unidades) + o track de estruturas de dados e
        // algoritmos (6 unidades), de dificuldade crescente.
        assert!(
            course.units.len() >= 20,
            "esperadas ao menos 20 unidades (10 fundação + 4 concorrência + 6 DSA), vieram {}",
            course.units.len()
        );

        // O track avançado de concorrência existe, com as suas unidades esperadas,
        // na ordem de dificuldade crescente.
        let advanced_ids = [
            "u11-goroutines-waitgroup",
            "u12-channels",
            "u13-select-timeouts",
            "u14-shared-state",
        ];
        for (offset, id) in advanced_ids.iter().enumerate() {
            let unit = course
                .units
                .iter()
                .find(|u| u.id == *id)
                .unwrap_or_else(|| panic!("unidade avançada {id} em falta"));
            assert_eq!(unit.level, "advanced", "unidade {id} devia ser advanced");
            // A numeração/dificuldade segue: u11→11, u12→12, u13→13, u14→14.
            assert_eq!(
                unit.difficulty as usize,
                11 + offset,
                "unidade avançada {id} devia ter difficulty {}",
                11 + offset
            );
            // Todo o track avançado esconde o placeholder até o aluno pedir.
            for drill in unit.steps.iter().filter(|s| s.kind == StepKind::Drill) {
                assert_eq!(
                    drill.placeholder_policy, "on_demand",
                    "drill {} do track avançado devia ser on_demand",
                    drill.id
                );
            }
        }

        for unit in &course.units {
            // Cada unidade: 1 concept primeiro, >= 2 drills, 1 challenge por último.
            let concepts = unit.steps.iter().filter(|s| s.kind == StepKind::Concept).count();
            let drills = unit.steps.iter().filter(|s| s.kind == StepKind::Drill).count();
            let challenges = unit.steps.iter().filter(|s| s.kind == StepKind::Challenge).count();
            assert_eq!(concepts, 1, "unidade {} devia ter 1 concept", unit.id);
            assert!(drills >= 2, "unidade {} devia ter >= 2 drills", unit.id);
            assert_eq!(challenges, 1, "unidade {} devia ter 1 challenge", unit.id);
            assert_eq!(unit.steps.first().map(|s| s.kind), Some(StepKind::Concept));
            assert_eq!(unit.steps.last().map(|s| s.kind), Some(StepKind::Challenge));

            // Nível válido.
            assert!(
                matches!(unit.level.as_str(), "basic" | "intermediate" | "advanced"),
                "unidade {} com nível inesperado {:?}",
                unit.id,
                unit.level
            );

            // Cada drill é um programa Go COMPLETO (`func main`) com line_comments
            // alinhados linha-a-linha e um run_command de exibição.
            for drill in unit.steps.iter().filter(|s| s.kind == StepKind::Drill) {
                assert!(
                    drill.target.contains("func main"),
                    "drill {} sem `func main` no target",
                    drill.id
                );
                assert!(
                    drill.target.contains("package main"),
                    "drill {} sem `package main` no target",
                    drill.id
                );
                assert!(!drill.line_comments.is_empty(), "drill {} sem line_comments", drill.id);
                assert_eq!(
                    drill.run_command, "go run .",
                    "drill {} devia correr com `go run .`",
                    drill.id
                );

                let target_lines: Vec<&str> = drill.target.split('\n').collect();
                assert!(
                    drill.line_comments.len() <= target_lines.len(),
                    "drill {}: {} comentários para {} linhas (desalinhado)",
                    drill.id,
                    drill.line_comments.len(),
                    target_lines.len()
                );
                // Alinhamento REAL linha-a-linha: linha de código ↔ comentário não
                // vazio; linha em branco ↔ comentário vazio.
                for (i, comment) in drill.line_comments.iter().enumerate() {
                    let code_is_blank = target_lines[i].trim().is_empty();
                    let comment_is_blank = comment.trim().is_empty();
                    assert_eq!(
                        code_is_blank, comment_is_blank,
                        "drill {}: line_comments[{}] desalinhado — linha {:?} vs comentário {:?}",
                        drill.id, i, target_lines[i], comment
                    );
                }
                assert!(
                    drill.placeholder_policy == "shown" || drill.placeholder_policy == "on_demand",
                    "drill {}: placeholder_policy inesperada {:?}",
                    drill.id,
                    drill.placeholder_policy
                );
            }

            // O challenge vira um Phase utilizável, com testes Go (`package student`
            // + `testing`) e gabarito.
            let challenge = unit
                .steps
                .iter()
                .find(|s| s.kind == StepKind::Challenge)
                .expect("passo challenge");
            assert!(!challenge.entry.trim().is_empty(), "challenge {} sem entry", challenge.id);
            assert_eq!(
                challenge.run_command, "go test ./...",
                "challenge {} devia correr com `go test ./...`",
                challenge.id
            );
            assert!(
                challenge.tests.contains("package student"),
                "challenge {}: testes sem `package student`",
                challenge.id
            );
            assert!(
                challenge.tests.contains("testing"),
                "challenge {}: testes sem `import \"testing\"`",
                challenge.id
            );
            assert!(
                challenge.tests.contains("func Test"),
                "challenge {}: testes sem `func TestXxx`",
                challenge.id
            );
            let phase = challenge
                .as_phase(&course.language, Level::Basico)
                .unwrap_or_else(|| panic!("challenge {} devia virar Phase", challenge.id));
            assert_eq!(phase.entry, challenge.entry);
            assert_eq!(phase.language, "go");
            assert!(
                !phase.gabarito.solution.trim().is_empty(),
                "challenge {} sem gabarito",
                challenge.id
            );
            assert!(
                phase.gabarito.solution.contains("package student"),
                "challenge {}: gabarito sem `package student`",
                challenge.id
            );
        }

        // Dificuldade e nível não-decrescentes (ramp basic → intermediate).
        fn level_rank(level: &str) -> u8 {
            match level {
                "basic" => 0,
                "intermediate" => 1,
                "advanced" => 2,
                other => panic!("nível inesperado {other:?}"),
            }
        }
        for pair in course.units.windows(2) {
            assert!(
                pair[1].difficulty >= pair[0].difficulty,
                "dificuldade devia ser não-decrescente: {} antes de {}",
                pair[0].id,
                pair[1].id
            );
            assert!(
                level_rank(&pair[1].level) >= level_rank(&pair[0].level),
                "nível devia ser não-decrescente: {} antes de {}",
                pair[0].id,
                pair[1].id
            );
        }

        // Os três níveis estão representados (basic, intermediate e advanced).
        assert!(course.units.iter().any(|u| u.level == "basic"), "falta nível basic");
        assert!(
            course.units.iter().any(|u| u.level == "intermediate"),
            "falta nível intermediate"
        );
        assert!(
            course.units.iter().any(|u| u.level == "advanced"),
            "falta nível advanced (track de concorrência)"
        );

        // Ensino do gestor de pacotes: >= 1 drill com install_commands `go get` e
        // run_command `go run .`; os passos std-puros ficam sem install_commands.
        let pkg_drills: Vec<&Step> = course
            .units
            .iter()
            .flat_map(|u| u.steps.iter())
            .filter(|s| s.kind == StepKind::Drill && !s.install_commands.is_empty())
            .collect();
        assert!(
            pkg_drills.len() >= 1,
            "devia haver >= 1 exercício que ensina `go get`, vieram {}",
            pkg_drills.len()
        );
        for drill in &pkg_drills {
            assert!(
                drill.install_commands.iter().any(|c| c.starts_with("go get ")),
                "drill {}: install_commands devia conter um `go get`",
                drill.id
            );
            assert_eq!(drill.run_command, "go run .");
        }

        // Concepts não trazem campos de pacote nem run_command.
        for concept in course
            .units
            .iter()
            .flat_map(|u| u.steps.iter())
            .filter(|s| s.kind == StepKind::Concept)
        {
            assert!(concept.run_command.is_empty(), "concept {} com run_command", concept.id);
            assert!(
                concept.install_commands.is_empty(),
                "concept {} com install_commands",
                concept.id
            );
        }

        // Defaults dos campos novos: vazios quando o TOML não os declara.
        let probe: Step = toml::from_str(
            "kind='drill'\nid='x'\ntitle='t'\ntarget='package main\\nfunc main(){}'",
        )
        .expect("step mínimo");
        assert!(probe.install_commands.is_empty());
        assert!(probe.run_command.is_empty());
    }
}
