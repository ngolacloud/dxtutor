//! Persistência SQLite do [`Store`] (RF-LT-05/06), durável entre sessões e base para o
//! servidor de sync. Mantém as duas propriedades centrais:
//! - **Idempotência**: `id` é PRIMARY KEY e a inserção usa `INSERT OR IGNORE`, por isso
//!   reaplicar um lote nunca duplica.
//! - **Privacidade**: as consultas filtram por `student`, logo um aluno só vê o seu.

use std::collections::HashMap;

use rusqlite::{params, Connection};

use crate::{Attempt, Class, Store};

/// Armazenamento SQLite. Abre (ou cria) a base e garante o esquema.
pub struct SqliteStore {
    conn: Connection,
}

impl SqliteStore {
    /// Abre um ficheiro de base de dados (cria-o e o esquema se não existir).
    pub fn open(path: &std::path::Path) -> rusqlite::Result<Self> {
        Self::from_conn(Connection::open(path)?)
    }

    /// Base em memória (testes / prática efémera).
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::from_conn(Connection::open_in_memory()?)
    }

    fn from_conn(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS attempts (
                id        TEXT PRIMARY KEY,
                student   TEXT NOT NULL,
                unit      TEXT NOT NULL,
                version   TEXT NOT NULL,
                passed    INTEGER NOT NULL,
                hints     INTEGER NOT NULL,
                feedback  TEXT NOT NULL,
                ts        INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts(student);",
        )?;
        Ok(Self { conn })
    }

    fn row_to_attempt(row: &rusqlite::Row) -> rusqlite::Result<Attempt> {
        Ok(Attempt {
            id: row.get(0)?,
            student: row.get(1)?,
            unit: row.get(2)?,
            version: row.get(3)?,
            passed: row.get::<_, i64>(4)? != 0,
            hints_used: row.get::<_, i64>(5)? as u32,
            feedback: row.get(6)?,
            ts: row.get(7)?,
        })
    }
}

impl Store for SqliteStore {
    fn record_attempt(&mut self, a: Attempt) -> bool {
        // INSERT OR IGNORE → idempotent on the PRIMARY KEY `id`.
        let n = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO attempts
                   (id, student, unit, version, passed, hints, feedback, ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    a.id,
                    a.student,
                    a.unit,
                    a.version,
                    a.passed as i64,
                    a.hints_used as i64,
                    a.feedback,
                    a.ts,
                ],
            )
            .unwrap_or(0);
        n > 0
    }

    fn attempts_of(&self, student: &str) -> Vec<Attempt> {
        let mut stmt = match self.conn.prepare(
            "SELECT id, student, unit, version, passed, hints, feedback, ts
               FROM attempts WHERE student = ?1 ORDER BY ts DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![student], Self::row_to_attempt)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    fn class_failures(&self, class: &Class) -> HashMap<String, usize> {
        let mut out = HashMap::new();
        if class.students.is_empty() {
            return out;
        }
        // Build a parameter list for the enrolled students.
        let placeholders = class.students.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT unit, COUNT(*) FROM attempts
               WHERE passed = 0 AND student IN ({placeholders}) GROUP BY unit"
        );
        let mut stmt = match self.conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return out,
        };
        let params: Vec<&dyn rusqlite::ToSql> =
            class.students.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        if let Ok(rows) = stmt.query_map(params.as_slice(), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
        }) {
            for (unit, n) in rows.filter_map(Result::ok) {
                out.insert(unit, n);
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
    fn sqlite_sync_is_idempotent_and_private() {
        let mut s = SqliteStore::in_memory().unwrap();
        let batch = vec![attempt("a1", "ana", "u1", false, 1), attempt("a2", "rui", "u1", true, 2)];
        assert_eq!(s.sync(batch.clone()), 2);
        assert_eq!(s.sync(batch), 0); // re-sync → no duplicates (durable idempotency)
        assert_eq!(s.attempts_of("ana").len(), 1);
        assert!(s.attempts_of("ana").iter().all(|a| a.student == "ana"));

        let class = Class {
            id: "t".into(),
            title: "T".into(),
            teacher: "p".into(),
            students: vec!["ana".into(), "rui".into()],
        };
        s.record_attempt(attempt("a3", "ana", "loops", false, 3));
        assert_eq!(s.class_failures(&class).get("loops"), Some(&1));
    }
}
