//! Guias de estudo de remediação, por unidade.
//!
//! Camada de **andaime pedagógico** para quem está a ter dificuldade: quando a
//! acertividade do aluno numa unidade é baixa, o frontend pode pedir este guia,
//! que re-explica com calma os conceitos da unidade e encoraja a não desistir.
//! Conteúdo curado e embebido, carregado por linguagem + unidade via
//! [`load_study_guide`].

use serde::Deserialize;

/// Um guia de estudo de uma unidade.
#[derive(Debug, Clone, Deserialize)]
pub struct StudyGuide {
    /// Unidade a que corresponde (ex.: `"u1-hello"`).
    pub unit_id: String,
    /// Título do guia.
    pub title: String,
    /// Corpo em markdown: a re-explicação, com calma.
    pub body: String,
}

/// Ficheiro de guias de uma linguagem: cabeçalho `language` + lista de `[[guide]]`.
#[derive(Debug, Clone, Deserialize)]
struct StudyGuideFile {
    language: String,
    #[serde(rename = "guide", default)]
    guides: Vec<StudyGuide>,
}

const RUST_STUDY_GUIDES: &str = include_str!("../content/rust-study-guides.toml");

fn builtin_files() -> Vec<StudyGuideFile> {
    vec![parse("rust-study-guides", RUST_STUDY_GUIDES)]
}

/// Carrega o guia de estudo de uma unidade numa linguagem. Devolve `None` quando
/// não existe guia para esse par `(language, unit_id)`.
pub fn load_study_guide(language: &str, unit_id: &str) -> Option<StudyGuide> {
    let want_lang = language.trim();
    let want_unit = unit_id.trim();
    builtin_files()
        .into_iter()
        .filter(|f| f.language.eq_ignore_ascii_case(want_lang))
        .flat_map(|f| f.guides.into_iter())
        .find(|g| g.unit_id == want_unit)
}

fn parse(name: &str, raw: &str) -> StudyGuideFile {
    toml::from_str(raw).unwrap_or_else(|e| panic!("guias inválidos em {name}.toml: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_study_guide_da_unidade_hello_carrega() {
        let guide = load_study_guide("rust", "u1-hello").expect("guia u1-hello");
        assert_eq!(guide.unit_id, "u1-hello");
        assert!(!guide.title.trim().is_empty(), "guia sem título");
        assert!(
            guide.body.len() > 100,
            "corpo do guia demasiado curto ({} chars)",
            guide.body.len()
        );
        // Par desconhecido não traz guia.
        assert!(load_study_guide("rust", "u9-unknown").is_none());
        assert!(load_study_guide("cobol", "u1-hello").is_none());
    }
}
