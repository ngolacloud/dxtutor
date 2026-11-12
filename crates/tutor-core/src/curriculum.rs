//! Modelo de currículo universitário (RF-LT-01).
//!
//! Estende o [`crate::model::Project`] (uma trilha linear de fases) com a estrutura que uma
//! instituição precisa: **competências** com pré-requisitos, **unidades** que as desenvolvem,
//! e **evidência de domínio** com uma distinção *honesta* entre medição empírica, simulação e
//! prova matemática. Cada competência mapeia para áreas de conhecimento do currículo de
//! referência **CS2023** (ACM/IEEE), e o docente pode adaptar o plano aos três programas
//! (Ciência da Computação, Engenharia da Computação, Engenharia de Software).
//!
//! É aditivo: o percurso linear existente continua a funcionar; este modelo é opcional e
//! carregável de TOML como o resto do conteúdo.

use std::collections::HashSet;

use serde::Deserialize;

/// Programa universitário ao qual um currículo se adapta.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Program {
    ComputerScience,
    ComputerEngineering,
    SoftwareEngineering,
}

/// Como o domínio de uma unidade é evidenciado — mantendo o contrato de honestidade: uma
/// **medição** empírica NÃO é uma prova; uma **simulação** observa um modelo; só `Proof` é
/// uma demonstração matemática.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceKind {
    /// Correcção julgada por testes (fonte da verdade).
    Tests,
    /// Medição empírica (ex.: cronometragem, contagem de acessos) — estimativa, não prova.
    Measurement,
    /// Observação num simulador/tracer declarado.
    Simulation,
    /// Prova/derivação matemática.
    Proof,
}

/// Uma competência: um resultado de aprendizagem mapeado a áreas CS2023.
#[derive(Debug, Clone, Deserialize)]
pub struct Competency {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Áreas de conhecimento CS2023 (códigos, ex.: `"AL"`, `"AR"`, `"SE"`, `"SDF"`).
    #[serde(default)]
    pub cs2023: Vec<String>,
}

/// Uma unidade de ensino: objectivo, pré-requisitos (competências que exige), competências
/// que desenvolve, actividade/laboratório e evidência de domínio.
#[derive(Debug, Clone, Deserialize)]
pub struct Unit {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub objective: String,
    /// Competências que o aluno deve já dominar para abrir esta unidade.
    #[serde(default)]
    pub prerequisites: Vec<String>,
    /// Competências que esta unidade desenvolve (ganhas ao concluir).
    #[serde(default)]
    pub develops: Vec<String>,
    /// Referência ao laboratório/actividade (ex.: `id` de uma fase ou de um lab).
    #[serde(default)]
    pub activity: String,
    pub evidence: EvidenceKind,
    /// Critérios de avaliação (rubrica) — o que conta para o domínio.
    #[serde(default)]
    pub rubric: Vec<String>,
    /// Pergunta de transferência: aplicar o aprendido a um caso inédito.
    #[serde(default)]
    pub transfer: String,
}

/// Um currículo completo adaptável a um programa.
#[derive(Debug, Clone, Deserialize)]
pub struct Curriculum {
    pub id: String,
    pub title: String,
    pub program: Program,
    #[serde(default, rename = "competency")]
    pub competencies: Vec<Competency>,
    #[serde(default, rename = "unit")]
    pub units: Vec<Unit>,
}

impl Curriculum {
    pub fn competency(&self, id: &str) -> Option<&Competency> {
        self.competencies.iter().find(|c| c.id == id)
    }

    pub fn unit(&self, id: &str) -> Option<&Unit> {
        self.units.iter().find(|u| u.id == id)
    }

    /// Uma unidade está **concluída** quando TODAS as competências que desenvolve já estão
    /// dominadas.
    pub fn is_complete(&self, unit: &Unit, mastered: &HashSet<String>) -> bool {
        !unit.develops.is_empty() && unit.develops.iter().all(|c| mastered.contains(c))
    }

    /// Uma unidade está **disponível** quando todos os seus pré-requisitos estão dominados.
    pub fn is_available(&self, unit: &Unit, mastered: &HashSet<String>) -> bool {
        unit.prerequisites.iter().all(|c| mastered.contains(c))
    }

    /// A próxima actividade para o aluno: a primeira unidade, por ordem, que está disponível
    /// (pré-requisitos satisfeitos) mas ainda não concluída. `None` quando tudo está feito ou
    /// nada está desbloqueado.
    pub fn next_unit(&self, mastered: &HashSet<String>) -> Option<&Unit> {
        self.units
            .iter()
            .find(|u| self.is_available(u, mastered) && !self.is_complete(u, mastered))
    }

    /// Competências já dominadas vs em falta, para "mostrar ao aluno o que já domina".
    pub fn progress<'a>(&'a self, mastered: &HashSet<String>) -> (Vec<&'a Competency>, Vec<&'a Competency>) {
        let (done, todo): (Vec<_>, Vec<_>) =
            self.competencies.iter().partition(|c| mastered.contains(&c.id));
        (done, todo)
    }
}

/// The curricula embedded in the binary (the pilot, for now).
pub fn builtin_curricula() -> Vec<Curriculum> {
    const CS_FOUNDATIONS: &str = include_str!("../content/curriculum-cs-foundations.toml");
    vec![toml::from_str(CS_FOUNDATIONS)
        .unwrap_or_else(|e| panic!("currículo inválido em curriculum-cs-foundations.toml: {e}"))]
}

/// Load a curriculum by id.
pub fn load_curriculum(id: &str) -> Option<Curriculum> {
    builtin_curricula().into_iter().find(|c| c.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Curriculum {
        toml::from_str(
            r#"
            id = "cs-foundations"
            title = "Foundations"
            program = "computer-science"

            [[competency]]
            id = "c.loops"
            title = "Iteration"
            cs2023 = ["SDF"]

            [[competency]]
            id = "c.complexity"
            title = "Cost analysis"
            cs2023 = ["AL"]

            [[unit]]
            id = "u1"
            title = "Loops"
            develops = ["c.loops"]
            activity = "phase.tokenize"
            evidence = "tests"

            [[unit]]
            id = "u2"
            title = "Compare algorithms"
            prerequisites = ["c.loops"]
            develops = ["c.complexity"]
            activity = "lab.cs.compare"
            evidence = "measurement"
            "#,
        )
        .unwrap()
    }

    #[test]
    fn next_unit_respects_prerequisites_and_completion() {
        let c = sample();
        let mut mastered: HashSet<String> = HashSet::new();

        // Start: only u1 is available (u2 needs c.loops).
        assert_eq!(c.next_unit(&mastered).map(|u| u.id.as_str()), Some("u1"));

        // Finish u1 → c.loops mastered → u2 unlocks.
        mastered.insert("c.loops".into());
        assert_eq!(c.next_unit(&mastered).map(|u| u.id.as_str()), Some("u2"));

        // Finish u2 → everything complete.
        mastered.insert("c.complexity".into());
        assert!(c.next_unit(&mastered).is_none());

        let (done, todo) = c.progress(&mastered);
        assert_eq!(done.len(), 2);
        assert!(todo.is_empty());
    }

    #[test]
    fn evidence_distinguishes_measurement_from_proof() {
        let c = sample();
        // The complexity lab is an empirical MEASUREMENT, never a proof (honesty contract).
        assert_eq!(c.unit("u2").unwrap().evidence, EvidenceKind::Measurement);
        assert_eq!(c.unit("u1").unwrap().evidence, EvidenceKind::Tests);
    }

    #[test]
    fn pilot_curriculum_has_three_labs_with_rubric_and_transfer() {
        let c = load_curriculum("cs-foundations").expect("embedded pilot");
        // The three pilot labs, each with the right honest evidence kind.
        assert_eq!(c.unit("lab.cs.compare").unwrap().evidence, EvidenceKind::Measurement);
        assert_eq!(c.unit("lab.ce.memory").unwrap().evidence, EvidenceKind::Simulation);
        assert_eq!(c.unit("lab.se.regression").unwrap().evidence, EvidenceKind::Tests);
        // Every lab carries a rubric and a transfer question (RF-LT-03).
        for u in &c.units {
            assert!(!u.rubric.is_empty(), "{} has a rubric", u.id);
            assert!(!u.transfer.is_empty(), "{} has a transfer question", u.id);
        }
        // Competencies map to CS2023 areas.
        assert!(c.competency("c.cost").unwrap().cs2023.contains(&"AL".to_string()));
    }
}
