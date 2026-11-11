//! End-to-end regression guard for the external-dependency enabler.
//!
//! These prove the REAL evaluator path — not an equivalent hand-rolled crate: a
//! challenge's `dependencies` flow `Step` → `Phase::as_phase` → `assess` →
//! `scaffold_package`/`scaffold_module` → a compiled `[dependencies]` / `require`,
//! and the reference solution passes its hidden tests against that external crate.
//!
//! They are `#[ignore]` because each compiles a real database driver (rusqlite's
//! bundled SQLite C, or modernc.org/sqlite), which is far too slow for the normal
//! unit suite. Run explicitly:
//!
//! ```text
//! cargo test -p tutor-eval --test db_deps_e2e -- --ignored
//! ```

use tutor_core::{load_course, Level, StepKind};

/// Loads `course_id`, finds the challenge step of `unit_id`, and asserts its
/// curated reference solution passes the hidden tests through the full evaluator
/// (which must provision the step's declared external dependency to compile).
fn assert_db_challenge_passes(course_id: &str, unit_id: &str) {
    let course = load_course(course_id).unwrap_or_else(|| panic!("curso {course_id}"));
    let unit = course
        .units
        .iter()
        .find(|u| u.id == unit_id)
        .unwrap_or_else(|| panic!("unidade {unit_id}"));
    let challenge = unit
        .steps
        .iter()
        .find(|s| s.kind == StepKind::Challenge)
        .expect("unidade tem um challenge");

    assert!(
        !challenge.dependencies.is_empty(),
        "{unit_id}: o challenge devia declarar dependências externas"
    );

    let phase = challenge
        .as_phase(&course.language, Level::Intermedio)
        .expect("challenge vira Phase");
    let solution = phase.gabarito.solution.clone();

    let assessment = tutor_eval::assess(&phase, &solution)
        .unwrap_or_else(|e| panic!("assess {unit_id}: {e}"));
    assert!(
        assessment.correctness.passed,
        "{unit_id}: a solução de referência devia passar os testes ocultos com a dependência provisionada.\n{}",
        assessment.correctness.raw
    );
}

#[test]
#[ignore = "compiles rusqlite bundled SQLite; run with --ignored"]
fn rust_db_challenge_passes_via_assess() {
    assert_db_challenge_passes("rust-beginner", "udb1-connect-query");
}

#[test]
#[ignore = "downloads+compiles modernc.org/sqlite; run with --ignored"]
fn go_db_challenge_passes_via_assess() {
    assert_db_challenge_passes("go-basics", "udb1-connect-query");
}
