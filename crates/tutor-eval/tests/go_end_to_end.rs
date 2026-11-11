//! Prova ponta-a-ponta do avaliador **Go** (novo `GoRunner`).
//!
//! Não há (ainda) um banco de conteúdo Go no `tutor-core`, por isso estes testes
//! constroem as [`Phase`] à mão. Estão marcados `#[ignore]` porque correm a toolchain
//! Go real (compila/testa/corre). Corre-os explicitamente com:
//!
//! ```sh
//! # host (default): go tem de estar no PATH (ex.: /usr/local/go/bin)
//! PATH="$PATH:/usr/local/go/bin" cargo test -p tutor-eval --test go_end_to_end \
//!     -- --ignored --nocapture
//!
//! # container (go mod tidy com rede destrava pacotes externos):
//! DXTUTOR_SANDBOX_ENGINE=delonix cargo test -p tutor-eval --test go_end_to_end \
//!     go_modulo_externo -- --ignored --nocapture
//! ```
//!
//! O que provam (as exigências do contrato):
//!   (a) um programa Go COMPLETO corre e imprime o stdout esperado (`run_go_program`);
//!   (b) um desafio Go simples (função + `_test.go`) PASSA via `check_correctness`;
//!   (c) uma solução Go errada FALHA a correcção (a fonte da verdade são os testes);
//!   (d) [container] um programa que importa um módulo externo compila via `go mod tidy`.

use tutor_core::{Gabarito, Level, Phase};
use tutor_eval::{assess, run_go_program};

/// Constrói uma [`Phase`] Go mínima com os testes dados.
fn go_phase(tests: &str) -> Phase {
    Phase {
        id: "go-soma".into(),
        title: "Soma".into(),
        level: Level::Basico,
        language: "go".into(),
        instructions: "Implementa `Soma`.".into(),
        entry: "Soma".into(),
        starter: "func Soma(a, b int) int { return 0 }".into(),
        tests: tests.into(),
        gabarito: Gabarito {
            solution: "func Soma(a, b int) int { return a + b }".into(),
            time: "O(1)".into(),
            space: "O(1)".into(),
            justification: "soma directa".into(),
        },
        probe: None,
        dependencies: Vec::new(),
    }
}

/// (a) Um programa Go completo corre e o seu stdout chega intacto.
#[test]
#[ignore = "corre a toolchain Go real (go run); lento"]
fn go_drill_programa_completo_imprime_stdout() {
    let out = run_go_program(
        "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"ola go do dxtutor\")\n}\n",
    )
    .expect("o sandbox Go não devia falhar a arrancar");
    assert!(
        out.ok,
        "o programa devia compilar e correr; stderr:\n{}",
        out.stderr
    );
    assert!(
        out.stdout.contains("ola go do dxtutor"),
        "stdout devia conter a linha esperada, obteve-se:\n{}",
        out.stdout
    );
}

/// (b) Um desafio Go simples (função do aluno + testes `_test.go`) PASSA a correcção.
#[test]
#[ignore = "corre `go mod tidy` + `go test`; lento"]
fn go_desafio_gabarito_passa_a_correccao() {
    const TESTS: &str = r#"
import "testing"

func TestSoma(t *testing.T) {
	if Soma(2, 3) != 5 {
		t.Fatalf("Soma(2,3) = %d; quero 5", Soma(2, 3))
	}
	if Soma(-1, 1) != 0 {
		t.Fatalf("Soma(-1,1) = %d; quero 0", Soma(-1, 1))
	}
}
"#;
    let ph = go_phase(TESTS);
    let a = assess(&ph, &ph.gabarito.solution).expect("avaliar gabarito Go");
    assert!(
        a.correctness.passed,
        "o gabarito Go devia PASSAR a correcção; resumo: {}\nsaída:\n{}",
        a.correctness.summary, a.correctness.raw
    );
    println!("[go desafio] correcção OK — {}", a.correctness.summary);
}

/// (c) Uma solução Go errada FALHA a correcção.
#[test]
#[ignore = "corre `go test`; lento"]
fn go_solucao_errada_falha_a_correccao() {
    const TESTS: &str = r#"
import "testing"

func TestSoma(t *testing.T) {
	if Soma(2, 3) != 5 {
		t.Fatalf("Soma(2,3) = %d; quero 5", Soma(2, 3))
	}
}
"#;
    let ph = go_phase(TESTS);
    // Multiplica em vez de somar → falha o teste.
    let a = assess(&ph, "func Soma(a, b int) int { return a * b }")
        .expect("avaliar solução errada");
    assert!(
        !a.correctness.passed,
        "a solução errada NÃO devia passar; resumo: {}\n{}",
        a.correctness.summary, a.correctness.raw
    );
    println!(
        "[go errada] correcção FALHOU como esperado — {}",
        a.correctness.summary
    );
}

/// (d) [container] Um programa Go que importa um módulo EXTERNO compila porque
/// `go mod tidy` corre com rede dentro do container `golang:1.25-alpine`. **Portão**:
/// só com `DXTUTOR_SANDBOX_ENGINE` != host E o CLI do motor presente.
#[test]
#[ignore = "requer DXTUTOR_SANDBOX_ENGINE!=host + motor de container + rede; go mod tidy descarrega"]
fn go_modulo_externo_compila_via_go_mod_tidy_no_container() {
    use tutor_eval::{current_engine, engine_available, SandboxEngine};

    let engine = current_engine();
    if engine == SandboxEngine::Host || !engine_available(engine) {
        eprintln!("salto: motor == host ou CLI do motor ({engine:?}) ausente");
        return;
    }

    // Importa `rsc.io/quote` (módulo externo clássico) — `go mod tidy` tem de o
    // descarregar da rede e só então o programa compila e corre.
    const PROG: &str = r#"package main

import (
	"fmt"

	"rsc.io/quote"
)

func main() {
	fmt.Println(quote.Hello())
}
"#;
    let out = run_go_program(PROG).expect("o sandbox do container não devia falhar a arrancar");
    assert!(
        out.ok,
        "o programa com módulo externo devia compilar via `go mod tidy`; stderr:\n{}",
        out.stderr
    );
    assert!(
        !out.stdout.trim().is_empty(),
        "devia imprimir algo (a saudação de rsc.io/quote); stdout vazio"
    );
    println!("[go módulo externo] stdout: {}", out.stdout.trim());
}
