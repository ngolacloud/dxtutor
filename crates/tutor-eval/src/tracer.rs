//! Visualizador de execução passo-a-passo (estilo "Python Tutor") — **honesto**.
//!
//! Corre um programa do aluno sob `sys.settrace` e devolve um TRAÇO REAL da
//! execução: cada passo é uma linha/call/return efectivamente executada, com as
//! variáveis locais do frame do aluno, a profundidade da pilha e o comprimento do
//! stdout acumulado até esse ponto. Nada é inventado — o traço é o que o CPython
//! observou mesmo.
//!
//! # Desenho
//!
//! 1. Um **harness** Python embebido ([`HARNESS`], o ficheiro `trace_harness.py`)
//!    instala `sys.settrace`, executa o código do aluno num namespace próprio (via
//!    `exec`) e, a cada evento de linha/call/return do **ficheiro do aluno**
//!    (ignorando frames internos), regista `{line, event, func, depth, locals,
//!    stdout_len}`. O stdout do programa é capturado por redirecção de `sys.stdout`
//!    e não contamina o JSON. Ao fim, emite para o stdout real um único objecto
//!    JSON `{steps, stdout, error?, truncated?}`. Um tecto de passos
//!    ([`MAX_STEPS`](trace_harness) = 2000) aborta ordenadamente a execução e
//!    assinala a truncagem.
//! 2. O lado Rust corre `python3` como **subprocesso sandboxado** com o mesmo
//!    endurecimento do avaliador ([`crate::runner`]): ambiente mínimo
//!    (`env_clear` + o essencial + `PYTHON*` seguras), grupo/sessão próprios
//!    (`setsid`/`killpg`), `setrlimit` (CPU/AS/FSIZE/NPROC) e um timeout de
//!    parede. Lê o JSON do stdout e devolve-o como [`ExecutionTrace`].
//!
//! Para outras linguagens (ex.: Rust) devolve-se `supported = false` com uma nota
//! honesta: o traço passo-a-passo precisaria de um depurador (gdb/lldb) que não
//! está aqui integrado.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::runner::{run_guarded, Rlimits};

/// O harness Python embebido no binário (fonte única da verdade do traço).
const HARNESS: &str = include_str!("trace_harness.py");

/// Tempo de parede máximo para o traçado (inclui o arranque do interpretador).
/// Um programa legítimo instrumentado por `settrace` é algumas ordens mais lento
/// que a execução directa, por isso damos a mesma folga da sonda.
const TRACE_TIMEOUT: Duration = Duration::from_secs(15);

/// Limites de recursos para o processo `python3`. Mais folga de espaço de
/// endereçamento que a sonda Rust: o interpretador CPython mapeia bem mais
/// memória virtual ao arrancar que um binário Rust nu.
const TRACE_LIMITS: Rlimits = Rlimits {
    cpu_secs: 20,
    as_bytes: 2 * 1024 * 1024 * 1024,
    fsize_bytes: 64 * 1024 * 1024,
    nproc: 256,
};

// ── Modelo de domínio (reexportado) ──────────────────────────────────────────

/// Uma variável local observada num passo: nome, `repr()` truncado e o
/// `type(...).__name__`. Tudo lido do frame real do aluno.
#[derive(Debug, Clone, Deserialize)]
pub struct Var {
    pub name: String,
    pub value: String,
    pub ty: String,
}

/// Um passo do traço: a linha prestes a executar (ou o call/return), a função, a
/// profundidade da pilha, as variáveis locais e o comprimento do stdout até aqui.
#[derive(Debug, Clone, Deserialize)]
pub struct TraceStep {
    /// `f_lineno` do frame — a linha (base 1) a que o evento ocorreu.
    pub line: u32,
    /// `"line"`, `"call"` ou `"return"`.
    pub event: String,
    /// `co_name` do frame (`"<module>"` no topo).
    pub func: String,
    /// Profundidade da pilha de frames do aluno (módulo = 0).
    pub depth: u32,
    /// Variáveis locais do frame nesse instante.
    pub locals: Vec<Var>,
    /// Comprimento, em caracteres, do stdout acumulado até este passo.
    pub stdout_len: u32,
}

/// O traço completo de uma execução. `supported = false` para linguagens sem
/// suporte de traçado aqui (com a razão honesta em `notes`).
#[derive(Debug, Clone)]
pub struct ExecutionTrace {
    pub supported: bool,
    pub notes: String,
    pub steps: Vec<TraceStep>,
    pub stdout: String,
}

// ── Desserialização do JSON do harness ───────────────────────────────────────

#[derive(Deserialize)]
struct HarnessOutput {
    steps: Vec<TraceStep>,
    stdout: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    truncated: Option<u32>,
}

// ── API pública ──────────────────────────────────────────────────────────────

/// Traça a execução de `code` na linguagem `language`. Só `"python"` (ou `"py"`)
/// é suportado aqui; as restantes devolvem `supported = false` com nota honesta.
pub fn trace_execution(language: &str, code: &str) -> Result<ExecutionTrace> {
    match language.trim().to_ascii_lowercase().as_str() {
        "python" | "py" | "python3" => trace_python(code),
        // Rust não tem `settrace`; traçamo-lo por instrumentação de código-fonte
        // (parse com `syn`, injecção de chamadas de traço). Ver [`crate::rust_tracer`].
        "rust" | "rs" => crate::rust_tracer::trace_rust(code),
        // Go ainda não tem traçador aqui: precisaria de um depurador (delve) ou de
        // instrumentação do AST (go/ast), nenhum integrado. Honestamente não suportado.
        "go" | "golang" => Ok(ExecutionTrace {
            supported: false,
            notes: "Step-through execution tracing for Go is coming; it would need a \
                    debugger (delve) or AST instrumentation, which isn't wired up yet."
                .to_string(),
            steps: Vec::new(),
            stdout: String::new(),
        }),
        other => Ok(ExecutionTrace {
            supported: false,
            notes: format!(
                "Step-through execution tracing is available for Python and Rust here; {other} \
                 would need a debugger (gdb/lldb), which isn't installed."
            ),
            steps: Vec::new(),
            stdout: String::new(),
        }),
    }
}

/// Corre o harness `settrace` sobre `code` com `python3` sandboxado e devolve o
/// traço real. Nunca rebenta por o programa do aluno falhar — o erro de execução
/// vai em `notes` e os passos recolhidos até ali são preservados.
pub fn trace_python(code: &str) -> Result<ExecutionTrace> {
    // Motor != Host ⇒ corre o mesmo harness `settrace` dentro do container
    // `python:3.12-slim`; o JSON sai no stdout do container. Host mantém-se exacto.
    if crate::container::current_engine() != crate::container::SandboxEngine::Host {
        return trace_python_container(code);
    }

    let dir = tempfile::Builder::new()
        .prefix("dxtutor-trace-")
        .tempdir()
        .context("criar directório temporário do traçado")?;
    let root = dir.path();

    // O ficheiro do aluno: o harness compila-o com este caminho, logo os frames
    // do aluno ficam identificáveis por `co_filename`.
    let student_path = root.join("student.py");
    std::fs::write(&student_path, code).context("escrever o código do aluno")?;

    let harness_path = root.join("trace_harness.py");
    std::fs::write(&harness_path, HARNESS).context("escrever o harness de traçado")?;

    let mut cmd = Command::new("python3");
    cmd.current_dir(root);
    cmd.arg(&harness_path);
    cmd.arg(&student_path);
    configure_python_env(&mut cmd, root);

    let outcome = run_guarded(cmd, root, "trace", TRACE_TIMEOUT, Some(TRACE_LIMITS))
        .context("correr o harness de traçado com python3")?;

    if outcome.timed_out {
        return Ok(ExecutionTrace {
            supported: true,
            notes: format!(
                "trace timed out after {}s and was terminated (possible infinite loop)",
                TRACE_TIMEOUT.as_secs()
            ),
            steps: Vec::new(),
            stdout: String::new(),
        });
    }

    // O JSON sai no stdout do harness (que o `run_guarded` redireccionou para
    // ficheiro). A interpretação é partilhada com o caminho container.
    Ok(parse_harness_output(&outcome.stdout, &outcome.stderr))
}

/// Caminho container do [`trace_python`]: escreve `student.py` + `trace_harness.py`
/// num tempdir montado em `/work` e corre `python3 trace_harness.py student.py` no
/// container `python:3.12-slim` (sem rede). O JSON do harness sai no stdout do
/// container e é interpretado por [`parse_harness_output`], igual ao host.
fn trace_python_container(code: &str) -> Result<ExecutionTrace> {
    use crate::container::{image_for, run_in_container, ContainerSpec};

    let dir = tempfile::Builder::new()
        .prefix("dxtutor-trace-")
        .tempdir()
        .context("criar directório temporário do traçado")?;
    let root = dir.path();
    std::fs::write(root.join("student.py"), code).context("escrever o código do aluno")?;
    std::fs::write(root.join("trace_harness.py"), HARNESS).context("escrever o harness de traçado")?;

    let image = image_for("python").expect("python tem imagem conhecida");
    let mut spec = ContainerSpec::new(
        image,
        root,
        vec![
            "python3".into(),
            "trace_harness.py".into(),
            "student.py".into(),
        ],
    );
    spec.timeout = TRACE_TIMEOUT;
    spec.env = vec![
        ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
        ("PYTHONIOENCODING".into(), "utf-8".into()),
        ("PYTHONHASHSEED".into(), "0".into()),
    ];

    let out = run_in_container(spec)?;
    Ok(parse_harness_output(&out.stdout, &out.stderr))
}

/// Interpreta o stdout/stderr do harness de traçado num [`ExecutionTrace`]. Um
/// stdout vazio ou inválido ⇒ o python3 não arrancou/falhou: a razão (stderr) é
/// honesta na nota. Partilhado pelos caminhos host e container.
fn parse_harness_output(stdout: &str, stderr: &str) -> ExecutionTrace {
    let raw = stdout.trim();
    if raw.is_empty() {
        let stderr = stderr.trim();
        let note = if stderr.is_empty() {
            "trace produced no output (python3 may be missing or failed to start)".to_string()
        } else {
            format!("trace failed to run:\n{}", truncate(stderr, 1200))
        };
        return ExecutionTrace {
            supported: true,
            notes: note,
            steps: Vec::new(),
            stdout: String::new(),
        };
    }

    let parsed: HarnessOutput = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            return ExecutionTrace {
                supported: true,
                notes: format!("could not parse trace output ({e}); raw:\n{}", truncate(raw, 1200)),
                steps: Vec::new(),
                stdout: String::new(),
            };
        }
    };

    // Notas honestas: erro de execução do aluno e/ou truncagem por tecto de passos.
    let mut notes = String::new();
    if let Some(n) = parsed.truncated {
        notes.push_str(&format!("trace truncated at {n} steps"));
    }
    if let Some(err) = parsed.error {
        if !notes.is_empty() {
            notes.push('\n');
        }
        notes.push_str("program raised an exception:\n");
        notes.push_str(err.trim_end());
    }

    ExecutionTrace {
        supported: true,
        notes,
        steps: parsed.steps,
        stdout: parsed.stdout,
    }
}

/// Ambiente mínimo para o `python3`: limpo, só o essencial + variáveis `PYTHON*`
/// que endurecem o interpretador (sem bytecode em disco, sem site do utilizador,
/// UTF-8 estável) e com HOME dentro do tempdir.
fn configure_python_env(cmd: &mut Command, home: &Path) {
    cmd.env_clear();
    cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin");
    cmd.env("HOME", home);
    cmd.env("LANG", "C.UTF-8");
    // Endurecimento do interpretador:
    cmd.env("PYTHONDONTWRITEBYTECODE", "1"); // não escreve .pyc
    cmd.env("PYTHONNOUSERSITE", "1"); // ignora ~/.local/site-packages
    cmd.env("PYTHONIOENCODING", "utf-8"); // stdout/JSON deterministas
    cmd.env("PYTHONHASHSEED", "0"); // execução reprodutível
}

/// Trunca um texto a `max` bytes (em fronteira de char), com marca honesta.
fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) && end > 0 {
        end -= 1;
    }
    format!("{}… (truncated)", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linguagem_desconhecida_nao_e_suportada_com_nota_honesta() {
        let trace = trace_execution("haskell", "main = putStrLn \"hi\"").expect("não devia falhar");
        assert!(!trace.supported);
        assert!(trace.steps.is_empty());
        assert!(
            trace.notes.contains("debugger") && trace.notes.contains("Python"),
            "nota devia ser honesta: {}",
            trace.notes
        );
    }

    #[test]
    fn rust_e_despachado_para_o_tracador_de_rust() {
        // Rust agora é suportado via instrumentação de código-fonte; o despacho não
        // deve devolver `supported = false`. (A execução real fica para os testes
        // `#[ignore]` do `rust_tracer`, que compilam cargo.)
        let trace =
            trace_execution("rust", "fn this_will_not_compile(").expect("não devia devolver Err");
        assert!(
            trace.supported,
            "rust devia ser suportado (ainda que o programa não compile)"
        );
    }

    #[test]
    #[ignore = "corre o python3 real; lento"]
    fn trace_python_loop_e_funcao() {
        // Um programa com uma função e um ciclo; a variável `total` deve aparecer
        // com o valor esperado (0+1+2 = 3) e o print deve chegar ao stdout.
        let code = "\
def soma(n):
    total = 0
    for i in range(n):
        total = total + i
    return total

resultado = soma(3)
print(\"soma:\", resultado)
";
        let trace = trace_python(code).expect("o traçado não devia devolver Err");

        assert!(trace.supported, "python devia ser suportado");
        assert!(!trace.steps.is_empty(), "o traço não devia estar vazio");

        // Há um passo em que `total` vale 3 (após o ciclo, antes do return) —
        // valor REAL observado pelo settrace.
        let viu_total_3 = trace.steps.iter().any(|s| {
            s.locals
                .iter()
                .any(|v| v.name == "total" && v.value == "3" && v.ty == "int")
        });
        assert!(
            viu_total_3,
            "devia existir um passo com total=3 (int); passos: {:#?}",
            trace
                .steps
                .iter()
                .map(|s| (s.line, &s.event, &s.func))
                .collect::<Vec<_>>()
        );

        // Há eventos de call e return da função `soma`.
        assert!(
            trace.steps.iter().any(|s| s.event == "call" && s.func == "soma"),
            "devia haver um evento call de `soma`"
        );
        assert!(
            trace.steps.iter().any(|s| s.event == "return" && s.func == "soma"),
            "devia haver um evento return de `soma`"
        );

        // A pilha fundo-a-fundo: dentro de `soma`, depth > 0; no módulo, depth 0.
        assert!(
            trace.steps.iter().any(|s| s.func == "soma" && s.depth >= 1),
            "frames de `soma` deviam ter profundidade >= 1"
        );

        // O stdout real do programa.
        assert!(
            trace.stdout.contains("soma: 3"),
            "stdout devia conter 'soma: 3', obteve-se: {:?}",
            trace.stdout
        );
    }
}
