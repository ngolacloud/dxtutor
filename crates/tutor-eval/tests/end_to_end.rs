//! Prova ponta-a-ponta do avaliador sobre o conteúdo curado.
//!
//! Estes testes correm `cargo` aninhado (compilam e cronometram o código do aluno
//! num pacote isolado), tal como o editor faz em produção. Por isso estão marcados
//! `#[ignore]`: ficam fora do `cargo test --workspace` (rápido e sem cargo-dentro-de-
//! -cargo) e corremos-os explicitamente com:
//!
//! ```sh
//! cargo test -p tutor-eval --test end_to_end -- --ignored --nocapture
//! ```
//!
//! O que provam:
//!   1. As três fases do `rust-word-frequency` passam a correcção com o gabarito e,
//!      onde há sonda, a complexidade MEDIDA bate (ou é melhor que) a esperada.
//!   2. Na fase 3, a sonda separa uma solução por amontoado (quase-linear) de uma
//!      por ordenação total (linearítmica) — a lição do heap, medida e não afirmada.

use tutor_core::{load_project, Phase};
use tutor_eval::{assess, Class};

/// Ordem crescente de custo assintótico (igual à do CLI), para comparar classes.
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
    load_project("rust-word-frequency")
        .expect("projecto rust-word-frequency embebido")
        .phase(id)
        .unwrap_or_else(|| panic!("fase {id} existe"))
        .clone()
}

/// Avalia o gabarito de uma fase: correcção TEM de passar e, havendo sonda, a classe
/// medida não pode ser pior que a esperada (bate ou melhora).
fn prova_gabarito(id: &str) {
    let ph = phase(id);
    let a = assess(&ph, &ph.gabarito.solution)
        .unwrap_or_else(|e| panic!("avaliar gabarito de {id}: {e:#}"));

    assert!(
        a.correctness.passed,
        "gabarito de {id} devia PASSAR a correcção; saída:\n{}",
        a.correctness.raw
    );

    match (&a.complexity, a.expected) {
        (Some(est), Some(expected)) => {
            println!(
                "[{id}] correcção OK · medida {} (R²={:.3}, p={:.2}, conf {:?}) · esperada {}",
                est.big_o(),
                est.r_squared,
                est.loglog_exponent,
                est.confidence,
                expected.big_o()
            );
            assert!(
                rank(est.best) <= rank(expected),
                "fase {id}: classe medida {} é PIOR que a esperada {}",
                est.big_o(),
                expected.big_o()
            );
        }
        (None, _) => println!("[{id}] correcção OK · (fase sem sonda ou sem medição)"),
        _ => {}
    }
}

#[test]
#[ignore = "corre cargo aninhado; prova a fase 1 ponta-a-ponta"]
fn fase1_tokenize_passa_e_mede_linear() {
    prova_gabarito("p1-tokenize");
}

#[test]
#[ignore = "corre cargo aninhado; prova a fase 2 ponta-a-ponta"]
fn fase2_count_passa_e_mede_linear() {
    prova_gabarito("p2-count");
}

#[test]
#[ignore = "corre cargo aninhado; prova a fase 3 ponta-a-ponta"]
fn fase3_topk_passa_e_bate_o_esperado() {
    prova_gabarito("p3-topk");
}

/// Uma solução por amontoado (min-heap de tamanho `k`) para o top-k. Passa os mesmos
/// testes de correcção do gabarito, mas é O(m·log k) ≈ **linear** com `k` fixo.
const TOPK_HEAP: &str = r#"
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

// O topo deste max-heap é o PIOR candidato (o a despejar): pior = menor contagem;
// em empate, palavra alfabeticamente MAIOR (a ordem final prefere a menor).
#[derive(PartialEq, Eq)]
struct Worst {
    count: usize,
    word: String,
}
impl Ord for Worst {
    fn cmp(&self, other: &Self) -> Ordering {
        self.count
            .cmp(&other.count)
            .reverse()
            .then_with(|| self.word.cmp(&other.word))
    }
}
impl PartialOrd for Worst {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn top_k(freq: &HashMap<String, usize>, k: usize) -> Vec<(String, usize)> {
    if k == 0 {
        return Vec::new();
    }
    let mut heap: BinaryHeap<Worst> = BinaryHeap::with_capacity(k + 1);
    for (w, &c) in freq {
        heap.push(Worst { count: c, word: w.clone() });
        if heap.len() > k {
            heap.pop(); // despeja o pior — mantém só os k melhores
        }
    }
    let mut out: Vec<(String, usize)> =
        heap.into_iter().map(|e| (e.word, e.count)).collect();
    // Ordena apenas os k sobreviventes na ordem final. O(k log k), desprezável.
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}
"#;

#[test]
#[ignore = "corre cargo aninhado; a lição do heap no top-k"]
fn fase3_sonda_distingue_heap_de_ordenacao_total() {
    let ph = phase("p3-topk");

    // (a) O gabarito ordena tudo → linearítmico.
    let sort = assess(&ph, &ph.gabarito.solution).expect("avaliar gabarito (ordenação)");
    assert!(sort.correctness.passed, "gabarito devia passar a correcção");
    let sort_est = sort.complexity.expect("gabarito tem medição de complexidade");

    // (b) A solução por amontoado → quase-linear, e passa os MESMOS testes.
    let heap = assess(&ph, TOPK_HEAP).expect("avaliar solução por heap");
    assert!(
        heap.correctness.passed,
        "a solução por heap devia passar a MESMA correcção; saída:\n{}",
        heap.correctness.raw
    );
    let heap_est = heap.complexity.expect("heap tem medição de complexidade");

    println!(
        "ordenação total: {} (R²={:.3}, p={:.2})  |  heap de tamanho k: {} (R²={:.3}, p={:.2})",
        sort_est.big_o(),
        sort_est.r_squared,
        sort_est.loglog_exponent,
        heap_est.big_o(),
        heap_est.r_squared,
        heap_est.loglog_exponent,
    );

    // A lição: ordenar tudo é linearítmico; o heap é estritamente mais barato.
    assert_eq!(
        sort_est.best,
        Class::Linearithmic,
        "a ordenação total devia medir O(n log n)"
    );
    assert_eq!(
        heap_est.best,
        Class::Linear,
        "o heap de tamanho k fixo devia medir O(n) (log k é constante)"
    );
    assert!(
        rank(heap_est.best) < rank(sort_est.best),
        "o heap devia medir uma classe estritamente mais barata que a ordenação total"
    );
}
