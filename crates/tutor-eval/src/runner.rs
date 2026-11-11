//! Monta e corre um projecto cargo isolado para julgar a submissão do aluno.
//!
//! Isolamento: cada submissão vai para o seu directório temporário próprio e é um
//! pacote `student` autónomo.
//!
//! # Endurecimento de 1ª linha (defesa em profundidade)
//!
//! Como o avaliador compila e CORRE código não-fidedigno do aluno na máquina
//! local, aplicamos quatro barreiras baratas a todos os subprocessos:
//!
//! 1. **Timeout de parede** em cada subprocesso (`cargo test`, `cargo build` da
//!    sonda e a execução da sonda). Ao exceder o limite, matamos todo o grupo de
//!    processos e tratamos como falha legível (a correcção devolve
//!    `passed = false`; a sonda devolve um erro claro).
//! 2. **Limites de recursos** (`setrlimit` via `pre_exec`) no processo da sonda —
//!    onde corre o código do aluno: `RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_FSIZE` e
//!    `RLIMIT_NPROC`. O processo é posto no seu próprio grupo/sessão
//!    (`setsid`) para que o timeout possa abater toda a árvore.
//! 3. **Ambiente mínimo** para a sonda (`env_clear` + só o essencial) e
//!    `CARGO_NET_OFFLINE=true` em todo o lado — o conteúdo não tem dependências
//!    externas, por isso cortamos o acesso à rede.
//! 4. Os `cargo` (test/build) correm com grupo próprio + timeout + rede cortada,
//!    mas SEM os `setrlimit` estritos: o compilador precisa de folga de memória e
//!    de escrever artefactos grandes. Os limites estritos ficam para a sonda.
//!
//! Isto NÃO é isolamento completo. O passo posterior — namespaces, seccomp e
//! cgroups (estilo Delonix) — não está aqui implementado e deve ser adicionado
//! quando quisermos correr submissões verdadeiramente hostis em produção.

use std::fs::File;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tutor_core::{Phase, Probe};

use crate::complexity::{self, Estimate, Sample};
use crate::lang::{Diagnostic, LanguageRunner, Severity};

// ── Limites do sandbox (configuráveis por constante) ────────────────────────

/// Tempo de parede máximo para cada invocação do `cargo` (test ou build).
/// Generoso: um pacote `student` sem dependências compila em segundos, mas damos
/// folga para máquinas lentas/CI frio sem nunca deixar pendurar indefinidamente.
pub(crate) const CARGO_TIMEOUT: Duration = Duration::from_secs(60);

/// Tempo de parede máximo para a execução da sonda (código do aluno).
/// A sonda legítima mede os tamanhos da fase × algumas repetições em muito menos
/// que isto — inclusive a variante O(n²) curada da demo, que fica bem abaixo dos
/// 15s. Um ciclo infinito é abatido ao fim de 15s.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Intervalo de sondagem do subprocesso enquanto esperamos pelo seu fim.
pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Limites de recursos aplicados APENAS ao processo da sonda.
///
/// - `cpu_secs` (RLIMIT_CPU): guarda secundário ao timeout de parede; um ciclo que
///   queime CPU recebe SIGXCPU. Fica acima do timeout de parede para que seja a
///   parede a decidir primeiro na maioria dos casos.
/// - `as_bytes` (RLIMIT_AS): 1 GiB de espaço de endereçamento virtual. A sonda
///   legítima usa poucos MB; uma bomba de memória que peça vários GB falha a
///   alocação (Rust aborta) e é contida sem derrubar a máquina.
/// - `fsize_bytes` (RLIMIT_FSIZE): 64 MiB. A saída legítima são 6 linhas "n t";
///   isto trava saída desenfreada para o ficheiro de stdout.
/// - `nproc` (RLIMIT_NPROC): tecto contra fork-bombs. A sonda não cria processos,
///   por isso é seguro; o timeout de parede continua a ser a guarda primária.
pub(crate) const PROBE_LIMITS: Rlimits = Rlimits {
    cpu_secs: 20,
    as_bytes: 1024 * 1024 * 1024,
    fsize_bytes: 64 * 1024 * 1024,
    nproc: 1024,
};

/// Limites de `setrlimit` a aplicar no `pre_exec` do processo do aluno.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Rlimits {
    pub(crate) cpu_secs: u64,
    pub(crate) as_bytes: u64,
    pub(crate) fsize_bytes: u64,
    pub(crate) nproc: u64,
}

/// Veredicto de correcção (fonte da verdade: os testes).
#[derive(Debug, Clone)]
pub struct Correctness {
    pub passed: bool,
    pub summary: String,
    /// Saída crua de `cargo test` (stdout+stderr) para mostrar falhas ao aluno.
    pub raw: String,
}

/// Avaliação completa de uma submissão a uma fase.
#[derive(Debug, Clone)]
pub struct Assessment {
    pub correctness: Correctness,
    /// Estimativa de complexidade, se a fase tiver sonda e a correcção passar.
    pub complexity: Option<Estimate>,
    /// Classe esperada (do gabarito/sonda), para comparação.
    pub expected: Option<complexity::Class>,
}

/// Avaliador da linguagem **Rust**: embrulha exactamente a lógica histórica —
/// compila e corre um pacote cargo `student` isolado, com todo o endurecimento de
/// sandbox descrito no cabeçalho do módulo. É o runner por omissão.
#[derive(Debug, Clone, Copy, Default)]
pub struct RustRunner;

impl LanguageRunner for RustRunner {
    /// Correcção = `cargo test` sobre o pacote `student` (código + testes ocultos).
    fn check_correctness(&self, phase: &Phase, student_code: &str) -> Result<Correctness> {
        let dir = tempfile::Builder::new()
            .prefix("dxtutor-submission-")
            .tempdir()
            .context("criar directório temporário da submissão")?;
        let root = dir.path();
        // Sem sonda aqui: a correcção não precisa do binário da sonda.
        scaffold_package(root, student_code, &phase.tests, None, &phase.dependencies)?;
        run_tests(root)
    }

    /// Complexidade = compilar a sonda em `--release` e cronometrar a solução do
    /// aluno em `n` crescente (o tempo é medido pelo binário da sonda com `Instant`).
    fn probe_complexity(&self, phase: &Phase, student_code: &str) -> Result<Vec<Sample>> {
        let probe = phase
            .probe
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("fase {} não tem sonda de complexidade", phase.id))?;
        let dir = tempfile::Builder::new()
            .prefix("dxtutor-probe-")
            .tempdir()
            .context("criar directório temporário da sonda")?;
        let root = dir.path();
        scaffold_package(root, student_code, &phase.tests, Some(probe), &phase.dependencies)?;
        run_probe(root)
    }

    /// Diagnósticos = `cargo check --message-format=json`, extraindo o `span`
    /// primário (linha/coluna) de cada mensagem de erro/aviso do compilador.
    fn diagnostics(&self, student_code: &str) -> Result<Vec<Diagnostic>> {
        rust_diagnostics(student_code)
    }
}

/// Saída de correr um programa Rust COMPLETO do aluno (um passo `drill` do modo
/// guiado): se terminou com sucesso, e o seu `stdout`/`stderr`.
#[derive(Debug, Clone)]
pub struct RunOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Compila e corre um programa Rust **completo** (com `fn main`) num pacote `bin`
/// isolado e devolve a sua saída.
///
/// Reusa o mesmo endurecimento de sandbox das outras invocações `cargo` — ambiente
/// mínimo ([`configure_cargo_env`]: `env_clear` + toolchain + `CARGO_NET_OFFLINE`),
/// grupo de processos próprio e timeout de parede ([`run_guarded`] com
/// [`CARGO_TIMEOUT`]). Serve o passo `drill`: o aluno reescreve um código-alvo e,
/// quando bate, executa-se para ele ver o resultado.
///
/// Não propaga erro por o programa do aluno falhar a compilar ou a correr: isso é
/// resultado normal e vai em `ok = false` + `stderr`. Só devolve `Err` se o próprio
/// sandbox não arrancar.
pub fn run_rust_snippet(code: &str) -> Result<RunOutput> {
    run_rust_snippet_with_deps(code, &[])
}

/// Like [`run_rust_snippet`] but also writes extra Cargo `[dependencies]` (raw
/// lines) into the scaffolded crate, so a drill that pulls in an external crate
/// (e.g. `rusqlite` for the database track) compiles and runs. `deps` empty ⇒
/// identical to [`run_rust_snippet`].
pub fn run_rust_snippet_with_deps(code: &str, deps: &[String]) -> Result<RunOutput> {
    // Motor != Host ⇒ compila+corre dentro do container `rust:1-slim` (com cache de
    // cargo e rede), deixando o caminho host intacto a seguir.
    if crate::container::current_engine() != crate::container::SandboxEngine::Host {
        return crate::container::run_rust_snippet_in_container_deps(code, deps);
    }

    let dir = tempfile::Builder::new()
        .prefix("dxtutor-drill-")
        .tempdir()
        .context("criar directório temporário do drill")?;
    let root = dir.path();
    scaffold_bin_deps(root, code, deps)?;

    let mut cmd = Command::new("cargo");
    cmd.args(["run", "--quiet"]).current_dir(root);
    configure_cargo_env(&mut cmd);

    let outcome =
        run_guarded(cmd, root, "run", CARGO_TIMEOUT, None).context("executar `cargo run`")?;

    if outcome.timed_out {
        return Ok(RunOutput {
            ok: false,
            stdout: outcome.stdout,
            stderr: format!("excedeu o tempo limite ({}s)", CARGO_TIMEOUT.as_secs()),
        });
    }

    let ok = outcome.status.map(|s| s.success()).unwrap_or(false);
    Ok(RunOutput {
        ok,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
    })
}

/// Renders a `[dependencies]` TOML section from raw dependency lines, or "" when
/// empty. Each entry is a complete line, e.g.
/// `rusqlite = { version = "0.31", features = ["bundled"] }`.
pub(crate) fn cargo_deps_toml(deps: &[String]) -> String {
    if deps.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n[dependencies]\n");
    for d in deps {
        s.push_str(d.trim());
        s.push('\n');
    }
    s
}

/// Cria um pacote `bin` mínimo com o programa completo do aluno em `src/main.rs`.
pub(crate) fn scaffold_bin(root: &Path, code: &str) -> Result<()> {
    scaffold_bin_deps(root, code, &[])
}

/// Like [`scaffold_bin`] but appends extra Cargo `[dependencies]` to the crate.
pub(crate) fn scaffold_bin_deps(root: &Path, code: &str, deps: &[String]) -> Result<()> {
    std::fs::create_dir_all(root.join("src"))?;
    std::fs::write(
        root.join("Cargo.toml"),
        format!(
            "[package]\n\
             name = \"drill\"\n\
             version = \"0.0.0\"\n\
             edition = \"2021\"\n\n\
             [[bin]]\n\
             name = \"drill\"\n\
             path = \"src/main.rs\"\n{}",
            cargo_deps_toml(deps),
        ),
    )?;
    std::fs::write(root.join("src/main.rs"), code)?;
    Ok(())
}

/// Cria os ficheiros do pacote `student` no directório dado.
fn scaffold_package(
    root: &Path,
    code: &str,
    tests: &str,
    probe: Option<&Probe>,
    deps: &[String],
) -> Result<()> {
    std::fs::create_dir_all(root.join("src"))?;
    std::fs::create_dir_all(root.join("tests"))?;

    std::fs::write(
        root.join("Cargo.toml"),
        format!(
            "[package]\n\
             name = \"student\"\n\
             version = \"0.0.0\"\n\
             edition = \"2021\"\n\n\
             [lib]\n\
             path = \"src/lib.rs\"\n\n\
             [[bin]]\n\
             name = \"probe\"\n\
             path = \"src/bin/probe.rs\"\n\
             required-features = []\n{}",
            cargo_deps_toml(deps),
        ),
    )?;

    std::fs::write(root.join("src/lib.rs"), format!("#![allow(dead_code)]\n{code}"))?;
    std::fs::write(root.join("tests/hidden.rs"), tests)?;

    // A sonda tem de existir sempre (o Cargo.toml declara o bin); se a fase não
    // tiver sonda, geramos um `main` vazio.
    std::fs::create_dir_all(root.join("src/bin"))?;
    let probe_src = match probe {
        Some(p) => render_probe(p),
        None => "fn main() {}\n".to_string(),
    };
    std::fs::write(root.join("src/bin/probe.rs"), probe_src)?;

    Ok(())
}

/// Gera o binário da sonda a partir da especificação.
fn render_probe(p: &Probe) -> String {
    let sizes = p
        .sizes
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    // Template com marcadores substituídos — evita o inferno de chavetas do format!.
    const TEMPLATE: &str = r#"#![allow(unused)]
use std::hint::black_box;
use std::time::Instant;

//PRELUDE//

//GENERATOR//

fn main() {
    let sizes: &[usize] = &[//SIZES//];
    for &n in sizes {
        // Aquecimento (não medido).
        {
            let input = gen(n);
            let _t = Instant::now();
            //CALL//
            let _ = _t.elapsed();
        }
        // Melhor de várias repetições reduz o ruído do agendador.
        let mut best: u128 = u128::MAX;
        for _rep in 0..7 {
            let input = gen(n);
            let _t = Instant::now();
            //CALL//
            let e = _t.elapsed().as_nanos();
            if e < best { best = e; }
        }
        println!("{} {}", n, best);
    }
}
"#;

    TEMPLATE
        .replace("//PRELUDE//", &p.prelude)
        .replace("//GENERATOR//", &p.generator)
        .replace("//SIZES//", &sizes)
        .replace("//CALL//", &p.call)
}

/// Corre `cargo test` (com timeout + grupo próprio + rede cortada) e interpreta o
/// resultado.
fn run_tests(root: &Path) -> Result<Correctness> {
    let mut cmd = Command::new("cargo");
    cmd.args(["test", "--quiet"]).current_dir(root);
    configure_cargo_env(&mut cmd);

    // Sem rlimits estritos: o compilador precisa de folga de memória e de escrever
    // artefactos. A guarda aqui é o timeout de parede + grupo de processos próprio.
    let outcome = run_guarded(cmd, root, "test", CARGO_TIMEOUT, None)
        .context("executar `cargo test`")?;

    let mut raw = String::new();
    raw.push_str(&outcome.stdout);
    raw.push_str(&outcome.stderr);

    if outcome.timed_out {
        let summary = format!("excedeu o tempo limite ({}s)", CARGO_TIMEOUT.as_secs());
        return Ok(Correctness { passed: false, summary, raw });
    }

    let passed = outcome.status.map(|s| s.success()).unwrap_or(false);
    let summary = summarize(&raw, passed);

    Ok(Correctness { passed, summary, raw })
}

fn summarize(raw: &str, passed: bool) -> String {
    // `cargo test` emite várias linhas "test result:" (lib, integração, doctests).
    // Agregamos todas para não reportar a primeira (frequentemente "0 passed").
    let (mut total_pass, mut total_fail, mut found) = (0u32, 0u32, false);
    for line in raw.lines().filter(|l| l.contains("test result:")) {
        found = true;
        total_pass += count_before(line, "passed");
        total_fail += count_before(line, "failed");
    }
    if found {
        return format!("{total_pass} passaram, {total_fail} falharam");
    }
    if raw.contains("error[") || raw.contains("error:") {
        return "não compilou (erro de compilação)".to_string();
    }
    if passed {
        "testes passaram".to_string()
    } else {
        "testes falharam".to_string()
    }
}

/// Extrai o número imediatamente antes de `keyword` numa linha (ex.: "3 passed").
fn count_before(line: &str, keyword: &str) -> u32 {
    line.split(keyword)
        .next()
        .and_then(|prefix| prefix.split_whitespace().last())
        .and_then(|tok| tok.parse().ok())
        .unwrap_or(0)
}

/// Compila a sonda em `--release` e corre-a, recolhendo as medições `(n, t)`.
///
/// A compilação corre com timeout + grupo próprio (sem rlimits estritos). A
/// EXECUÇÃO da sonda — que arranca o código do aluno — corre com ambiente mínimo,
/// grupo próprio e os `setrlimit` de [`PROBE_LIMITS`].
fn run_probe(root: &Path) -> Result<Vec<Sample>> {
    // 1) Compilar em release.
    let mut build = Command::new("cargo");
    build
        .args(["build", "--release", "--quiet", "--bin", "probe"])
        .current_dir(root);
    configure_cargo_env(&mut build);

    let b = run_guarded(build, root, "build", CARGO_TIMEOUT, None).context("compilar a sonda")?;
    if b.timed_out {
        anyhow::bail!(
            "a compilação da sonda excedeu o tempo limite ({}s)",
            CARGO_TIMEOUT.as_secs()
        );
    }
    if !b.status.map(|s| s.success()).unwrap_or(false) {
        anyhow::bail!("falha a compilar a sonda:\n{}", b.stderr);
    }

    // 2) Correr a sonda (código do aluno) — ambiente mínimo + rlimits estritos.
    let bin = root.join("target/release/probe");
    let mut run = Command::new(&bin);
    run.current_dir(root);
    configure_probe_env(&mut run, root);

    let r = run_guarded(run, root, "probe", PROBE_TIMEOUT, Some(PROBE_LIMITS))
        .with_context(|| format!("correr a sonda em {}", bin.display()))?;
    if r.timed_out {
        anyhow::bail!(
            "a sonda excedeu o tempo limite ({}s) — possível ciclo infinito; foi terminada",
            PROBE_TIMEOUT.as_secs()
        );
    }
    if !r.status.map(|s| s.success()).unwrap_or(false) {
        anyhow::bail!(
            "a sonda terminou com erro (possível limite de recursos excedido):\n{}",
            r.stderr
        );
    }

    let mut samples = Vec::new();
    for line in r.stdout.lines() {
        let mut it = line.split_whitespace();
        if let (Some(n), Some(t)) = (it.next(), it.next()) {
            if let (Ok(n), Ok(t)) = (n.parse::<f64>(), t.parse::<f64>()) {
                samples.push(Sample { n, t });
            }
        }
    }
    Ok(samples)
}

/// Corre `cargo check --message-format=json` sobre uma biblioteca `student` com só o
/// código do aluno e traduz cada mensagem do compilador num [`Diagnostic`] posicional.
///
/// Usa o mesmo endurecimento barato das outras invocações cargo (ambiente mínimo,
/// rede cortada, grupo próprio, timeout de parede). O JSON do compilador traz, por
/// mensagem, `level` (error/warning) e `spans[]` com `line_start`/`column_start`;
/// escolhemos o span primário (`is_primary`) para a posição da «linha vermelha».
fn rust_diagnostics(student_code: &str) -> Result<Vec<Diagnostic>> {
    let dir = tempfile::Builder::new()
        .prefix("dxtutor-check-")
        .tempdir()
        .context("criar directório temporário do check")?;
    let root = dir.path();
    std::fs::create_dir_all(root.join("src"))?;
    std::fs::write(
        root.join("Cargo.toml"),
        "[package]\n\
         name = \"student\"\n\
         version = \"0.0.0\"\n\
         edition = \"2021\"\n\n\
         [lib]\n\
         path = \"src/lib.rs\"\n",
    )?;
    std::fs::write(
        root.join("src/lib.rs"),
        format!("#![allow(dead_code)]\n{student_code}"),
    )?;

    let mut cmd = Command::new("cargo");
    cmd.args(["check", "--quiet", "--message-format=json", "--lib"])
        .current_dir(root);
    configure_cargo_env(&mut cmd);

    let outcome = run_guarded(cmd, root, "check", CARGO_TIMEOUT, None)
        .context("executar `cargo check`")?;
    if outcome.timed_out {
        anyhow::bail!(
            "o `cargo check` excedeu o tempo limite ({}s)",
            CARGO_TIMEOUT.as_secs()
        );
    }

    Ok(parse_cargo_diagnostics(&outcome.stdout))
}

/// Extrai os [`Diagnostic`] das linhas JSON do `cargo check`. Cada linha é um objecto;
/// interessam as de `"reason":"compiler-message"` com nível `error`/`warning`.
fn parse_cargo_diagnostics(stdout: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("reason").and_then(|r| r.as_str()) != Some("compiler-message") {
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        let severity = match msg.get("level").and_then(|l| l.as_str()) {
            Some("error") | Some("error: internal compiler error") => Severity::Error,
            Some("warning") => Severity::Warning,
            // Ignoramos notas/ajudas: não são a «linha vermelha».
            _ => continue,
        };
        let message = msg
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();

        // Span primário (ou o primeiro disponível) → posição.
        let (line_no, col_no) = msg
            .get("spans")
            .and_then(|s| s.as_array())
            .map(|spans| {
                let primary = spans
                    .iter()
                    .find(|s| s.get("is_primary").and_then(|p| p.as_bool()) == Some(true))
                    .or_else(|| spans.first());
                match primary {
                    Some(s) => (
                        s.get("line_start").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
                        s.get("column_start").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
                    ),
                    None => (0, 0),
                }
            })
            .unwrap_or((0, 0));

        out.push(Diagnostic {
            line: line_no,
            col: col_no,
            severity,
            message,
        });
    }
    out
}

// ── Infra-estrutura do sandbox ──────────────────────────────────────────────

/// Resultado de um subprocesso guardado pelo sandbox.
pub(crate) struct RunOutcome {
    /// `true` se foi abatido por exceder o timeout de parede.
    pub(crate) timed_out: bool,
    /// Estado de saída, se terminou por si (None quando foi morto por timeout).
    pub(crate) status: Option<ExitStatus>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// Variáveis essenciais a herdar do ambiente para que o `cargo`/`rustc` funcionem
/// offline (toolchain, HOME, PATH, locale). Tudo o resto é descartado.
const CARGO_ENV_ALLOW: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "RUSTUP_TOOLCHAIN",
    "RUSTC",
    "RUSTDOC",
];

/// Ambiente para as invocações do `cargo`: limpo, com a lista mínima do toolchain
/// e com a rede cortada.
pub(crate) fn configure_cargo_env(cmd: &mut Command) {
    cmd.env_clear();
    for key in CARGO_ENV_ALLOW {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }
    cmd.env("CARGO_NET_OFFLINE", "true");
    cmd.env("CARGO_TERM_COLOR", "never");
}

/// Ambiente mínimo para o processo do aluno (a sonda já compilada): sem herança,
/// só PATH mínimo, HOME dentro do tempdir e rede cortada. A sonda é um binário
/// autónomo — não precisa do toolchain.
pub(crate) fn configure_probe_env(cmd: &mut Command, home: &Path) {
    cmd.env_clear();
    cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin");
    cmd.env("HOME", home);
    cmd.env("CARGO_NET_OFFLINE", "true");
    cmd.env("LANG", "C");
}

/// Instala o endurecimento no `pre_exec`: põe o processo no seu próprio
/// grupo/sessão (para matar toda a árvore no timeout) e, se dados, aplica os
/// `setrlimit`.
///
/// # Safety
/// `pre_exec` corre no filho entre `fork` e `exec`; o corpo só chama syscalls
/// async-signal-safe (`setsid`/`setpgid`/`setrlimit`) e não aloca.
pub(crate) fn install_hardening(cmd: &mut Command, rlimits: Option<Rlimits>) {
    unsafe {
        cmd.pre_exec(move || {
            // Nova sessão → grupo de processos próprio (pgid == pid). Se falhar
            // (raro), tenta ao menos um grupo próprio com setpgid.
            if libc::setsid() == -1 {
                libc::setpgid(0, 0);
            }
            if let Some(r) = rlimits {
                set_rlimit(libc::RLIMIT_CPU, r.cpu_secs);
                set_rlimit(libc::RLIMIT_AS, r.as_bytes);
                set_rlimit(libc::RLIMIT_FSIZE, r.fsize_bytes);
                set_rlimit(libc::RLIMIT_NPROC, r.nproc);
            }
            Ok(())
        });
    }
}

/// Aplica um `setrlimit` (soft == hard). Melhor-esforço: uma falha não deve
/// abortar o `exec`.
///
/// # Safety
/// Chamada apenas de dentro de `pre_exec`.
unsafe fn set_rlimit(resource: libc::__rlimit_resource_t, value: u64) {
    let lim = libc::rlimit {
        rlim_cur: value as libc::rlim_t,
        rlim_max: value as libc::rlim_t,
    };
    let _ = libc::setrlimit(resource, &lim);
}

/// Corre `cmd` com stdout/stderr redireccionados para ficheiros no tempdir (evita
/// bloqueio por buffer de pipe cheio), grupo de processos próprio, `setrlimit`
/// opcional e um timeout de parede. Ao exceder, abate todo o grupo com SIGKILL.
pub(crate) fn run_guarded(
    mut cmd: Command,
    out_dir: &Path,
    tag: &str,
    timeout: Duration,
    rlimits: Option<Rlimits>,
) -> Result<RunOutcome> {
    let out_path = out_dir.join(format!(".dxtutor-{tag}.out"));
    let err_path = out_dir.join(format!(".dxtutor-{tag}.err"));
    let out_file = File::create(&out_path).context("criar ficheiro de stdout do sandbox")?;
    let err_file = File::create(&err_path).context("criar ficheiro de stderr do sandbox")?;

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::from(out_file));
    cmd.stderr(Stdio::from(err_file));

    install_hardening(&mut cmd, rlimits);

    let mut child = cmd.spawn().context("arrancar subprocesso do sandbox")?;
    let pid = child.id() as libc::pid_t;
    let deadline = Instant::now() + timeout;

    let (timed_out, status) = loop {
        match child.try_wait().context("sondar o subprocesso")? {
            Some(status) => break (false, Some(status)),
            None => {
                if Instant::now() >= deadline {
                    // Abate todo o grupo (pgid == pid, graças ao setsid) e reconsolida.
                    unsafe {
                        libc::killpg(pid, libc::SIGKILL);
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    break (true, None);
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        }
    };

    Ok(RunOutcome {
        timed_out,
        status,
        stdout: read_lossy(&out_path),
        stderr: read_lossy(&err_path),
    })
}

/// Lê um ficheiro como texto, tolerante a bytes inválidos (nunca falha).
pub(crate) fn read_lossy(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Monta um pacote mínimo com uma sonda arbitrária e devolve o tempdir.
    fn scaffold_with_probe(probe_main: &str) -> tempfile::TempDir {
        let dir = tempfile::Builder::new()
            .prefix("dxtutor-sandbox-test-")
            .tempdir()
            .expect("criar tempdir");
        let root = dir.path();
        // Reutiliza o scaffold normal (lib trivial + testes vazios + sonda vazia)…
        scaffold_package(root, "pub fn noop() {}", "", None, &[]).expect("scaffold");
        // …e substitui a sonda pela maliciosa.
        std::fs::write(root.join("src/bin/probe.rs"), probe_main).expect("escrever sonda");
        dir
    }

    #[test]
    fn probe_ciclo_infinito_e_abatido_pelo_timeout() {
        let dir = scaffold_with_probe(
            "fn main() { loop { std::hint::black_box(0u64); } }\n",
        );
        let start = Instant::now();
        let res = run_probe(dir.path());
        let elapsed = start.elapsed();

        // Foi contido (erro), não pendurou, e a mensagem explica o timeout.
        let err = res.expect_err("o ciclo infinito tem de falhar, não pendurar");
        let msg = err.to_string();
        assert!(
            msg.contains("tempo limite"),
            "erro devia mencionar o tempo limite: {msg}"
        );
        // Timeout da sonda (10s) + compilação (< CARGO_TIMEOUT). Nunca eterno.
        assert!(
            elapsed < PROBE_TIMEOUT + CARGO_TIMEOUT + Duration::from_secs(10),
            "demorou demasiado: {elapsed:?}"
        );
    }

    #[test]
    #[ignore = "compila e corre um cargo aninhado; lento"]
    fn run_rust_snippet_hello_world_imprime_stdout() {
        let out = run_rust_snippet("fn main() {\n    println!(\"Hello, world!\");\n}\n")
            .expect("correr o snippet não devia falhar no sandbox");
        assert!(out.ok, "o hello-world devia compilar e correr; stderr:\n{}", out.stderr);
        assert!(
            out.stdout.contains("Hello, world!"),
            "stdout devia conter 'Hello, world!', obteve-se:\n{}",
            out.stdout
        );
    }

    #[test]
    fn probe_bomba_de_memoria_e_contida_pelo_rlimit() {
        // Tenta alocar 8 GiB — bem acima do RLIMIT_AS (1 GiB). O tamanho é opaco
        // (`black_box`) para o optimizador não eliminar a alocação; a reserva
        // falha e o Rust aborta, logo a sonda é reportada como falha.
        let dir = scaffold_with_probe(
            "fn main() {\n\
             let n = std::hint::black_box(8usize * 1024 * 1024 * 1024);\n\
             let mut v: Vec<u8> = Vec::with_capacity(n);\n\
             v.resize(n, 1u8);\n\
             std::hint::black_box(v[n - 1]);\n\
             }\n",
        );
        let start = Instant::now();
        let res = run_probe(dir.path());
        let elapsed = start.elapsed();

        assert!(
            res.is_err(),
            "a bomba de memória tinha de ser contida, obteve-se {res:?}"
        );
        // Falha a alocação rapidamente — nunca perto do timeout de parede.
        assert!(
            elapsed < CARGO_TIMEOUT + Duration::from_secs(10),
            "demorou demasiado: {elapsed:?}"
        );
    }
}
