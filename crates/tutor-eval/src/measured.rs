//! Observabilidade honesta: o que acontece **mesmo** quando o código do aluno corre.
//!
//! Duas capacidades, ambas medidas directamente no sistema — nada de GPU/NPU
//! inventadas, nada de números fabricados:
//!
//! 1. [`run_rust_snippet_measured`] — compila o programa e corre o **binário**
//!    (não `cargo run`), medindo só o processo do aluno com [`libc::wait4`] para
//!    colher a `rusage` real (CPU utilizador/sistema, pico de RSS, blocos de I/O) e
//!    um [`Instant`] para o tempo de parede. Aplica o mesmo endurecimento de
//!    sandbox do avaliador ([`crate::runner`]).
//! 2. [`compile_pipeline`] — corre `rustc` a emitir cada representação intermédia
//!    (MIR → LLVM-IR → assembly → binário) e, se `objdump` existir, desmonta o
//!    binário. Lê os ficheiros gerados num tempdir. Tudo real; o que a toolchain
//!    não oferecer fica vazio com uma nota honesta em [`Pipeline::notes`].

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use anyhow::{Context, Result};

use crate::runner::{
    configure_cargo_env, configure_probe_env, install_hardening, read_lossy, run_guarded,
    scaffold_bin, RunOutput, CARGO_TIMEOUT, POLL_INTERVAL, PROBE_LIMITS, PROBE_TIMEOUT,
};

/// Número de linhas a que truncamos cada representação do pipeline (IR/asm).
const PIPELINE_MAX_LINES: usize = 600;

/// Número de linhas a que truncamos a desmontagem do `objdump`.
const DISASM_MAX_LINES: usize = 400;

/// Tecto de amostras da série temporal de memória (um programa de 15s a 25ms/amostra
/// dá ~600; limitamos para não crescer sem fim em casos patológicos).
const MAX_MEM_SAMPLES: usize = 1024;

/// Lê o RSS (memória residente) do processo em KB a partir de `/proc/<pid>/statm`.
/// O segundo campo são páginas residentes; multiplica pelo tamanho da página.
/// Melhor-esforço: devolve `None` se o processo já saiu ou `/proc` não existir.
fn read_rss_kb(pid: libc::pid_t) -> Option<u64> {
    let data = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
    let resident_pages: u64 = data.split_whitespace().nth(1)?.parse().ok()?;
    // SAFETY: `sysconf` com `_SC_PAGESIZE` é seguro e devolve o tamanho da página.
    let page_bytes = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(0) as u64;
    Some(resident_pages.saturating_mul(page_bytes) / 1024)
}

// ── Telemetria ───────────────────────────────────────────────────────────────

/// Uma amostra da série temporal de memória, colhida **durante** a execução do
/// binário do aluno: instante (ms desde o arranque) e memória residente (RSS, KB),
/// lida de `/proc/<pid>/statm`. Nada é estimado — é o que o kernel reportou.
#[derive(Debug, Clone, Default)]
pub struct MemSample {
    /// Instante da amostra, em ms desde o arranque do processo.
    pub t_ms: f64,
    /// Memória residente (RSS) nesse instante, em KB.
    pub rss_kb: u64,
}

/// Métricas **reais** da execução do binário do aluno, colhidas do kernel via
/// `wait4`/`rusage` e de um relógio monótono. Todos os campos são medidos — nenhum
/// é estimado ou inventado.
#[derive(Debug, Clone, Default)]
pub struct Telemetry {
    /// Tempo de parede do processo (relógio monótono, [`Instant`]), em ms.
    pub wall_ms: f64,
    /// CPU em modo utilizador (`rusage.ru_utime`), em ms.
    pub cpu_user_ms: f64,
    /// CPU em modo sistema/kernel (`rusage.ru_stime`), em ms.
    pub cpu_sys_ms: f64,
    /// Pico de memória residente (`rusage.ru_maxrss`). No Linux já vem em KB.
    pub peak_rss_kb: u64,
    /// Blocos de entrada lidos do dispositivo (`rusage.ru_inblock`).
    pub io_read_blocks: u64,
    /// Blocos de saída escritos no dispositivo (`rusage.ru_oublock`).
    pub io_write_blocks: u64,
    /// Código de saída do processo (ou `128 + sinal` se morto por um sinal; `-1`
    /// se abatido pelo timeout ou se não chegou a correr).
    pub exit_code: i32,
    /// Série temporal de memória residente amostrada durante a execução (vazia se
    /// o processo foi curto demais para colher pontos intermédios, mas nesse caso
    /// ainda assim traz o início e o pico).
    pub samples: Vec<MemSample>,
}

/// Compila o programa completo do aluno e corre o **binário** directamente,
/// medindo só o processo do aluno.
///
/// - Compila com `cargo build` (guardado por timeout + grupo próprio). Se a
///   compilação falhar, devolve-se `ok = false` com os erros em `stderr` e a
///   telemetria fica a zero — não há nada a medir.
/// - Em caso de sucesso, corre `target/debug/drill` com o mesmo endurecimento da
///   sonda (ambiente mínimo, grupo de processos próprio, `setrlimit`, timeout) e
///   colhe a `rusage` com [`libc::wait4`].
///
/// Só devolve `Err` se o próprio sandbox não arrancar; a falha do programa do
/// aluno é resultado normal (vai em `ok`/`exit_code`).
pub fn run_rust_snippet_measured(code: &str) -> Result<(RunOutput, Telemetry)> {
    // Motor != Host ⇒ corre no container `rust:1-slim`. A telemetria fina via
    // `wait4`/`rusage` não existe através do CLI do container; medimos honestamente
    // só o tempo de parede (do `… run`) e o código de saída, deixando CPU/RSS/IO a
    // zero e `samples` vazio (ver [`run_measured_in_container`]). O caminho host
    // mantém-se exacto.
    if crate::container::current_engine() != crate::container::SandboxEngine::Host {
        return run_measured_in_container(code);
    }

    let dir = tempfile::Builder::new()
        .prefix("dxtutor-measured-")
        .tempdir()
        .context("criar directório temporário da execução medida")?;
    let root = dir.path();
    scaffold_bin(root, code)?;

    // 1) Compilar o binário (sem o correr) — assim a telemetria mede o programa
    //    do aluno, não o compilador.
    let mut build = Command::new("cargo");
    build.args(["build", "--quiet"]).current_dir(root);
    configure_cargo_env(&mut build);
    let b = run_guarded(build, root, "build", CARGO_TIMEOUT, None)
        .context("compilar o programa do aluno")?;

    if b.timed_out {
        return Ok((
            RunOutput {
                ok: false,
                stdout: b.stdout,
                stderr: format!(
                    "a compilação excedeu o tempo limite ({}s)",
                    CARGO_TIMEOUT.as_secs()
                ),
            },
            Telemetry::default(),
        ));
    }
    if !b.status.map(|s| s.success()).unwrap_or(false) {
        // Erro de compilação: resultado normal. Nada a medir.
        return Ok((
            RunOutput {
                ok: false,
                stdout: b.stdout,
                stderr: b.stderr,
            },
            Telemetry::default(),
        ));
    }

    // 2) Correr o binário compilado directamente, medindo a rusage.
    let bin = root.join("target/debug/drill");
    let measured = run_measured_binary(&bin, root)
        .with_context(|| format!("correr o binário medido em {}", bin.display()))?;

    let run = RunOutput {
        ok: measured.ok(),
        stdout: measured.stdout,
        stderr: measured.stderr,
    };
    Ok((run, measured.telemetry))
}

/// Caminho container do [`run_rust_snippet_measured`]: compila+corre o snippet no
/// container `rust:1-slim` e devolve a saída com uma telemetria **honestamente
/// parcial** — só tempo de parede (medido à volta do `… run`) e código de saída. As
/// métricas finas (CPU utilizador/sistema, pico de RSS, blocos de I/O) exigem
/// `wait4`/`rusage` sobre o processo do aluno, que não é acessível através do CLI do
/// container; ficam a zero e `samples` vazio, em vez de serem inventadas.
fn run_measured_in_container(code: &str) -> Result<(RunOutput, Telemetry)> {
    let start = Instant::now();
    let out = crate::container::run_rust_snippet_in_container(code)?;
    let wall_ms = start.elapsed().as_secs_f64() * 1000.0;

    let telemetry = Telemetry {
        wall_ms,
        exit_code: if out.ok { 0 } else { 1 },
        // CPU/RSS/IO e série temporal: não medíveis via CLI do container (honesto).
        ..Telemetry::default()
    };
    Ok((out, telemetry))
}

/// Resultado de correr o binário do aluno sob medição.
struct MeasuredOutcome {
    timed_out: bool,
    /// Estado cru devolvido por `wait4` (interpretado com as macros `W*`).
    status_raw: i32,
    telemetry: Telemetry,
    stdout: String,
    stderr: String,
}

impl MeasuredOutcome {
    /// Sucesso = não excedeu o tempo e saiu com código 0.
    fn ok(&self) -> bool {
        !self.timed_out && libc::WIFEXITED(self.status_raw) && libc::WEXITSTATUS(self.status_raw) == 0
    }
}

/// Converte uma `timeval` do kernel em milissegundos.
fn timeval_ms(tv: libc::timeval) -> f64 {
    (tv.tv_sec as f64) * 1000.0 + (tv.tv_usec as f64) / 1000.0
}

/// Traduz o estado cru de `wait4` num código de saída legível.
fn exit_code_from_status(raw: i32) -> i32 {
    if libc::WIFEXITED(raw) {
        libc::WEXITSTATUS(raw)
    } else if libc::WIFSIGNALED(raw) {
        128 + libc::WTERMSIG(raw)
    } else {
        -1
    }
}

/// Corre o binário já compilado com o endurecimento da sonda e colhe a `rusage`
/// real via `wait4`, mais o tempo de parede com [`Instant`].
///
/// Usa `wait4(pid, …, WNOHANG, …)` num ciclo de sondagem (igual ao `run_guarded`)
/// para poder impor um timeout de parede: ao exceder, abate o grupo de processos
/// com `SIGKILL` e reconsolida com um `wait4` bloqueante.
fn run_measured_binary(bin: &Path, root: &Path) -> Result<MeasuredOutcome> {
    use std::fs::File;

    let out_path = root.join(".dxtutor-measured.out");
    let err_path = root.join(".dxtutor-measured.err");
    let out_file = File::create(&out_path).context("criar stdout da execução medida")?;
    let err_file = File::create(&err_path).context("criar stderr da execução medida")?;

    let mut cmd = Command::new(bin);
    cmd.current_dir(root);
    configure_probe_env(&mut cmd, root);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::from(out_file));
    cmd.stderr(Stdio::from(err_file));
    // Mesmo endurecimento da sonda: grupo/sessão próprios + setrlimit.
    install_hardening(&mut cmd, Some(PROBE_LIMITS));

    let start = Instant::now();
    let child = cmd.spawn().context("arrancar o binário medido")?;
    let pid = child.id() as libc::pid_t;
    // Reapamos nós próprios com `wait4`; impedimos o `Child` de voltar a esperar
    // o mesmo pid (que poderia já ter sido reciclado) descartando-o sem `wait`.
    std::mem::forget(child);

    let deadline = start + PROBE_TIMEOUT;
    let mut status_raw: libc::c_int = 0;
    // SAFETY: `rusage` é POD; zero-inicializá-la é válido e `wait4` preenche-a.
    let mut rusage: libc::rusage = unsafe { std::mem::zeroed() };

    // Série temporal de memória: uma amostra logo à partida e, depois, uma por
    // iteração do ciclo de sondagem (~POLL_INTERVAL, 25ms). Lê o RSS de
    // `/proc/<pid>/statm` — nada estimado.
    let mut samples: Vec<MemSample> = Vec::new();
    if let Some(rss_kb) = read_rss_kb(pid) {
        samples.push(MemSample { t_ms: start.elapsed().as_secs_f64() * 1000.0, rss_kb });
    }

    let timed_out = loop {
        let ret = unsafe {
            libc::wait4(
                pid,
                &mut status_raw as *mut libc::c_int,
                libc::WNOHANG,
                &mut rusage as *mut libc::rusage,
            )
        };
        if ret == pid {
            break false; // reapado: `status_raw` e `rusage` estão preenchidos.
        }
        if ret == -1 {
            // ECHILD ou erro — nada mais a reapar.
            break false;
        }
        // ret == 0: ainda a correr.
        if Instant::now() >= deadline {
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
            // Reapa de forma bloqueante para não deixar zombie e colher a rusage.
            unsafe {
                libc::wait4(
                    pid,
                    &mut status_raw as *mut libc::c_int,
                    0,
                    &mut rusage as *mut libc::rusage,
                );
            }
            break true;
        }
        // Amostra enquanto o processo vive (melhor-esforço: se `statm` já sumiu
        // porque o processo saiu entre o wait4 e a leitura, simplesmente ignora).
        if samples.len() < MAX_MEM_SAMPLES {
            if let Some(rss_kb) = read_rss_kb(pid) {
                samples.push(MemSample {
                    t_ms: start.elapsed().as_secs_f64() * 1000.0,
                    rss_kb,
                });
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    let wall = start.elapsed();

    let exit_code = if timed_out {
        -1
    } else {
        exit_code_from_status(status_raw)
    };

    // No Linux, `ru_maxrss` já está em kilobytes.
    let peak_rss_kb = rusage.ru_maxrss.max(0) as u64;
    let wall_ms = wall.as_secs_f64() * 1000.0;

    // Garante que a série nunca fica a zero pontos para um processo legítimo: fecha
    // sempre com o instante final no pico de RSS medido pela `rusage` (fonte da
    // verdade do pico). Assim, mesmo um programa curtíssimo traz ≥1-2 pontos.
    if peak_rss_kb > 0 {
        samples.push(MemSample { t_ms: wall_ms, rss_kb: peak_rss_kb });
    }

    let telemetry = Telemetry {
        wall_ms,
        cpu_user_ms: timeval_ms(rusage.ru_utime),
        cpu_sys_ms: timeval_ms(rusage.ru_stime),
        peak_rss_kb,
        io_read_blocks: rusage.ru_inblock.max(0) as u64,
        io_write_blocks: rusage.ru_oublock.max(0) as u64,
        exit_code,
        samples,
    };

    let stderr = if timed_out {
        format!(
            "{}\nexcedeu o tempo limite ({}s) — foi terminado",
            read_lossy(&err_path),
            PROBE_TIMEOUT.as_secs()
        )
    } else {
        read_lossy(&err_path)
    };

    Ok(MeasuredOutcome {
        timed_out,
        status_raw,
        telemetry,
        stdout: read_lossy(&out_path),
        stderr,
    })
}

// ── Pipeline do compilador ───────────────────────────────────────────────────

/// As representações intermédias que o `rustc` gera a partir do código do aluno,
/// mais a desmontagem do binário. Tudo é produzido pela toolchain real; o que ela
/// não suportar nesta versão fica vazio, com a razão honesta em [`Self::notes`].
#[derive(Debug, Clone, Default)]
pub struct Pipeline {
    /// MIR (Mid-level IR) — `--emit=mir`. Vazio se a toolchain não o emitir.
    pub mir: String,
    /// LLVM-IR — `--emit=llvm-ir` (estável).
    pub llvm_ir: String,
    /// Assembly do alvo — `--emit=asm` (estável).
    pub asm: String,
    /// Tamanho, em bytes, do binário optimizado gerado.
    pub binary_bytes: u64,
    /// Desmontagem (`objdump -d`) do binário, se o `objdump` existir no PATH.
    pub disasm: String,
    /// Notas honestas: erros de compilação, fases em falta, ferramentas ausentes.
    pub notes: String,
}

/// Corre o `rustc` sobre o código do aluno a emitir cada representação e lê os
/// ficheiros gerados.
///
/// O binário optimizado é o **portão**: se não compilar, devolve-se um [`Pipeline`]
/// com os campos vazios e o `stderr` do compilador em [`Pipeline::notes`] (sem
/// `Err` de pânico). Em caso de sucesso, emite-se LLVM-IR e assembly (estáveis),
/// tenta-se MIR (nota honesta se falhar) e desmonta-se com `objdump` se existir.
pub fn compile_pipeline(code: &str) -> Result<Pipeline> {
    let dir = tempfile::Builder::new()
        .prefix("dxtutor-pipeline-")
        .tempdir()
        .context("criar directório temporário do pipeline")?;
    let root = dir.path();
    let src = root.join("main.rs");
    std::fs::write(&src, code).context("escrever o código-fonte do pipeline")?;

    let mut notes = String::new();

    // 1) PORTÃO: compilar o binário optimizado. Revela erros de compilação reais.
    let bin = root.join("pipeline-bin");
    let build = rustc_emit(
        root,
        &src,
        &[
            "-O",
            "--crate-name",
            "pipeline_bin",
            "-o",
            bin.to_str().unwrap_or("pipeline-bin"),
        ],
    )?;
    if !build.ok {
        // Erro de compilação: devolve o stderr em notes, campos vazios, sem Err.
        return Ok(Pipeline {
            notes: trim_notes(&build.stderr),
            ..Default::default()
        });
    }
    let binary_bytes = std::fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);

    // 2) LLVM-IR (estável).
    let llvm_ir = match emit_file(root, &src, "llvm-ir", "pipeline_ll", "ll") {
        Ok(text) => truncate_lines(&text, PIPELINE_MAX_LINES),
        Err(e) => {
            notes.push_str(&format!("LLVM-IR indisponível: {e}\n"));
            String::new()
        }
    };

    // 3) Assembly (estável).
    let asm = match emit_file(root, &src, "asm", "pipeline_asm", "s") {
        Ok(text) => truncate_lines(&text, PIPELINE_MAX_LINES),
        Err(e) => {
            notes.push_str(&format!("Assembly indisponível: {e}\n"));
            String::new()
        }
    };

    // 4) MIR — pode exigir nightly em algumas toolchains. Honesto se falhar.
    let mir = match emit_file(root, &src, "mir", "pipeline_mir", "mir") {
        Ok(text) => truncate_lines(&text, PIPELINE_MAX_LINES),
        Err(_) => {
            notes.push_str(
                "MIR não disponível nesta toolchain (normalmente requer o canal nightly: \
                 `rustc +nightly --emit=mir`).\n",
            );
            String::new()
        }
    };

    // 5) Desmontagem via objdump, se existir.
    let disasm = match disassemble(root, &bin) {
        Ok(Some(text)) => truncate_lines(&text, DISASM_MAX_LINES),
        Ok(None) => {
            notes.push_str("Desmontagem indisponível: `objdump` não está no PATH.\n");
            String::new()
        }
        Err(e) => {
            notes.push_str(&format!("Desmontagem falhou: {e}\n"));
            String::new()
        }
    };

    Ok(Pipeline {
        mir,
        llvm_ir,
        asm,
        binary_bytes,
        disasm,
        notes: notes.trim_end().to_string(),
    })
}

/// Saída de uma invocação do `rustc`.
struct RustcOut {
    ok: bool,
    stderr: String,
}

/// Corre `rustc <args> <src>` com ambiente mínimo + offline + grupo próprio +
/// timeout, dentro de `root`.
fn rustc_emit(root: &Path, src: &Path, args: &[&str]) -> Result<RustcOut> {
    let mut cmd = Command::new("rustc");
    cmd.current_dir(root);
    // Reusa o ambiente endurecido do cargo: limpo + toolchain + rede cortada.
    configure_cargo_env(&mut cmd);
    cmd.arg(src);
    for a in args {
        cmd.arg(a);
    }

    let out = run_guarded(cmd, root, "rustc", CARGO_TIMEOUT, None).context("executar `rustc`")?;
    if out.timed_out {
        anyhow::bail!("`rustc` excedeu o tempo limite ({}s)", CARGO_TIMEOUT.as_secs());
    }
    Ok(RustcOut {
        ok: out.status.map(|s| s.success()).unwrap_or(false),
        stderr: out.stderr,
    })
}

/// Emite uma representação com `--emit=<kind>` e lê o ficheiro `<crate_name>.<ext>`.
fn emit_file(root: &Path, src: &Path, kind: &str, crate_name: &str, ext: &str) -> Result<String> {
    let emit = format!("--emit={kind}");
    let out = rustc_emit(root, src, &[&emit, "--crate-name", crate_name, "--out-dir", "."])?;
    if !out.ok {
        anyhow::bail!(
            "rustc --emit={kind} falhou:\n{}",
            trim_notes(&out.stderr)
        );
    }
    let path = root.join(format!("{crate_name}.{ext}"));
    std::fs::read_to_string(&path)
        .with_context(|| format!("ler {}", path.display()))
}

/// Desmonta o binário com `objdump -d` se a ferramenta existir no PATH.
/// `Ok(None)` indica ausência da ferramenta (nota honesta a cargo do chamador).
fn disassemble(root: &Path, bin: &Path) -> Result<Option<String>> {
    if which_objdump().is_none() {
        return Ok(None);
    }
    let mut cmd = Command::new("objdump");
    cmd.current_dir(root);
    configure_cargo_env(&mut cmd);
    // `-d` desmonta as secções executáveis; `--no-show-raw-insn` limpa a saída.
    cmd.args(["-d", "--no-show-raw-insn"]);
    cmd.arg(bin);

    let out = run_guarded(cmd, root, "objdump", CARGO_TIMEOUT, None).context("executar `objdump`")?;
    if out.timed_out {
        anyhow::bail!("`objdump` excedeu o tempo limite");
    }
    if !out.status.map(|s| s.success()).unwrap_or(false) {
        anyhow::bail!("objdump falhou:\n{}", trim_notes(&out.stderr));
    }
    Ok(Some(out.stdout))
}

/// Procura o `objdump` no PATH (sem o executar).
fn which_objdump() -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join("objdump");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Trunca um texto a `max` linhas, acrescentando uma marca honesta se cortou.
fn truncate_lines(text: &str, max: usize) -> String {
    let mut lines = text.lines();
    let head: Vec<&str> = lines.by_ref().take(max).collect();
    let mut out = head.join("\n");
    if lines.next().is_some() {
        out.push_str(&format!("\n… ({max} linhas; truncated)"));
    }
    out
}

/// Limpa o stderr do compilador para caber numa nota (trim + tecto de linhas).
fn trim_notes(stderr: &str) -> String {
    truncate_lines(stderr.trim_end(), 120)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "compila e corre um cargo/rustc aninhado; lento"]
    fn run_measured_hello_world_tem_telemetria_real() {
        let (run, tel) =
            run_rust_snippet_measured("fn main() {\n    println!(\"Hello, measured!\");\n}\n")
                .expect("o sandbox devia arrancar");
        assert!(run.ok, "o hello-world devia compilar e correr; stderr:\n{}", run.stderr);
        assert!(
            run.stdout.contains("Hello"),
            "stdout devia conter 'Hello', obteve-se:\n{}",
            run.stdout
        );
        assert_eq!(tel.exit_code, 0, "código de saída devia ser 0");
        assert!(tel.wall_ms > 0.0, "wall_ms devia ser > 0, obteve-se {}", tel.wall_ms);
        assert!(
            tel.peak_rss_kb > 0,
            "peak_rss_kb devia ser > 0, obteve-se {}",
            tel.peak_rss_kb
        );
        // A série temporal de memória não deve ficar vazia e cada ponto é coerente.
        assert!(
            !tel.samples.is_empty(),
            "a série de memória (samples) não devia estar vazia"
        );
        assert!(
            tel.samples.iter().all(|s| s.t_ms >= 0.0 && s.rss_kb > 0),
            "cada amostra devia ter t_ms>=0 e rss_kb>0; obteve-se {:?}",
            tel.samples
        );
    }

    #[test]
    #[ignore = "corre o rustc aninhado várias vezes; lento"]
    fn compile_pipeline_hello_world_traz_ir_e_asm() {
        let p = compile_pipeline("fn main() {\n    println!(\"Hello, pipeline!\");\n}\n")
            .expect("o pipeline não devia devolver Err");
        assert!(
            !p.llvm_ir.is_empty(),
            "llvm_ir devia estar preenchido; notas:\n{}",
            p.notes
        );
        assert!(
            !p.asm.is_empty(),
            "asm devia estar preenchido; notas:\n{}",
            p.notes
        );
        assert!(p.binary_bytes > 0, "binary_bytes devia ser > 0");
    }
}
