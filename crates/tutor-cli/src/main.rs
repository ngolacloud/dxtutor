//! `dxt` — demo de prova do cérebro do dxtutor (avaliação + gabarito + sonda).
//!
//! Ainda não é o editor TUI; é o arnês que prova, ponta-a-ponta, que o avaliador
//! julga correcção pelos testes e estima a complexidade empiricamente.

use anyhow::{bail, Result};
use tutor_core::{load_project, Phase, Project};
use tutor_eval::{assess, Assessment, Class, Confidence};

fn main() -> Result<()> {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "tui".to_string());
    match cmd.as_str() {
        "tui" => tutor_tui::run("rust-word-frequency"),
        "snapshot" => {
            let phase: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(0);
            let gab = std::env::args().any(|a| a == "--gabarito");
            print!("{}", tutor_tui::snapshot("rust-word-frequency", phase, gab)?);
            Ok(())
        }
        "demo" => demo(),
        "list" => list(),
        "-h" | "--help" | "help" => {
            println!("dxt — editor-tutor\n\n  dxt          abre o editor TUI\n  dxt demo     prova o avaliador no terminal\n  dxt list     lista as fases do projecto");
            Ok(())
        }
        other => bail!("comando desconhecido: {other} (usa: tui | demo | list)"),
    }
}

fn load() -> Result<Project> {
    load_project("rust-word-frequency").ok_or_else(|| anyhow::anyhow!("projecto não encontrado"))
}

fn list() -> Result<()> {
    let p = load()?;
    println!("{}  [{}]", p.title, p.language);
    for (i, ph) in p.phases.iter().enumerate() {
        println!("  {}. {}  ({:?})", i + 1, ph.title, ph.level);
    }
    Ok(())
}

fn demo() -> Result<()> {
    let project = load()?;
    banner(&format!("PROJECTO-TUTOR: {}", project.title));
    println!("{}", project.summary.trim());
    println!();
    for (i, ph) in project.phases.iter().enumerate() {
        println!("  Fase {}: {}  [{:?}]", i + 1, ph.title, ph.level);
    }

    let phase = project
        .phase("p1-tokenize")
        .expect("fase 1 existe")
        .clone();

    banner(&format!("FASE EM FOCO — {}", phase.title));
    println!("{}", strip_md(&phase.instructions));

    // ── Tentativa A: o gabarito (correcto e óptimo) ──────────────────────────
    banner("TENTATIVA A — solução do gabarito (esperada O(n))");
    let a = assess(&phase, &phase.gabarito.solution)?;
    report(&a);

    // ── Tentativa B: correcta MAS quadrática ─────────────────────────────────
    banner("TENTATIVA B — correcta, mas acidentalmente O(n²)");
    println!(
        "O aluno varre tudo o que já acumulou a cada palavra. O resultado é idêntico\n\
         (passa os testes!), mas o tempo explode. É exactamente o erro que o gabarito avisa.\n"
    );
    let b = assess(&phase, QUADRATIC_TOKENIZE)?;
    report(&b);

    // ── Revelação do gabarito ────────────────────────────────────────────────
    banner("GABARITO — a melhor forma de resolver");
    reveal_gabarito(&phase);

    banner("CONCLUSÃO");
    println!(
        "Ambas as tentativas PASSARAM a correcção — porque ambas estão certas.\n\
         A sonda de complexidade é que separou o aprendiz do engenheiro: a tentativa B\n\
         comporta-se como O(n²) quando o óptimo é O(n). É esta a lição que o tutor dá,\n\
         e dá-la de forma honesta: mede, compara com o gabarito curado, e explica."
    );
    Ok(())
}

fn report(a: &Assessment) {
    let mark = if a.correctness.passed { "✓ PASSOU" } else { "✗ FALHOU" };
    println!("  Correcção: {mark}  ({})", a.correctness.summary);
    if !a.correctness.passed {
        println!("  ---- saída dos testes ----");
        for line in a.correctness.raw.lines().take(20) {
            println!("  {line}");
        }
        return;
    }

    match &a.complexity {
        None => println!("  Complexidade: (fase sem sonda)"),
        Some(est) => {
            let conf = match est.confidence {
                Confidence::High => "alta",
                Confidence::Medium => "média",
                Confidence::Low => "baixa",
            };
            println!(
                "  Complexidade medida: {}  (R²={:.3}, expoente log-log p={:.2}, confiança {})",
                est.big_o(),
                est.r_squared,
                est.loglog_exponent,
                conf
            );
            if let Some(expected) = a.expected {
                print!("  Esperado (gabarito): {}  →  ", expected.big_o());
                println!("{}", verdict(est.best, expected));
            }
            // Mostra o pódio do ajuste para transparência.
            let podium: Vec<String> = est
                .ranking
                .iter()
                .take(3)
                .map(|(c, r2)| format!("{} (R²={:.3})", c.big_o(), r2))
                .collect();
            println!("  Ajuste candidato: {}", podium.join("  |  "));
        }
    }
}

fn verdict(measured: Class, expected: Class) -> String {
    use std::cmp::Ordering;
    match rank(measured).cmp(&rank(expected)) {
        Ordering::Equal => "✓ bate o óptimo do gabarito".to_string(),
        Ordering::Less => "✓ (melhor que o esperado — invulgar; verifica a correcção)".to_string(),
        Ordering::Greater => {
            "⚠ PIOR que o óptimo — correcto, mas há uma solução mais eficiente (vê o gabarito)"
                .to_string()
        }
    }
}

/// Ordem crescente de custo assintótico, para comparar classes.
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

fn reveal_gabarito(phase: &Phase) {
    let g = &phase.gabarito;
    println!("Complexidade de referência:  tempo {}   espaço {}\n", g.time, g.space);
    println!("--- solução ---");
    println!("{}", g.solution.trim());
    println!("\n--- porquê ---");
    println!("{}", strip_md(&g.justification));
}

fn banner(title: &str) {
    println!("\n{}", "═".repeat(74));
    println!("  {title}");
    println!("{}", "═".repeat(74));
}

/// Markdown→texto simples o suficiente para o terminal da demo.
fn strip_md(s: &str) -> String {
    s.trim()
        .lines()
        .map(|l| l.trim_start_matches('#').trim_start())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Tokenize correcto mas O(n²): varre o acumulado a cada palavra.
const QUADRATIC_TOKENIZE: &str = r#"
pub fn tokenize(input: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in input.split(|c: char| !c.is_alphanumeric()) {
        if part.is_empty() {
            continue;
        }
        let w = part.to_lowercase();
        // Varredura desnecessária do que já foi acumulado: torna isto O(n²).
        let mut dups = 0usize;
        for existing in &out {
            if *existing == w {
                dups += 1;
            }
        }
        std::hint::black_box(dups);
        out.push(w);
    }
    out
}
"#;
