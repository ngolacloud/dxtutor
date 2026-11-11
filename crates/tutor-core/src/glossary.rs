//! Glossário de palavras reservadas e itens centrais da linguagem.
//!
//! Camada de **andaime pedagógico**: cada entrada explica o que uma palavra-chave
//! faz, quando a usar e um exemplo de uma linha. É conteúdo curado e embebido no
//! binário (sem rede), carregado por linguagem via [`load_glossary`].

use serde::Deserialize;

/// Um glossário completo para uma linguagem.
#[derive(Debug, Clone, Deserialize)]
pub struct Glossary {
    pub language: String,
    #[serde(rename = "entry", default)]
    pub entries: Vec<GlossaryEntry>,
}

/// Uma entrada do glossário: uma palavra reservada ou item central da linguagem.
#[derive(Debug, Clone, Deserialize)]
pub struct GlossaryEntry {
    /// A palavra reservada ou item (ex.: `fn`, `let`, `String`).
    pub keyword: String,
    /// O que faz, em uma ou duas frases.
    pub summary: String,
    /// Melhores contextos para a usar.
    #[serde(default)]
    pub when_to_use: String,
    /// Exemplo de uma linha.
    #[serde(default)]
    pub example: String,
}

const RUST_GLOSSARY: &str = include_str!("../content/rust-glossary.toml");

/// Todos os glossários embebidos no binário.
pub fn builtin_glossaries() -> Vec<Glossary> {
    vec![parse("rust-glossary", RUST_GLOSSARY)]
}

/// Carrega o glossário de uma linguagem (ex.: `"rust"`). Devolve `None` quando a
/// linguagem não tem glossário curado.
pub fn load_glossary(language: &str) -> Option<Glossary> {
    let want = language.trim();
    builtin_glossaries()
        .into_iter()
        .find(|g| g.language.eq_ignore_ascii_case(want))
}

fn parse(name: &str, raw: &str) -> Glossary {
    toml::from_str(raw).unwrap_or_else(|e| panic!("glossário inválido em {name}.toml: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_glossary_carrega_e_tem_entradas() {
        let g = load_glossary("rust").expect("glossário rust");
        assert_eq!(g.language, "rust");
        assert!(
            g.entries.len() >= 15,
            "esperadas ~15-20 entradas, vieram {}",
            g.entries.len()
        );
        // Cada entrada está completa.
        for e in &g.entries {
            assert!(!e.keyword.trim().is_empty(), "entrada sem keyword");
            assert!(!e.summary.trim().is_empty(), "entrada {} sem summary", e.keyword);
            assert!(
                !e.when_to_use.trim().is_empty(),
                "entrada {} sem when_to_use",
                e.keyword
            );
            assert!(!e.example.trim().is_empty(), "entrada {} sem example", e.keyword);
        }
        // Linguagem desconhecida não traz glossário.
        assert!(load_glossary("cobol").is_none());
    }
}
