//! Modelo de domínio do tutor.
//!
//! Um [`Project`] é uma trilha de aprendizagem numa linguagem, composta por
//! [`Phase`]s ordenadas do básico ao avançado. Cada fase tem um desafio
//! (instruções + código inicial + testes ocultos) e um [`Gabarito`] — a solução
//! de referência com a sua complexidade *provada por quem a curou*.

use serde::Deserialize;

/// Uma trilha de aprendizagem completa numa linguagem.
#[derive(Debug, Clone, Deserialize)]
pub struct Project {
    pub id: String,
    pub language: String,
    pub title: String,
    pub summary: String,
    #[serde(rename = "phase")]
    pub phases: Vec<Phase>,
}

impl Project {
    pub fn phase(&self, id: &str) -> Option<&Phase> {
        self.phases.iter().find(|p| p.id == id)
    }
}

/// Nível pedagógico de uma fase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    #[serde(alias = "básico", alias = "basico")]
    Basico,
    Intermedio,
    Avancado,
}

/// Uma fase do projecto: um desafio com gabarito.
#[derive(Debug, Clone, Deserialize)]
pub struct Phase {
    pub id: String,
    pub title: String,
    pub level: Level,
    /// Linguagem desta fase (ex.: `"rust"`, `"js"`). Determina que avaliador a
    /// julga. Em branco no TOML, o banco de conteúdo herda a linguagem do
    /// [`Project`] — por isso o conteúdo monolingue não precisa de a repetir por
    /// fase (ver `content::parse`). O avaliador normaliza/usa este campo.
    #[serde(default)]
    pub language: String,
    /// Instruções em Markdown: o que fazer nesta fase.
    pub instructions: String,
    /// Nome da função que o aluno deve implementar (ponto de entrada).
    pub entry: String,
    /// Código inicial colocado no editor.
    pub starter: String,
    /// Testes ocultos (Rust) que julgam a **correcção**. Fonte da verdade.
    pub tests: String,
    /// A solução de referência e a sua complexidade curada.
    pub gabarito: Gabarito,
    /// Sonda opcional para medir empiricamente a complexidade da solução do aluno.
    pub probe: Option<Probe>,
    /// Extra Cargo dependencies for the student crate (Rust), as raw
    /// `[dependencies]` lines — e.g. `rusqlite = { version = "0.31", features =
    /// ["bundled"] }`. Empty for std-only phases; written verbatim into the
    /// scaffolded `Cargo.toml`. For Go the evaluator resolves imports with
    /// `go mod tidy`, so this stays empty there.
    #[serde(default)]
    pub dependencies: Vec<String>,
}

/// Gabarito: a melhor forma de resolver, com a complexidade atada.
#[derive(Debug, Clone, Deserialize)]
pub struct Gabarito {
    pub solution: String,
    /// Complexidade temporal de referência, ex.: `"O(n log n)"`.
    pub time: String,
    /// Complexidade espacial de referência, ex.: `"O(n)"`.
    pub space: String,
    /// Justificação em Markdown: porquê esta complexidade, que matemática a sustenta.
    pub justification: String,
}

/// Define como cronometrar a solução do aluno em tamanhos crescentes.
#[derive(Debug, Clone, Deserialize)]
pub struct Probe {
    /// Preâmbulo opcional (imports, tipos auxiliares) colocado no topo da sonda.
    #[serde(default)]
    pub prelude: String,
    /// Função geradora de entrada: `fn gen(n: usize) -> T { ... }`.
    pub generator: String,
    /// Instruções que invocam o código do aluno usando a variável `input`.
    /// Deve embrulhar o resultado em `black_box(...)` para evitar optimização morta.
    pub call: String,
    /// Tamanhos de entrada a cronometrar (crescentes).
    pub sizes: Vec<usize>,
    /// Classe de complexidade esperada para a solução óptima, ex.: `"O(n)"`.
    pub expected: String,
}
