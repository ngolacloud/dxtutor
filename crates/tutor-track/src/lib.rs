//! `tutor-track` — continuidade institucional do Learning Track (RF-LT-05/06).
//!
//! Regista **tentativas** de aluno (versão, competência, pistas, resultado, feedback) para
//! revisão docente e progresso, com duas propriedades centrais e *testadas*:
//!
//! - **Sync idempotente** — reaplicar o mesmo lote (ao recuperar ligação) produz UMA única
//!   submissão por tentativa (chave = `Attempt::id`, gerada no cliente). RF-LT-06.
//! - **Privacidade** — uma consulta devolve só as tentativas do aluno pedido; um aluno não vê
//!   os registos de outro. RF-LT-05.
//!
//! O armazenamento está atrás do trait [`Store`]; a impl em memória ([`MemStore`]) serve
//! testes e prática offline. Uma impl SQLite+servidor de sync entra depois sem mudar a API.
//! Timestamps são **passados pelo cliente** (nunca gerados aqui) para manter o crate puro.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Papel de uma identidade na instituição.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Student,
    Teacher,
}

/// Uma identidade (aluno ou docente).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub role: Role,
}

/// Uma turma, com o docente e os alunos inscritos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Class {
    pub id: String,
    pub title: String,
    pub teacher: String,
    pub students: Vec<String>,
}

/// Uma tentativa registada. `id` é a **chave de idempotência** (gerada no cliente), por isso
/// reenviá-la nunca duplica.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    pub id: String,
    pub student: String,
    /// Unidade/competência do currículo tentada.
    pub unit: String,
    /// Versão do conteúdo tentada (para associar à rubrica/testes certos).
    pub version: String,
    pub passed: bool,
    pub hints_used: u32,
    #[serde(default)]
    pub feedback: String,
    /// Timestamp do cliente (epoch ms); nunca gerado aqui.
    pub ts: i64,
}

/// Contrato de armazenamento — a impl SQLite+sync substitui [`MemStore`] sem mudar a API.
pub trait Store {
    /// Regista uma tentativa. Devolve `true` se é nova, `false` se já existia (idempotente).
    fn record_attempt(&mut self, a: Attempt) -> bool;
    /// Aplica um lote (sync ao recuperar ligação); devolve o nº de tentativas NOVAS aplicadas.
    fn sync(&mut self, batch: Vec<Attempt>) -> usize {
        batch.into_iter().filter(|a| self.record_attempt(a.clone())).count()
    }
    /// As tentativas de um aluno, mais recentes primeiro. **Só** as desse aluno (privacidade).
    fn attempts_of(&self, student: &str) -> Vec<Attempt>;
    /// Padrões de erro de uma turma para o docente: por unidade, quantas tentativas falharam
    /// (só dos alunos inscritos na turma).
    fn class_failures(&self, class: &Class) -> HashMap<String, usize>;
}

/// Armazenamento em memória (prática offline + testes).
#[derive(Debug, Default)]
pub struct MemStore {
    by_id: HashMap<String, Attempt>,
}

impl MemStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Store for MemStore {
    fn record_attempt(&mut self, a: Attempt) -> bool {
        use std::collections::hash_map::Entry;
        match self.by_id.entry(a.id.clone()) {
            Entry::Occupied(_) => false, // idempotente: já aplicada
            Entry::Vacant(v) => {
                v.insert(a);
                true
            }
        }
    }

    fn attempts_of(&self, student: &str) -> Vec<Attempt> {
        let mut v: Vec<Attempt> = self
            .by_id
            .values()
            .filter(|a| a.student == student)
            .cloned()
            .collect();
        v.sort_by(|a, b| b.ts.cmp(&a.ts));
        v
    }

    fn class_failures(&self, class: &Class) -> HashMap<String, usize> {
        let enrolled: std::collections::HashSet<&str> =
            class.students.iter().map(String::as_str).collect();
        let mut out: HashMap<String, usize> = HashMap::new();
        for a in self.by_id.values() {
            if !a.passed && enrolled.contains(a.student.as_str()) {
                *out.entry(a.unit.clone()).or_insert(0) += 1;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(id: &str, student: &str, unit: &str, passed: bool, ts: i64) -> Attempt {
        Attempt {
            id: id.into(),
            student: student.into(),
            unit: unit.into(),
            version: "v1".into(),
            passed,
            hints_used: 0,
            feedback: String::new(),
            ts,
        }
    }

    #[test]
    fn sync_is_idempotent() {
        let mut s = MemStore::new();
        let batch = vec![
            attempt("a1", "ana", "u1", false, 1),
            attempt("a2", "ana", "u1", true, 2),
        ];
        // First sync applies both.
        assert_eq!(s.sync(batch.clone()), 2);
        // Re-syncing the SAME batch (recovered connection) applies NONE — one submission each.
        assert_eq!(s.sync(batch.clone()), 0);
        assert_eq!(s.attempts_of("ana").len(), 2);
        // A new attempt in a later batch is applied once.
        assert_eq!(s.sync(vec![attempt("a3", "ana", "u2", true, 3)]), 1);
        assert_eq!(s.sync(vec![attempt("a3", "ana", "u2", true, 3)]), 0);
    }

    #[test]
    fn a_student_cannot_see_another_students_records() {
        let mut s = MemStore::new();
        s.record_attempt(attempt("a1", "ana", "u1", true, 1));
        s.record_attempt(attempt("a2", "rui", "u1", false, 2));
        let ana = s.attempts_of("ana");
        assert_eq!(ana.len(), 1);
        assert!(ana.iter().all(|a| a.student == "ana"));
        assert!(s.attempts_of("rui").iter().all(|a| a.student == "rui"));
    }

    #[test]
    fn class_failures_aggregate_only_enrolled() {
        let mut s = MemStore::new();
        s.record_attempt(attempt("a1", "ana", "loops", false, 1));
        s.record_attempt(attempt("a2", "rui", "loops", false, 2));
        s.record_attempt(attempt("a3", "zed", "loops", false, 3)); // NOT enrolled
        s.record_attempt(attempt("a4", "ana", "loops", true, 4)); // passed → not a failure
        let class = Class {
            id: "t1".into(),
            title: "T1".into(),
            teacher: "prof".into(),
            students: vec!["ana".into(), "rui".into()],
        };
        let f = s.class_failures(&class);
        assert_eq!(f.get("loops"), Some(&2)); // ana + rui failed; zed excluded, pass excluded
    }
}
