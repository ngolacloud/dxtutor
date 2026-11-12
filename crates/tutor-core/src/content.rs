//! Banco de conteúdo curado, embebido no binário via `include_str!`.
//!
//! Cada projecto é um ficheiro TOML em `content/`. Começar por embeber mantém o
//! editor auto-contido; externalizar para ficheiros de dados em disco é um passo
//! posterior trivial (o formato já é dados).

use crate::model::Project;

const RUST_WORD_FREQUENCY: &str = include_str!("../content/rust-word-frequency.toml");
const RUST_COUNT_CHARS: &str = include_str!("../content/rust-count-chars.toml");
const JS_TEXT_METRICS: &str = include_str!("../content/js-text-metrics.toml");

/// Todos os projectos-tutor embebidos.
pub fn builtin_projects() -> Vec<Project> {
    vec![
        parse("rust-word-frequency", RUST_WORD_FREQUENCY),
        parse("rust-count-chars", RUST_COUNT_CHARS),
        parse("js-text-metrics", JS_TEXT_METRICS),
    ]
}

/// Carrega um projecto pelo seu `id`.
pub fn load_project(id: &str) -> Option<Project> {
    builtin_projects().into_iter().find(|p| p.id == id)
}

/// Encontra uma fase pelo seu `id` em QUALQUER projecto embebido. Serve o caminho de
/// pistas curadas (offline) sem o chamador precisar de saber a que projecto a fase
/// pertence.
pub fn find_phase(id: &str) -> Option<crate::model::Phase> {
    builtin_projects()
        .into_iter()
        .flat_map(|p| p.phases.into_iter())
        .find(|ph| ph.id == id)
}

fn parse(name: &str, raw: &str) -> Project {
    let mut project: Project =
        toml::from_str(raw).unwrap_or_else(|e| panic!("conteúdo inválido em {name}.toml: {e}"));
    // Herança de linguagem: uma fase sem `language` explícito assume a do projecto.
    // Mantém o conteúdo monolingue limpo (não repete `language` por fase) e dá ao
    // avaliador um campo por-fase sempre preenchido para despachar o runner.
    for phase in &mut project.phases {
        if phase.language.trim().is_empty() {
            phase.language = project.language.clone();
        }
    }
    project
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todos_os_projectos_embebidos_parseiam() {
        let projects = builtin_projects();
        assert!(!projects.is_empty());
        for p in &projects {
            assert!(!p.phases.is_empty(), "projecto {} sem fases", p.id);
            for ph in &p.phases {
                assert!(!ph.tests.trim().is_empty(), "fase {} sem testes", ph.id);
                assert!(
                    !ph.gabarito.solution.trim().is_empty(),
                    "fase {} sem gabarito",
                    ph.id
                );
            }
        }
    }

    /// Secção 4: o cenário "contar caracteres" existe e ancora a sua lição honesta no
    /// contra-exemplo bytes-vs-escalares — uma solução que conta bytes devolveria 5 para
    /// "ação", por isso o teste tem de exigir 4.
    #[test]
    fn contar_caracteres_ancora_o_contra_exemplo_unicode() {
        let p = load_project("rust-count-chars").expect("projecto count-chars embebido");
        let phase = &p.phases[0];
        assert_eq!(phase.entry, "count_chars");
        assert_eq!(phase.language, "rust"); // herdada do projecto
        // O teste oculto exige a contagem por valores escalares (4), não por bytes (5).
        assert!(
            phase.tests.contains("count_chars(\"ação\"), 4"),
            "falta o contra-exemplo bytes-vs-escalares"
        );
        // O gabarito usa a via honesta (chars), não .len() (bytes).
        assert!(phase.gabarito.solution.contains(".chars().count()"));
        assert!(!phase.gabarito.solution.contains(".len()"));
    }

    /// As pistas curadas são progressivas: a 1ª mostra o contra-exemplo, a última aponta
    /// para `chars()`. O helper `hint(level)` clampa aos limites (nunca entrega o código).
    #[test]
    fn pistas_progressivas_do_contar_caracteres() {
        let p = load_project("rust-count-chars").expect("projecto count-chars");
        let phase = &p.phases[0];
        assert_eq!(phase.hints.len(), 3, "esperam-se 3 pistas progressivas");
        // 1ª pista = o contra-exemplo "ação".
        assert!(phase.hint(1).unwrap().contains("ação"));
        // A última aponta a documentação / via honesta sem dar a solução completa.
        assert!(phase.hint(3).unwrap().contains("chars()"));
        // Clamp: nível 0 → a 1ª; nível acima do fim → a última.
        assert_eq!(phase.hint(0), phase.hint(1));
        assert_eq!(phase.hint(9), phase.hint(3));
        // Nenhuma pista entrega a solução literal.
        for h in &phase.hints {
            assert!(!h.contains(".chars().count()"), "a pista não deve dar o código");
        }
    }

    /// A variação (secção 4) exercita o MESMO conceito noutro problema: inverter por
    /// caracteres. Mantém o contra-exemplo "ação" e o gabarito honesto (chars, não bytes).
    #[test]
    fn variacao_inverter_por_caracteres() {
        let p = load_project("rust-count-chars").expect("projecto count-chars");
        let phase = p.phase("p2-reverse-chars").expect("fase da variação existe");
        assert_eq!(phase.entry, "reverse_chars");
        assert!(phase.tests.contains("reverse_chars(\"ação\"), \"oãça\""));
        assert!(phase.gabarito.solution.contains(".chars().rev().collect()"));
        assert_eq!(phase.hints.len(), 3);
        assert!(phase.hint(1).unwrap().contains("ação"));
    }

    /// `find_phase` locates a phase across every project, so the curated-hint path works
    /// without knowing which project owns it.
    #[test]
    fn find_phase_atravessa_projectos() {
        let ph = find_phase("p1-count-chars").expect("fase existe em qualquer projecto");
        assert_eq!(ph.entry, "count_chars");
        assert!(ph.hint(1).is_some(), "fase traz pistas curadas");
        assert!(find_phase("fase-que-nao-existe").is_none());
    }
}
