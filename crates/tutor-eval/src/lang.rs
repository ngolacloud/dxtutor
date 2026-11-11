//! Abstracção multi-linguagem do avaliador.
//!
//! O avaliador do dxtutor tinha duas responsabilidades presas ao Rust: julgar a
//! **correcção** (via `cargo test`) e **estimar a complexidade** (cronometrando a
//! solução do aluno em tamanhos crescentes). Este módulo extrai esse contrato para
//! um trait — [`LanguageRunner`] — para que cada linguagem o sirva à sua maneira,
//! mantendo intacta a API pública ([`assess`], [`Assessment`], [`Correctness`]) e o
//! princípio de **honestidade**: correcção = testes da linguagem; complexidade =
//! estimativa empírica declarada como tal; nunca fingida.
//!
//! # O contrato
//!
//! Três operações, cada uma com uma fonte-da-verdade clara:
//!
//! 1. [`LanguageRunner::check_correctness`] — corre os testes da fase na linguagem
//!    dela e devolve o veredicto. **Fonte da verdade da correcção.**
//! 2. [`LanguageRunner::probe_complexity`] — cronometra a solução do aluno em `n`
//!    crescente e devolve os pontos `(n, t)` para [`crate::complexity::estimate`]. O
//!    tempo é medido **em Rust** (`Instant`), à volta da invocação do código do
//!    aluno, seja ele um subprocesso (Rust) ou uma chamada a um motor embebido (JS).
//! 3. [`LanguageRunner::diagnostics`] — erros de compilação/sintaxe/execução com
//!    **posição** (`linha`, `coluna`), matéria-prima para a futura «linha vermelha»
//!    no editor.
//!
//! # Despacho
//!
//! [`assess`] escolhe o runner por [`Phase::language`] (herdada do projecto no banco
//! de conteúdo) e orquestra o fluxo comum: corre a correcção; se passar e a fase tiver
//! sonda, mede a complexidade e compara com a classe esperada. Este fluxo é idêntico
//! para todas as linguagens — só o *como* (compilar-e-correr vs. motor embebido) muda.
//!
//! # Adicionar uma linguagem (TS/Python/Go/C…) é *aditivo*
//!
//! Basta um novo tipo que implemente [`LanguageRunner`] e uma linha em [`runner_for`].
//! Nada no fluxo de [`assess`], no modelo de conteúdo, ou no estimador de complexidade
//! precisa de mudar: os snippets da fase (`starter`, `tests`, `probe.generator`,
//! `probe.call`) passam a ser interpretados na nova linguagem, e o par `(n, t)` que a
//! sonda produz é agnóstico. É por isso que o trait é a fronteira certa.

use anyhow::Result;
use tutor_core::Phase;

use crate::complexity::{self, Estimate, Sample};
use crate::go_runner::GoRunner;
use crate::js_runner::JsRunner;
use crate::runner::RustRunner;
pub use crate::runner::{Assessment, Correctness};

/// Severidade de um [`Diagnostic`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

/// Um diagnóstico posicional sobre o código do aluno — um erro (ou aviso) de
/// compilação/sintaxe/execução, ancorado a uma `linha`/`coluna` (base 1; `0`
/// significa «posição desconhecida»). É o que o editor precisa para desenhar a
/// futura «linha vermelha» por baixo do ponto exacto do erro.
#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub line: u32,
    pub col: u32,
    pub severity: Severity,
    pub message: String,
}

/// O contrato que cada linguagem serve. Ver o cabeçalho do módulo para o desenho.
pub trait LanguageRunner {
    /// Julga a **correcção** de `student_code` contra os testes da `phase`. Fonte da
    /// verdade — nunca uma heurística.
    fn check_correctness(&self, phase: &Phase, student_code: &str) -> Result<Correctness>;

    /// Cronometra `student_code` em tamanhos crescentes (definidos por `phase.probe`)
    /// e devolve os pontos `(n, t)` para a estimativa empírica de complexidade. O
    /// tempo é medido em Rust à volta da invocação do código do aluno.
    ///
    /// Erro se a fase não tiver sonda — quem chama deve verificar `phase.probe` antes.
    fn probe_complexity(&self, phase: &Phase, student_code: &str) -> Result<Vec<Sample>>;

    /// Diagnósticos posicionais (erros de compilação/sintaxe/execução) sobre o código
    /// do aluno isolado. Lista vazia ⇒ sem erros detectados.
    fn diagnostics(&self, student_code: &str) -> Result<Vec<Diagnostic>>;
}

/// Avaliação completa de uma submissão a uma fase: corre a correcção na linguagem da
/// fase e, se passar e houver sonda, mede a complexidade.
///
/// Compatibilidade: a assinatura e o comportamento para `language = "rust"` são
/// idênticos ao avaliador original — os consumidores (`tutor-cli`, `tutor-tui`) não
/// notam a diferença.
pub fn assess(phase: &Phase, student_code: &str) -> Result<Assessment> {
    let runner = runner_for(&phase.language);

    let correctness = runner.check_correctness(phase, student_code)?;

    let (complexity, expected) = if correctness.passed {
        if let Some(probe) = &phase.probe {
            let samples = runner.probe_complexity(phase, student_code)?;
            let est = complexity::estimate(&samples);
            let exp = complexity::class_from_big_o(&probe.expected);
            (est, exp)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    Ok(Assessment {
        correctness,
        complexity,
        expected,
    })
}

/// Diagnósticos posicionais para o código do aluno, escolhendo o runner pela
/// linguagem da fase. Exposto para o editor pedir a «linha vermelha» sem correr a
/// avaliação inteira.
pub fn diagnostics(phase: &Phase, student_code: &str) -> Result<Vec<Diagnostic>> {
    runner_for(&phase.language).diagnostics(student_code)
}

/// Like [`diagnostics`], but keyed directly on a language string — handy for the
/// guided course, where a step has a language but not a full [`Phase`].
pub fn diagnostics_for(language: &str, student_code: &str) -> Result<Vec<Diagnostic>> {
    runner_for(language).diagnostics(student_code)
}

/// Escolhe o [`LanguageRunner`] para uma linguagem. A precedência é:
///
/// 1. Os **runners nativos** hand-escritos (`rust`/`go`/`js`), inalterados — têm
///    capacidades (sonda de complexidade, motor embebido) que os plugins declarativos
///    não dão.
/// 2. Um **plugin declarativo** registado ([`crate::plugin::find_plugin`]) cujo
///    `id`/alias/extensão bata — é por aqui que a comunidade acrescenta uma linguagem
///    sem escrever Rust (ver [`crate::plugin`]).
/// 3. Senão, cai no avaliador **Rust** (o histórico), preservando o comportamento por
///    omissão.
fn runner_for(language: &str) -> Box<dyn LanguageRunner> {
    match language.trim().to_ascii_lowercase().as_str() {
        "js" | "javascript" => Box::new(JsRunner::new()),
        "go" | "golang" => Box::new(GoRunner::new()),
        "rust" | "rs" => Box::new(RustRunner),
        other => {
            // Um plugin declarativo registado tem prioridade sobre o fallback Rust.
            if let Some(plugin) = crate::plugin::find_plugin(other) {
                Box::new(crate::plugin::PluginRunner::new(plugin))
            } else {
                // Qualquer valor não reconhecido cai no avaliador Rust (histórico).
                Box::new(RustRunner)
            }
        }
    }
}

/// Estimativa de complexidade a partir de pontos já medidos — reexportada por
/// conveniência de quem implementa um runner e quer validar os seus próprios pontos.
pub fn estimate_from(samples: &[Sample]) -> Option<Estimate> {
    complexity::estimate(samples)
}
