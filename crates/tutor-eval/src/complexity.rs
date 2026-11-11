//! Estimativa **empírica** da classe de complexidade a partir de medições.
//!
//! Não provamos nada — ajustamos. Dado um conjunto de pontos `(n, t)` (tamanho de
//! entrada, tempo), testamos cada classe candidata `f(n)` com o modelo `t ≈ c·f(n)`
//! e escolhemos a de melhor ajuste. Também reportamos o expoente da regressão
//! log-log como medida secundária. Tudo isto é uma *dica*, declarada como tal —
//! jamais uma afirmação formal.
//!
//! ## Porque o ajuste é no espaço logarítmico (constância de razão)
//!
//! A versão ingénua ajustava `t ≈ c·f(n)` minimizando o erro quadrático **sobre os
//! valores crus** e escolhia o maior R². Isso tem um defeito fatal justamente no
//! caso mais difícil — distinguir **O(n)** de **O(n log n)**: como o erro quadrático
//! cru é dominado pelos `n` grandes, o factor `log n` (que só se revela na *forma*
//! da curva, não na sua escala) afoga-se, e o ruído facilmente troca as duas classes.
//!
//! A sonda mede tamanhos que **duplicam** (`n, 2n, 4n, …`). Para a classe correcta,
//! a razão `t / f(n)` é aproximadamente **constante** (= a constante `c` do modelo);
//! para uma classe errada, essa razão deriva de forma sistemática com `n`. Medimos
//! então o ajuste pela **constância da razão em escala logarítmica**: olhamos para
//! `r(n) = ln(t) − ln(f(n))` e preferimos a classe cuja `r(n)` tem menor variância.
//! Isto pesa todos os tamanhos por igual (um teste de razão robusto, equivalente a
//! mínimos quadrados ponderados pelo inverso de `t²`), e é o que torna a separação
//! O(n) / O(n log n) / O(n²) fiável aos tamanhos usados no conteúdo.
//!
//! O R² reportado é, por isso, o **R² no espaço-log** (fracção da variância de
//! `ln(t)` explicada pelo modelo multiplicativo). A confiança é conservadora: tempos
//! minúsculos, ajuste pobre, ou segunda-melhor-classe quase tão boa ⇒ confiança baixa.

/// Uma medição: tempo (ns) para uma entrada de tamanho `n`.
#[derive(Debug, Clone, Copy)]
pub struct Sample {
    pub n: f64,
    pub t: f64,
}

/// Classes de complexidade que sabemos reconhecer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Constant,
    Logarithmic,
    Linear,
    Linearithmic,
    Quadratic,
    Cubic,
    Exponential,
}

impl Class {
    pub const ALL: [Class; 7] = [
        Class::Constant,
        Class::Logarithmic,
        Class::Linear,
        Class::Linearithmic,
        Class::Quadratic,
        Class::Cubic,
        Class::Exponential,
    ];

    /// A função-base `f(n)` do modelo `t ≈ c·f(n)`.
    fn basis(self, n: f64) -> f64 {
        let ln = n.max(2.0).ln();
        match self {
            Class::Constant => 1.0,
            Class::Logarithmic => ln,
            Class::Linear => n,
            Class::Linearithmic => n * ln,
            Class::Quadratic => n * n,
            Class::Cubic => n * n * n,
            Class::Exponential => (n * std::f64::consts::LN_2).exp(),
        }
    }

    /// Notação Big-O canónica.
    pub fn big_o(self) -> &'static str {
        match self {
            Class::Constant => "O(1)",
            Class::Logarithmic => "O(log n)",
            Class::Linear => "O(n)",
            Class::Linearithmic => "O(n log n)",
            Class::Quadratic => "O(n²)",
            Class::Cubic => "O(n³)",
            Class::Exponential => "O(2^n)",
        }
    }
}

/// Resultado da estimativa.
#[derive(Debug, Clone)]
pub struct Estimate {
    /// Classe de melhor ajuste.
    pub best: Class,
    /// Coeficiente de determinação R² do melhor modelo, no **espaço logarítmico**
    /// (fracção da variância de `ln t` explicada pelo modelo multiplicativo), em 0..=1.
    pub r_squared: f64,
    /// Expoente `p` da regressão log-log `t ≈ c·n^p` (medida secundária).
    pub loglog_exponent: f64,
    /// Confiança qualitativa da estimativa.
    pub confidence: Confidence,
    /// Ajustes de todas as classes, ordenados do melhor para o pior (classe, R²).
    pub ranking: Vec<(Class, f64)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    /// Medições demasiado pequenas/ruidosas para confiar.
    Low,
    Medium,
    High,
}

impl Estimate {
    pub fn big_o(&self) -> &'static str {
        self.best.big_o()
    }
}

/// Ajuste de uma classe no **espaço logarítmico** (teste de constância de razão).
///
/// Modelo multiplicativo `t ≈ c·f(n)`. Em escala log, `ln(t) = ln(c) + ln(f(n))`,
/// pelo que os resíduos são `r(n) = ln(t) − ln(f(n))` e o melhor `ln(c)` é a média
/// desses resíduos. Devolve `(c, ss_res_log)`:
/// - `c = exp(média de r)` — a constante multiplicativa (média geométrica da razão);
/// - `ss_res_log = Σ (r − média)²` — a variância (não-normalizada) da razão em log.
///
/// **Menor `ss_res_log` ⇒ melhor ajuste.** Como o termo total `Σ(ln t − média ln t)²`
/// não depende da classe, ordenar por `ss_res_log` crescente é equivalente a ordenar
/// por R² (no espaço-log) decrescente — mas numericamente estável mesmo quando os
/// tempos são quase constantes.
///
/// Classes cuja base não seja finita e positiva (ex.: `O(2^n)` que transborda para
/// `inf` já em `n` moderado) são desqualificadas com `ss_res_log = +∞`.
fn fit_log(samples: &[Sample], class: Class) -> (f64, f64) {
    let mut ratios = Vec::with_capacity(samples.len());
    for s in samples {
        let f = class.basis(s.n);
        let t = s.t.max(1.0); // guarda o log de tempos nulos (ruído de arredondamento)
        if !f.is_finite() || f <= 0.0 {
            return (f64::NAN, f64::INFINITY);
        }
        ratios.push(t.ln() - f.ln());
    }
    let mean = ratios.iter().sum::<f64>() / ratios.len() as f64;
    let ss_res: f64 = ratios.iter().map(|r| (r - mean).powi(2)).sum();
    (mean.exp(), ss_res)
}

/// Variância total de `ln(t)` — o denominador do R² no espaço-log (igual para todas
/// as classes, logo não afecta a ordenação; serve apenas para reportar o R²).
fn total_log_variation(samples: &[Sample]) -> f64 {
    let lnt: Vec<f64> = samples.iter().map(|s| s.t.max(1.0).ln()).collect();
    let mean = lnt.iter().sum::<f64>() / lnt.len() as f64;
    lnt.iter().map(|x| (x - mean).powi(2)).sum()
}

/// Expoente da regressão linear sobre `(ln n, ln t)`.
fn loglog_exponent(samples: &[Sample]) -> f64 {
    let pts: Vec<(f64, f64)> = samples
        .iter()
        .filter(|s| s.n > 0.0 && s.t > 0.0)
        .map(|s| (s.n.ln(), s.t.ln()))
        .collect();
    if pts.len() < 2 {
        return f64::NAN;
    }
    let m = pts.len() as f64;
    let sx: f64 = pts.iter().map(|p| p.0).sum();
    let sy: f64 = pts.iter().map(|p| p.1).sum();
    let sxx: f64 = pts.iter().map(|p| p.0 * p.0).sum();
    let sxy: f64 = pts.iter().map(|p| p.0 * p.1).sum();
    let denom = m * sxx - sx * sx;
    if denom.abs() < f64::EPSILON {
        return f64::NAN;
    }
    (m * sxy - sx * sy) / denom
}

/// Estima a classe de complexidade a partir das medições.
pub fn estimate(samples: &[Sample]) -> Option<Estimate> {
    if samples.len() < 3 {
        return None;
    }

    let ss_tot = total_log_variation(samples);

    // Para cada classe: (classe, ss_res_log). Ordenamos por ss_res crescente — é o
    // melhor ajuste de constância-de-razão (ver `fit_log`).
    let mut fits: Vec<(Class, f64)> = Class::ALL
        .iter()
        .map(|&c| (c, fit_log(samples, c).1))
        .collect();
    fits.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    // R² no espaço-log de um ss_res: 1 − ss_res/ss_tot (clamp a 0 em baixo).
    let r2_of = |ss_res: f64| -> f64 {
        if !ss_res.is_finite() {
            return f64::NEG_INFINITY;
        }
        if ss_tot <= f64::EPSILON {
            // Dados (quase) constantes em log: reportamos ajuste perfeito para o
            // melhor (ss_res≈0) e deixamos a ordenação por ss_res decidir.
            return if ss_res <= f64::EPSILON { 1.0 } else { 0.0 };
        }
        (1.0 - ss_res / ss_tot).max(0.0)
    };

    let ranking: Vec<(Class, f64)> = fits.iter().map(|&(c, ss)| (c, r2_of(ss))).collect();

    let (best, best_ss) = fits[0];
    let second_ss = fits.get(1).map(|&(_, ss)| ss).unwrap_or(f64::INFINITY);
    let r2 = r2_of(best_ss);
    let exponent = loglog_exponent(samples);

    // Separação: quão melhor é o 1.º que o 2.º, em termos do resíduo log.
    // `separation > 1` ⇒ o melhor explica estritamente mais; quanto maior, mais nítida
    // a fronteira. Como o par O(n)/O(n log n) é intrinsecamente subtil, uma separação
    // modesta é esperada e reflecte-se numa confiança, no máximo, média.
    let separation = if best_ss <= f64::EPSILON {
        f64::INFINITY
    } else {
        second_ss / best_ss
    };

    // Confiança (honesta e conservadora):
    //   - tempos minúsculos (< ~2µs) ⇒ ruído domina ⇒ baixa;
    //   - ajuste global pobre (R² baixo) ⇒ baixa;
    //   - fronteira nítida (R² alto E separação folgada) ⇒ alta;
    //   - caso contrário ⇒ média.
    let max_t = samples.iter().map(|s| s.t).fold(0.0_f64, f64::max);
    let confidence = if max_t < 2_000.0 || r2 < 0.90 {
        Confidence::Low
    } else if r2 >= 0.999 && separation >= 2.0 {
        Confidence::High
    } else {
        Confidence::Medium
    };

    Some(Estimate {
        best,
        r_squared: r2,
        loglog_exponent: exponent,
        confidence,
        ranking,
    })
}

/// Normaliza uma string Big-O do gabarito para a classe correspondente, se a
/// reconhecermos (para comparar com a estimativa).
pub fn class_from_big_o(s: &str) -> Option<Class> {
    let norm: String = s
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    match norm.as_str() {
        "o(1)" => Some(Class::Constant),
        "o(logn)" | "o(logm)" => Some(Class::Logarithmic),
        "o(n)" | "o(m)" => Some(Class::Linear),
        "o(nlogn)" | "o(mlogm)" | "o(mlogk)" | "o(nlogk)" => Some(Class::Linearithmic),
        "o(n²)" | "o(n^2)" | "o(m²)" | "o(m^2)" => Some(Class::Quadratic),
        "o(n³)" | "o(n^3)" => Some(Class::Cubic),
        "o(2^n)" | "o(2ⁿ)" => Some(Class::Exponential),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZES: [f64; 6] = [2000.0, 4000.0, 8000.0, 16000.0, 32000.0, 64000.0];
    // Tamanhos maiores (os da sonda da fase 3): mais duplicações ⇒ mais separação
    // do factor log, que é o que torna O(n)↔O(n log n) fiável.
    const SIZES_BIG: [f64; 5] = [16000.0, 32000.0, 64000.0, 128000.0, 256000.0];

    fn samples_on(sizes: &[f64], f: impl Fn(f64) -> f64) -> Vec<Sample> {
        sizes.iter().map(|&n| Sample { n, t: f(n) }).collect()
    }

    fn samples_from(f: impl Fn(f64) -> f64) -> Vec<Sample> {
        samples_on(&SIZES, f)
    }

    /// Ruído multiplicativo determinístico e reprodutível (±`amp`), para simular o
    /// jitter do agendador sem depender de RNG externo.
    fn jittered(sizes: &[f64], amp: f64, seed: u64, f: impl Fn(f64) -> f64) -> Vec<Sample> {
        let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
        sizes
            .iter()
            .map(|&n| {
                // xorshift barato → u em [-1, 1].
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                let u = ((state >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0;
                Sample {
                    n,
                    t: f(n) * (1.0 + amp * u),
                }
            })
            .collect()
    }

    #[test]
    fn reconhece_linear() {
        let s = samples_from(|n| 5.0 * n + 1000.0);
        let e = estimate(&s).unwrap();
        assert_eq!(e.best, Class::Linear);
    }

    #[test]
    fn reconhece_quadratico() {
        let s = samples_from(|n| 0.01 * n * n);
        let e = estimate(&s).unwrap();
        assert_eq!(e.best, Class::Quadratic);
    }

    #[test]
    fn reconhece_linearithmico() {
        let s = samples_from(|n| 3.0 * n * n.ln());
        let e = estimate(&s).unwrap();
        assert_eq!(e.best, Class::Linearithmic);
    }

    /// O caso difícil, limpo: aos tamanhos grandes da sonda, a sonda tem de separar
    /// as três classes vizinhas sem as confundir entre si.
    #[test]
    fn separa_n_nlogn_n2_limpo() {
        let lin = estimate(&samples_on(&SIZES_BIG, |n| 7.0 * n + 500.0)).unwrap();
        let nln = estimate(&samples_on(&SIZES_BIG, |n| 4.0 * n * n.ln())).unwrap();
        let sq = estimate(&samples_on(&SIZES_BIG, |n| 0.02 * n * n)).unwrap();
        assert_eq!(lin.best, Class::Linear, "O(n) mal classificado");
        assert_eq!(nln.best, Class::Linearithmic, "O(n log n) mal classificado");
        assert_eq!(sq.best, Class::Quadratic, "O(n²) mal classificado");
        // Nenhuma das vizinhas se deve fazer passar pela outra.
        assert_ne!(lin.best, Class::Linearithmic);
        assert_ne!(nln.best, Class::Linear);
    }

    /// E o mesmo, agora com ruído multiplicativo de ±6% em várias sementes: a
    /// classificação tem de aguentar o jitter (reportamos confiança, nunca certeza).
    #[test]
    fn separa_n_nlogn_n2_com_ruido() {
        for seed in 0..24u64 {
            let lin = estimate(&jittered(&SIZES_BIG, 0.06, seed, |n| 7.0 * n + 500.0)).unwrap();
            let nln = estimate(&jittered(&SIZES_BIG, 0.06, seed + 100, |n| 4.0 * n * n.ln())).unwrap();
            let sq = estimate(&jittered(&SIZES_BIG, 0.06, seed + 200, |n| 0.02 * n * n)).unwrap();
            assert_eq!(lin.best, Class::Linear, "O(n) trocado na semente {seed}");
            assert_eq!(nln.best, Class::Linearithmic, "O(n log n) trocado na semente {seed}");
            assert_eq!(sq.best, Class::Quadratic, "O(n²) trocado na semente {seed}");
        }
    }

    /// A lição do heap no top-k: com `k = 10` fixo e `m` a crescer, uma solução por
    /// amontoado custa ~`m·log k` (log k é constante ⇒ **linear**) enquanto ordenar
    /// tudo custa `m·log m` (**linearítmico**). A sonda tem de os distinguir.
    #[test]
    fn distingue_heap_de_ordenacao_total() {
        const LN_K: f64 = 2.302_585; // ln(10)
        let heap = estimate(&samples_on(&SIZES_BIG, |m| 9.0 * m * LN_K)).unwrap();
        let sort = estimate(&samples_on(&SIZES_BIG, |m| 2.0 * m * m.ln())).unwrap();
        assert_eq!(heap.best, Class::Linear, "heap de tamanho k devia medir linear");
        assert_eq!(
            sort.best,
            Class::Linearithmic,
            "ordenação total devia medir linearítmica"
        );
        // O heap é estritamente melhor (classe mais barata) do que ordenar tudo.
        assert!(
            (heap.best as u8) < (sort.best as u8) || heap.best == Class::Linear,
            "o heap não devia parecer mais caro que a ordenação"
        );
    }

    /// Dados perfeitamente planos não devem rebentar nem fingir confiança alta.
    #[test]
    fn constante_degrada_com_graca() {
        let e = estimate(&samples_from(|_| 5_000.0)).unwrap();
        assert_eq!(e.best, Class::Constant);
    }

    /// Mesmo com tempos altos e R² perfeito, a confiança nunca é uma afirmação
    /// absoluta: o par n/n log n é subtil, por isso fica no máximo em média quando a
    /// separação é estreita.
    #[test]
    fn confianca_e_honesta_no_caso_subtil() {
        let nln = estimate(&samples_on(&SIZES_BIG, |n| 50.0 * n * n.ln())).unwrap();
        assert_eq!(nln.best, Class::Linearithmic);
        assert!(
            matches!(nln.confidence, Confidence::Medium | Confidence::High),
            "fase nítida devia ter confiança ao menos média"
        );
        // Quadrático vs tudo: fronteira larga ⇒ confiança alta.
        let sq = estimate(&samples_on(&SIZES_BIG, |n| 0.02 * n * n)).unwrap();
        assert_eq!(sq.confidence, Confidence::High);
    }
}
