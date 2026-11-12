//! Secção 4 — prova de honestidade do cenário "contar caracteres".
//!
//! Corre o avaliador REAL (compila o código do aluno num pacote isolado e corre os
//! testes ocultos), por isso é `#[ignore]`. Corre explicitamente:
//!
//! ```sh
//! cargo test -p tutor-eval --test count_chars_e2e -- --ignored --nocapture
//! ```
//!
//! O que prova:
//!   1. A solução de referência (conta valores escalares Unicode) PASSA.
//!   2. Uma solução que conta BYTES — plausível e que até passa em `"casa"` — FALHA,
//!      porque devolve 5 para `"ação"` onde o esperado é 4. É o contra-exemplo que a
//!      primeira pista mostra ao aluno.

use tutor_core::load_project;
use tutor_eval::assess;

fn count_chars_phase() -> tutor_core::Phase {
    load_project("rust-count-chars")
        .expect("projecto rust-count-chars embebido")
        .phase("p1-count-chars")
        .expect("fase p1-count-chars existe")
        .clone()
}

#[test]
#[ignore = "compila e corre cargo aninhado; corre com --ignored"]
fn referencia_passa() {
    let phase = count_chars_phase();
    let a = assess(&phase, &phase.gabarito.solution).expect("avaliação corre");
    assert!(
        a.correctness.passed,
        "a referência devia passar; saída:\n{}",
        a.correctness.raw
    );
}

#[test]
#[ignore = "compila e corre cargo aninhado; corre com --ignored"]
fn contar_bytes_falha_no_contra_exemplo() {
    let phase = count_chars_phase();
    // Solução plausível mas errada: conta BYTES. Passa em ASCII ("casa"=4) mas devolve
    // 5 para "ação" (5 bytes em UTF-8) — a honestidade do cenário.
    let bytes_solution = r#"
pub fn count_chars(input: &str) -> usize {
    input.len()
}
"#;
    let a = assess(&phase, bytes_solution).expect("avaliação corre");
    assert!(
        !a.correctness.passed,
        "contar bytes NÃO devia passar os testes ocultos (devolve 5 para \"ação\")"
    );
}
