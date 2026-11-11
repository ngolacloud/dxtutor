//! Prova ponta-a-ponta do avaliador **JavaScript** sobre o conteúdo `js-text-metrics`.
//!
//! Espelha a prova do Rust (`end_to_end.rs`), mas o motor é o QuickJS embebido. Estão
//! marcados `#[ignore]` porque arrancam o motor e cronometram (a variante O(n²) corre
//! de propósito); corre-os explicitamente com:
//!
//! ```sh
//! cargo test -p tutor-eval --test js_end_to_end -- --ignored --nocapture
//! ```
//!
//! O que provam (as três exigências do contrato):
//!   (a) a solução do GABARITO passa a correcção, nas três fases;
//!   (b) uma solução JS ERRADA falha a correcção;
//!   (c) a sonda separa O(n) de O(n²) numa função JS — o gabarito linear do
//!       `tokenize` contra uma variante quadrática *correcta*.

use tutor_core::{load_project, Phase};
use tutor_eval::{assess, diagnostics, Class, Severity};

fn rank(c: Class) -> u8 {
    match c {
        Class::Constant => 0,
        Class::Logarithmic => 1,
        Class::Linear => 2,
        Class::Linearithmic => 3,
        Class::Quadratic => 4,
        Class::Cubic => 5,
        Class::Exponential => 6,
    }
}

fn phase(id: &str) -> Phase {
    load_project("js-text-metrics")
        .expect("projecto js-text-metrics embebido")
        .phase(id)
        .unwrap_or_else(|| panic!("fase {id} existe"))
        .clone()
}

/// (a) O gabarito de cada fase PASSA a correcção. A complexidade medida é impressa
/// como evidência (não é asserida aqui): distinguir O(n) de O(n log n) é
/// intrinsecamente subtil e sensível ao ruído da máquina, logo asseri-la tornaria a
/// prova frágil — e o princípio de honestidade manda não afirmar o que a medição não
/// garante. A asserção dura sobre a sonda está na prova (c), no caso robusto
/// O(n)↔O(n²). A fonte da verdade de (a) é a correcção.
fn prova_gabarito(id: &str) {
    let ph = phase(id);
    assert_eq!(ph.language, "js", "a fase devia ser avaliada como JS");
    let a = assess(&ph, &ph.gabarito.solution)
        .unwrap_or_else(|e| panic!("avaliar gabarito JS de {id}: {e:#}"));

    assert!(
        a.correctness.passed,
        "gabarito JS de {id} devia PASSAR a correcção; saída:\n{}",
        a.correctness.raw
    );

    if let (Some(est), Some(expected)) = (&a.complexity, a.expected) {
        println!(
            "[{id}] correcção OK · medida {} (R²={:.3}, p={:.2}, conf {:?}) · esperada {} [evidência]",
            est.big_o(),
            est.r_squared,
            est.loglog_exponent,
            est.confidence,
            expected.big_o()
        );
    } else {
        println!("[{id}] correcção OK");
    }
}

#[test]
#[ignore = "arranca o motor JS; prova (a) para a fase 1"]
fn js_fase1_gabarito_passa_e_mede_linear() {
    prova_gabarito("p1-tokenize");
}

#[test]
#[ignore = "arranca o motor JS; prova (a) para a fase 2"]
fn js_fase2_gabarito_passa_e_mede_linear() {
    prova_gabarito("p2-count");
}

#[test]
#[ignore = "arranca o motor JS; prova (a) para a fase 3"]
fn js_fase3_gabarito_passa_e_bate_o_esperado() {
    prova_gabarito("p3-topk");
}

/// (b) Uma solução JS correcta na forma mas ERRADA no resultado tem de FALHAR a
/// correcção — a fonte da verdade são os testes, não a sintaxe.
#[test]
#[ignore = "arranca o motor JS; prova (b): solução errada falha"]
fn js_solucao_errada_falha_a_correccao() {
    let ph = phase("p1-tokenize");
    // Não passa a minúsculas → falha o teste de maiúsculas/pontuação.
    const ERRADA: &str = r#"
function tokenize(input) {
  return input.split(/[^0-9A-Za-z]+/).filter(s => s.length > 0);
}
"#;
    let a = assess(&ph, ERRADA).expect("avaliar solução errada");
    assert!(
        !a.correctness.passed,
        "a solução errada NÃO devia passar; resumo: {}\n{}",
        a.correctness.summary,
        a.correctness.raw
    );
    assert!(
        a.complexity.is_none(),
        "sem correcção não há medição de complexidade"
    );
    println!(
        "[solução errada] correcção FALHOU como esperado — {}\n{}",
        a.correctness.summary, a.correctness.raw
    );
}

/// (c) A sonda separa O(n) de O(n²) numa função JS: o gabarito linear do `tokenize`
/// contra uma variante que varre o acumulado a cada palavra (quadrática, mas correcta
/// — passa os MESMOS testes).
const TOKENIZE_QUADRATICA: &str = r#"
function tokenize(input) {
  const out = [];
  for (const part of input.split(/[^0-9A-Za-z]+/)) {
    if (part.length === 0) continue;
    const w = part.toLowerCase();
    // Varredura desnecessária do que já foi acumulado: torna isto O(n^2).
    let dups = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === w) dups++;
    }
    globalThis.__noopSink = dups;
    out.push(w);
  }
  return out;
}
"#;

#[test]
#[ignore = "arranca o motor JS e cronometra a variante O(n²); prova (c)"]
fn js_sonda_separa_linear_de_quadratico() {
    let ph = phase("p1-tokenize");

    // Gabarito: linear.
    let lin = assess(&ph, &ph.gabarito.solution).expect("avaliar gabarito (linear)");
    assert!(lin.correctness.passed, "gabarito devia passar a correcção");
    let lin_est = lin.complexity.expect("gabarito tem medição de complexidade");

    // Variante quadrática, mas correcta: passa os mesmos testes.
    let quad = assess(&ph, TOKENIZE_QUADRATICA).expect("avaliar variante quadrática");
    assert!(
        quad.correctness.passed,
        "a variante quadrática devia passar a MESMA correcção; saída:\n{}",
        quad.correctness.raw
    );
    let quad_est = quad.complexity.expect("a variante tem medição de complexidade");

    println!(
        "gabarito linear: {} (R²={:.3}, p={:.2})  |  variante quadrática: {} (R²={:.3}, p={:.2})",
        lin_est.big_o(),
        lin_est.r_squared,
        lin_est.loglog_exponent,
        quad_est.big_o(),
        quad_est.r_squared,
        quad_est.loglog_exponent,
    );

    // A garantia dura é a SEPARAÇÃO (o que o contrato pede): o gabarito linear mede
    // uma classe estritamente mais barata que a variante quadrática, e o quadrático
    // lê-se inequivocamente O(n²) (quadruplica a cada duplicação — o caso robusto).
    assert_eq!(
        quad_est.best,
        Class::Quadratic,
        "a variante devia medir O(n²) (saída: {} p={:.2})",
        quad_est.big_o(),
        quad_est.loglog_exponent
    );
    assert!(
        rank(lin_est.best) < rank(quad_est.best),
        "o gabarito ({}) devia medir uma classe estritamente mais barata que o quadrático ({})",
        lin_est.big_o(),
        quad_est.big_o()
    );
}

/// Diagnósticos JS (a "linha vermelha"): um erro de sintaxe traz posição; código
/// válido não traz nada. Rápido (motor em-processo), por isso não é `#[ignore]`.
#[test]
fn js_diagnostics_apontam_a_linha_do_erro() {
    let ph = phase("p1-tokenize");

    // Código válido → sem diagnósticos.
    let ok = diagnostics(&ph, "function f(){ return 1 + 1; }").expect("diag de código válido");
    assert!(ok.is_empty(), "código válido não devia ter diagnósticos: {ok:?}");

    // Erro de sintaxe na 3ª linha → um diagnóstico de erro, ancorado à linha 3.
    let src = "function tokenize(input) {\n  let x = 1;\n  let y = ;\n}\n";
    let diags = diagnostics(&ph, src).expect("diag de código com erro");
    assert_eq!(diags.len(), 1, "esperado exactamente um diagnóstico: {diags:?}");
    let d = &diags[0];
    assert_eq!(d.severity, Severity::Error);
    assert_eq!(d.line, 3, "o erro está na linha 3, veio linha {}", d.line);
    assert!(!d.message.is_empty(), "o diagnóstico devia ter mensagem");
    println!(
        "[diagnostics JS] linha {} coluna {}: {}",
        d.line, d.col, d.message
    );
}

/// Diagnósticos Rust via `cargo check --message-format=json`: prova que o mesmo
/// contrato posicional funciona na linguagem Rust. Ignorado: corre cargo.
#[test]
#[ignore = "corre cargo check; prova os diagnósticos posicionais em Rust"]
fn rust_diagnostics_apontam_a_linha_do_erro() {
    let ph: Phase = load_project("rust-word-frequency")
        .unwrap()
        .phase("p1-tokenize")
        .unwrap()
        .clone();
    // Falta o ';' → erro de compilação na linha 2.
    let src = "pub fn f() -> i32 {\n    let x = 1\n    x\n}\n";
    let diags = diagnostics(&ph, src).expect("diag Rust");
    assert!(
        diags.iter().any(|d| d.severity == Severity::Error && d.line >= 2),
        "esperado um erro posicional (linha >= 2); veio: {diags:?}"
    );
    for d in &diags {
        println!("[diagnostics Rust] {:?} L{} C{}: {}", d.severity, d.line, d.col, d.message);
    }
}
