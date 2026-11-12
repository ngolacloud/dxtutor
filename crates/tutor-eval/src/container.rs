//! Sandbox em **container Delonix** — a fundação do «tudo corre em container».
//!
//! # Porquê
//!
//! O avaliador do dxtutor compila e corre código não-fidedigno do aluno. O caminho
//! histórico ([`crate::runner`], [`crate::tracer`]) usa um *sandbox bare*: subprocesso
//! na própria máquina com endurecimento barato (grupo/sessão próprios, `setrlimit`,
//! ambiente mínimo, timeout de parede). É sólido para o conteúdo curado, mas tem dois
//! tectos duros:
//!
//! 1. **Isolamento** — sem namespaces/cgroups/seccomp verdadeiros; não aguenta
//!    submissões genuinamente hostis.
//! 2. **Pacotes externos** — a rede está cortada e não há onde persistir caches, por
//!    isso `go get` / `cargo add` / `pip install` não funcionam.
//!
//! Este módulo introduz um segundo motor de execução que resolve ambos: correr o
//! código dentro de um container do runtime **Delonix** (dogfood), rootless e sem
//! `sudo`. O container dá o isolamento real; um **volume de cache nomeado** por
//! linguagem (p.ex. `dxtutor-cargo:/usr/local/cargo`, `dxtutor-go:/go`) persiste os
//! pacotes instalados entre execuções — é isto que **destrava** a instalação de
//! dependências externas (rede + cache persistente).
//!
//! # Fundação, não cutover
//!
//! Esta fase é **aditiva**. O motor é escolhido por [`sandbox_engine`] a partir da
//! variável de ambiente [`ENGINE_ENV`] (`DXTUTOR_SANDBOX_ENGINE`):
//!
//! - `"host"` (**default**) — comportamento ACTUAL; nada muda, todos os gates do
//!   caminho bare continuam a correr exactamente como hoje.
//! - `"delonix"` — usa o container via [`run_in_container`].
//!
//! O mapa linguagem→imagem está em [`image_for`]:
//!
//! | linguagem | imagem               | nota |
//! |-----------|----------------------|------|
//! | python    | `python:3.12-slim`   | já local |
//! | go        | `golang:1.25-alpine` | já local |
//! | rust      | `rust:1-slim`        | **puxar** com `delonix pull rust:1-slim` (~1 GiB) |
//!
//! As imagens em falta puxam-se uma vez com `delonix pull <imagem>` (o próprio
//! `delonix run` também as puxa à primeira, mas preferimos puxar explicitamente).

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

use crate::runner::{read_lossy, RunOutput, POLL_INTERVAL};

/// Nome da variável de ambiente que escolhe o motor de sandbox.
pub const ENGINE_ENV: &str = "DXTUTOR_SANDBOX_ENGINE";

/// Permite apontar o binário `delonix` explicitamente (tem prioridade sobre o
/// `PATH` e sobre `$HOME/.local/bin/delonix`). Útil em CI/testes.
pub const DELONIX_BIN_ENV: &str = "DXTUTOR_DELONIX_BIN";

/// Aponta o binário `docker` explicitamente (prioridade sobre o `PATH`).
pub const DOCKER_BIN_ENV: &str = "DXTUTOR_DOCKER_BIN";

/// Aponta o binário `podman` explicitamente (prioridade sobre o `PATH`).
pub const PODMAN_BIN_ENV: &str = "DXTUTOR_PODMAN_BIN";

/// Timeout de parede por omissão para uma execução em container (inclui o arranque
/// do container). Generoso como no caminho bare, mas nunca eterno.
pub const CONTAINER_TIMEOUT: Duration = Duration::from_secs(30);

// ── Selecção de motor ────────────────────────────────────────────────────────

/// O motor de execução do sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxEngine {
    /// Sandbox *bare* na própria máquina (comportamento histórico). **Default** da
    /// biblioteca/testes.
    Host,
    /// Container do runtime Delonix (dogfood; limpeza explícita `delonix rm -f`).
    Delonix,
    /// Container Docker (`docker run --rm …`; auto-remove).
    Docker,
    /// Container Podman (`podman run --rm …`; auto-remove).
    Podman,
}

// Códigos do estado atómico de motor em runtime. `0` = por definir (cai no
// ambiente/Host); os restantes mapeiam 1:1 para [`SandboxEngine`].
const ENGINE_UNSET: u8 = 0;
const ENGINE_HOST: u8 = 1;
const ENGINE_DELONIX: u8 = 2;
const ENGINE_DOCKER: u8 = 3;
const ENGINE_PODMAN: u8 = 4;

/// Motor escolhido em **runtime** (settable sem variáveis de ambiente). Começa em
/// [`ENGINE_UNSET`] para que a biblioteca/testes fiquem em [`SandboxEngine::Host`]
/// até alguém (p.ex. o desktop) chamar [`set_engine`].
static RUNTIME_ENGINE: AtomicU8 = AtomicU8::new(ENGINE_UNSET);

fn engine_to_code(e: SandboxEngine) -> u8 {
    match e {
        SandboxEngine::Host => ENGINE_HOST,
        SandboxEngine::Delonix => ENGINE_DELONIX,
        SandboxEngine::Docker => ENGINE_DOCKER,
        SandboxEngine::Podman => ENGINE_PODMAN,
    }
}

fn code_to_engine(c: u8) -> Option<SandboxEngine> {
    match c {
        ENGINE_HOST => Some(SandboxEngine::Host),
        ENGINE_DELONIX => Some(SandboxEngine::Delonix),
        ENGINE_DOCKER => Some(SandboxEngine::Docker),
        ENGINE_PODMAN => Some(SandboxEngine::Podman),
        _ => None,
    }
}

/// Converte um nome (`"host"`/`"delonix"`/`"docker"`/`"podman"`, sem distinção de
/// maiúsculas) no motor correspondente. Desconhecido ⇒ `None`.
pub fn parse_engine(s: &str) -> Option<SandboxEngine> {
    match s.trim().to_ascii_lowercase().as_str() {
        "host" => Some(SandboxEngine::Host),
        "delonix" => Some(SandboxEngine::Delonix),
        "docker" => Some(SandboxEngine::Docker),
        "podman" => Some(SandboxEngine::Podman),
        _ => None,
    }
}

/// Nome curto e estável do motor (`"host"`/`"delonix"`/`"docker"`/`"podman"`).
pub fn engine_name(e: SandboxEngine) -> &'static str {
    match e {
        SandboxEngine::Host => "host",
        SandboxEngine::Delonix => "delonix",
        SandboxEngine::Docker => "docker",
        SandboxEngine::Podman => "podman",
    }
}

/// Define o motor de sandbox em **runtime** — tem prioridade sobre [`ENGINE_ENV`].
/// O desktop chama isto no arranque (p.ex. `set_engine(SandboxEngine::Delonix)`).
pub fn set_engine(engine: SandboxEngine) {
    RUNTIME_ENGINE.store(engine_to_code(engine), Ordering::Relaxed);
}

/// Lê apenas [`ENGINE_ENV`] e devolve o motor escolhido. Ausente ou valor
/// desconhecido ⇒ [`SandboxEngine::Host`]. Não consulta o estado de runtime — é o
/// degrau inferior da precedência de [`current_engine`].
pub fn sandbox_engine() -> SandboxEngine {
    std::env::var(ENGINE_ENV)
        .ok()
        .as_deref()
        .and_then(parse_engine)
        .unwrap_or(SandboxEngine::Host)
}

/// O motor efectivo, com a precedência: **runtime** ([`set_engine`]) se definido →
/// senão **ambiente** ([`ENGINE_ENV`]) → senão **Host**. É esta função que os
/// caminhos de execução consultam para decidir entre host e container.
pub fn current_engine() -> SandboxEngine {
    match code_to_engine(RUNTIME_ENGINE.load(Ordering::Relaxed)) {
        Some(e) => e,
        None => sandbox_engine(),
    }
}

/// O motor a usar quando um caminho de execução EXIGE container. Resolve
/// [`current_engine`] e, se por acaso for [`SandboxEngine::Host`] (chamada directa
/// fora dos caminhos normais), assume [`SandboxEngine::Delonix`] como container por
/// omissão — nunca corre bare quando um container foi pedido explicitamente.
fn container_engine() -> SandboxEngine {
    match current_engine() {
        SandboxEngine::Host => SandboxEngine::Delonix,
        e => e,
    }
}

/// Mapa linguagem→imagem de container. `None` para linguagens sem imagem conhecida.
///
/// `rust:1-slim` tem de ser puxada (`delonix pull rust:1-slim`, ~1 GiB); as outras
/// já estão disponíveis localmente.
pub fn image_for(language: &str) -> Option<&'static str> {
    match language.trim().to_ascii_lowercase().as_str() {
        "python" | "py" | "python3" => Some("python:3.12-slim"),
        "go" | "golang" => Some("golang:1.25-alpine"),
        "rust" | "rs" => Some("rust:1-slim"),
        _ => None,
    }
}

/// Volumes de cache persistentes recomendados por linguagem — `(nome_volume, /alvo)`.
///
/// É a peça que **destrava** os pacotes externos: ao montar um volume nomeado no
/// directório onde a toolchain guarda os pacotes, o que `cargo add`/`go get`/`pip`
/// instalam numa execução persiste para a seguinte, em vez de se perder com o
/// container efémero. A rede tem de estar ligada (`network = true`) para a primeira
/// descarga.
pub fn cache_volumes_for(language: &str) -> Vec<(String, String)> {
    match language.trim().to_ascii_lowercase().as_str() {
        // Na imagem `rust:1-slim`, `CARGO_HOME=/usr/local/cargo` e o binário `cargo`
        // vive em `/usr/local/cargo/bin`. Montar um volume vazio no topo de
        // `/usr/local/cargo` ESCONDE o `cargo` (ENOENT ao exec). Cacheamos só o
        // `registry/` (crates descarregados) — persiste os pacotes sem tapar a
        // toolchain.
        "rust" | "rs" => vec![("dxtutor-cargo".into(), "/usr/local/cargo/registry".into())],
        "go" | "golang" => vec![("dxtutor-go".into(), "/go".into())],
        "python" | "py" | "python3" => vec![("dxtutor-pip".into(), "/root/.cache/pip".into())],
        _ => Vec::new(),
    }
}

// ── Especificação e execução ───────────────────────────────────────────────────

/// Especificação de uma execução em container.
///
/// Monta o directório do trabalho em `/work` e corre `cmd` lá dentro. Ver
/// [`run_in_container`] para a semântica exacta do comando gerado.
#[derive(Debug, Clone)]
pub struct ContainerSpec {
    /// Imagem a correr (p.ex. `python:3.12-slim`). Ver [`image_for`].
    pub image: String,
    /// Directório do host montado em `/work` (e directório de trabalho do processo).
    pub workdir_host: PathBuf,
    /// Comando + argumentos a executar dentro do container.
    pub cmd: Vec<String>,
    /// Timeout de parede; ao exceder, o container é abatido e marca-se erro.
    pub timeout: Duration,
    /// Variáveis de ambiente extra (`KEY=VAL`) injectadas com `-e`.
    pub env: Vec<(String, String)>,
    /// Volumes de cache persistentes `(nome_volume, /alvo)`. Ver [`cache_volumes_for`].
    pub cache_volumes: Vec<(String, String)>,
    /// `true` dá rede ao container (necessário para `go get`/`cargo add`/`pip`);
    /// `false` corre com `--net none` (isolado, sem conectividade).
    pub network: bool,
}

impl ContainerSpec {
    /// Especificação mínima: imagem, directório de trabalho e comando. Sem env extra,
    /// sem volumes de cache, sem rede e com [`CONTAINER_TIMEOUT`].
    pub fn new(image: impl Into<String>, workdir_host: impl Into<PathBuf>, cmd: Vec<String>) -> Self {
        ContainerSpec {
            image: image.into(),
            workdir_host: workdir_host.into(),
            cmd,
            timeout: CONTAINER_TIMEOUT,
            env: Vec::new(),
            cache_volumes: Vec::new(),
            network: false,
        }
    }
}

/// Resolve o binário `delonix`: [`DELONIX_BIN_ENV`] → `$HOME/.local/bin/delonix` →
/// `delonix` (confiando no `PATH`).
fn delonix_bin() -> PathBuf {
    if let Ok(p) = std::env::var(DELONIX_BIN_ENV) {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let cand = Path::new(&home).join(".local/bin/delonix");
        if cand.is_file() {
            return cand;
        }
    }
    PathBuf::from("delonix")
}

/// Resolve um binário simples a partir de uma variável de ambiente (p.ex.
/// [`DOCKER_BIN_ENV`]) ou, em falta dela, confia no `PATH` com `fallback`.
fn bin_from_env(env: &str, fallback: &str) -> PathBuf {
    if let Ok(p) = std::env::var(env) {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from(fallback)
}

/// O binário do CLI de cada motor de container.
fn engine_bin(engine: SandboxEngine) -> PathBuf {
    match engine {
        // Host não tem CLI de container; nunca é chamado neste caminho.
        SandboxEngine::Host | SandboxEngine::Delonix => delonix_bin(),
        SandboxEngine::Docker => bin_from_env(DOCKER_BIN_ENV, "docker"),
        SandboxEngine::Podman => bin_from_env(PODMAN_BIN_ENV, "podman"),
    }
}

/// `true` se o `bin` existe (caminho absoluto) ou é localizável no `PATH`.
fn bin_available(bin: &Path) -> bool {
    if bin.is_absolute() {
        return bin.is_file();
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if dir.join(bin).is_file() {
                return true;
            }
        }
    }
    false
}

/// `true` se o CLI do `engine` parece disponível. Serve para portões de teste.
pub fn engine_available(engine: SandboxEngine) -> bool {
    match engine {
        SandboxEngine::Host => true,
        other => bin_available(&engine_bin(other)),
    }
}

/// `true` se o binário `delonix` parece estar disponível (ficheiro resolvido ou
/// localizável no `PATH`). Serve para portões de teste.
pub fn delonix_available() -> bool {
    engine_available(SandboxEngine::Delonix)
}

/// Constrói uma imagem a partir de um `dockerfile` (com `context` como contexto de build)
/// e etiqueta-a como `tag`, usando o CLI do motor activo (`<engine> build -t tag -f
/// dockerfile context`). Devolve a saída combinada; erro em falha de build.
pub fn build_image(context: &Path, dockerfile: &Path, tag: &str) -> Result<String> {
    let engine = container_engine();
    let bin = engine_bin(engine);
    let out = Command::new(&bin)
        .arg("build")
        .arg("-t")
        .arg(tag)
        .arg("-f")
        .arg(dockerfile)
        .arg(context)
        .output()
        .with_context(|| format!("falha a lançar `{} build`", bin.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(format!("{stdout}{stderr}"))
    } else {
        anyhow::bail!("build falhou:\n{stderr}{stdout}")
    }
}

/// Gera um nome de container único sem depender de `Date`/`rand` (proibidos no host):
/// `dxtutor-<pid>-<contador>-<nanos>`, onde o contador é atómico global e os nanos
/// vêm de um [`Instant`] de arranque do processo.
fn unique_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    let epoch = *EPOCH.get_or_init(Instant::now);
    let pid = std::process::id();
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = epoch.elapsed().as_nanos();
    format!("dxtutor-{pid}-{c}-{nanos}")
}

/// Guarda RAII que garante a remoção do container no fim — mesmo em erro ou pânico.
///
/// A limpeza é **por motor**:
/// - **delonix**: o `--rm` faz o rootfs read-only (**não** é auto-remove), por isso
///   a remoção é sempre explícita (`delonix rm -f <nome>`).
/// - **docker/podman**: o `--rm` É auto-remove na saída normal, mas se o container
///   foi abatido por timeout pode sobrar; corre-se `rm -f <nome>` por garantia
///   (inócuo se já desapareceu).
struct ContainerGuard {
    engine: SandboxEngine,
    bin: PathBuf,
    name: String,
}

impl Drop for ContainerGuard {
    fn drop(&mut self) {
        // Todos os CLIs (delonix/docker/podman) suportam `rm -f <nome>`.
        if matches!(self.engine, SandboxEngine::Host) {
            return;
        }
        let _ = Command::new(&self.bin)
            .args(["rm", "-f", &self.name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Abate um container em execução (no timeout), de forma específica do motor.
fn kill_container(engine: SandboxEngine, bin: &Path, name: &str) {
    let run = |args: &[&str]| {
        let _ = Command::new(bin)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    };
    match engine {
        // O delonix distingue kill (sinal) de stop (paragem ordenada).
        SandboxEngine::Delonix => {
            run(&["kill", name]);
            run(&["stop", name]);
        }
        // docker/podman: um kill basta; o `--rm` + guard tratam da remoção.
        SandboxEngine::Docker | SandboxEngine::Podman => {
            run(&["kill", name]);
        }
        SandboxEngine::Host => {}
    }
}

/// Monta e corre o comando dentro de um container, capturando a saída. O motor é o
/// de [`current_engine`] (delonix/docker/podman); nunca Host (ver [`container_engine`]).
///
/// Comando gerado (flags `-v`/`-w`/`-e`/rede são comuns; o que muda é o auto-remove
/// e o nome da flag de rede):
///
/// ```text
/// delonix run         --name dxtutor-<uniq> -v <host>:/work -w /work [--net none]     …
/// docker|podman run --rm --name dxtutor-<uniq> -v <host>:/work -w /work [--network none] …
///     [-v <vol>:<alvo> ...]        # cada cache_volumes
///     [-e KEY=VAL ...]             # cada env
///     <image> <cmd...>
/// ```
///
/// - **Captura sem deadlock**: `stdout`/`stderr` do CLI vão para ficheiros num
///   tempdir e lêem-se no fim (evita o bloqueio de um buffer de pipe cheio).
/// - **Timeout**: ao exceder `spec.timeout`, abate-se o container (ver
///   [`kill_container`]), mata-se o processo do CLI e marca-se erro no [`RunOutput`].
/// - **Limpeza**: um guard RAII garante a remoção no fim, conforme o motor.
///
/// Devolve `Err` só se o próprio arranque falhar; um comando do aluno que termine com
/// erro é resultado normal e vai em `ok = false` + `stderr`.
pub fn run_in_container(spec: ContainerSpec) -> Result<RunOutput> {
    let engine = container_engine();
    let bin = engine_bin(engine);
    let name = unique_name();

    // A limpeza é instalada JÁ: se qualquer passo abaixo falhar (ou houver pânico),
    // o container é removido na mesma.
    let _guard = ContainerGuard {
        engine,
        bin: bin.clone(),
        name: name.clone(),
    };

    // Caminho absoluto do mount (os runtimes exigem origem resolúvel).
    let workdir = spec
        .workdir_host
        .canonicalize()
        .unwrap_or_else(|_| spec.workdir_host.clone());
    let mount = format!("{}:/work", workdir.display());

    // Ficheiros de captura num tempdir próprio (fora do /work montado).
    let cap = tempfile::Builder::new()
        .prefix("dxtutor-cap-")
        .tempdir()
        .context("criar tempdir de captura do container")?;
    let out_path = cap.path().join("out");
    let err_path = cap.path().join("err");
    let out_file = File::create(&out_path).context("criar ficheiro de stdout do container")?;
    let err_file = File::create(&err_path).context("criar ficheiro de stderr do container")?;

    let mut cmd = Command::new(&bin);
    cmd.arg("run");
    // docker/podman: `--rm` É auto-remove. delonix: a remoção é feita pelo guard.
    if matches!(engine, SandboxEngine::Docker | SandboxEngine::Podman) {
        cmd.arg("--rm");
    }
    cmd.args(["--name", &name]);
    cmd.args(["-v", &mount]);
    cmd.args(["-w", "/work"]);
    if !spec.network {
        // delonix usa `--net`; docker/podman usam `--network`. Ambos aceitam `none`.
        let net_flag = match engine {
            SandboxEngine::Delonix => "--net",
            _ => "--network",
        };
        cmd.args([net_flag, "none"]);
    }
    for (vol, target) in &spec.cache_volumes {
        cmd.arg("-v");
        cmd.arg(format!("{vol}:{target}"));
    }
    for (k, v) in &spec.env {
        cmd.arg("-e");
        cmd.arg(format!("{k}={v}"));
    }
    cmd.arg(&spec.image);
    cmd.args(&spec.cmd);

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::from(out_file));
    cmd.stderr(Stdio::from(err_file));

    let mut child = cmd
        .spawn()
        .with_context(|| format!("arrancar `{} run` ({})", engine_name(engine), bin.display()))?;
    let deadline = Instant::now() + spec.timeout;

    let (timed_out, status) = loop {
        match child.try_wait().context("sondar o processo do container")? {
            Some(status) => break (false, Some(status)),
            None => {
                if Instant::now() >= deadline {
                    // Abater o container no runtime e depois o CLI local.
                    kill_container(engine, &bin, &name);
                    let _ = child.kill();
                    let _ = child.wait();
                    break (true, None);
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        }
    };

    let stdout = read_lossy(&out_path);
    let mut stderr = read_lossy(&err_path);

    if timed_out {
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        stderr.push_str(&format!(
            "[dxtutor] excedeu o tempo limite ({}s) — container {name} abatido",
            spec.timeout.as_secs()
        ));
        return Ok(RunOutput {
            ok: false,
            stdout,
            stderr,
        });
    }

    let ok = status.map(|s| s.success()).unwrap_or(false);
    Ok(RunOutput { ok, stdout, stderr })
    // `_guard` cai aqui → remoção do container conforme o motor.
}

// ── Caminho integrado: Python ──────────────────────────────────────────────────

/// Timeout da execução de um snippet Python avulso.
const PY_SNIPPET_TIMEOUT: Duration = Duration::from_secs(15);

/// Corre um snippet Python **completo** e devolve a sua saída, escolhendo o motor
/// por [`current_engine`]:
///
/// - `Host` — `python3` como subprocesso endurecido na máquina (equivalente ao
///   restante caminho bare); é o comportamento por omissão, nada muda.
/// - `Delonix`/`Docker`/`Podman` — dentro de um container `python:3.12-slim` via
///   [`run_in_container`].
pub fn run_python_in_sandbox(code: &str) -> Result<RunOutput> {
    match current_engine() {
        SandboxEngine::Host => run_python_host(code),
        _ => run_python_container(code),
    }
}

/// Caminho host: escreve o snippet num tempdir e corre `python3` com endurecimento
/// barato (ambiente mínimo, grupo/sessão próprios, `setrlimit`, timeout de parede),
/// reutilizando a infra-estrutura de [`crate::runner`].
fn run_python_host(code: &str) -> Result<RunOutput> {
    use crate::runner::{run_guarded, Rlimits};

    const PY_LIMITS: Rlimits = Rlimits {
        cpu_secs: 20,
        as_bytes: 2 * 1024 * 1024 * 1024,
        fsize_bytes: 64 * 1024 * 1024,
        nproc: 256,
    };

    let dir = tempfile::Builder::new()
        .prefix("dxtutor-pysbx-")
        .tempdir()
        .context("criar tempdir do snippet python")?;
    let root = dir.path();
    let script = root.join("student.py");
    std::fs::write(&script, code).context("escrever o snippet python")?;

    let mut cmd = Command::new("python3");
    cmd.current_dir(root);
    cmd.arg(&script);
    cmd.env_clear();
    cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin");
    cmd.env("HOME", root);
    cmd.env("LANG", "C.UTF-8");
    cmd.env("PYTHONDONTWRITEBYTECODE", "1");
    cmd.env("PYTHONNOUSERSITE", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");

    let outcome = run_guarded(cmd, root, "pysbx", PY_SNIPPET_TIMEOUT, Some(PY_LIMITS))
        .context("correr `python3` (host)")?;

    if outcome.timed_out {
        return Ok(RunOutput {
            ok: false,
            stdout: outcome.stdout,
            stderr: format!("excedeu o tempo limite ({}s)", PY_SNIPPET_TIMEOUT.as_secs()),
        });
    }
    let ok = outcome.status.map(|s| s.success()).unwrap_or(false);
    Ok(RunOutput {
        ok,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
    })
}

/// Caminho container: escreve o snippet num tempdir montado em `/work` e corre
/// `python3 student.py` no container `python:3.12-slim` (sem rede).
fn run_python_container(code: &str) -> Result<RunOutput> {
    let dir = tempfile::Builder::new()
        .prefix("dxtutor-pysbx-")
        .tempdir()
        .context("criar tempdir do snippet python")?;
    let root = dir.path();
    std::fs::write(root.join("student.py"), code).context("escrever o snippet python")?;

    let image = image_for("python").expect("python tem imagem conhecida");
    let mut spec = ContainerSpec::new(image, root, vec!["python3".into(), "student.py".into()]);
    spec.timeout = PY_SNIPPET_TIMEOUT;
    spec.env = vec![("PYTHONDONTWRITEBYTECODE".into(), "1".into())];

    // `dir` (TempDir) vive até ao fim desta função — o container lê o ficheiro
    // montado antes de `run_in_container` regressar.
    run_in_container(spec)
}

// ── Caminho integrado: Rust ─────────────────────────────────────────────────────

/// Timeout generoso para compilar+correr um snippet Rust num container (inclui o
/// arranque do container e um `cargo` possivelmente frio). Maior que o host porque
/// a cache de compilação do container começa vazia à primeira.
pub const RUST_CONTAINER_TIMEOUT: Duration = Duration::from_secs(180);

/// Monta um pacote `bin` cargo (via [`crate::runner::scaffold_bin`]) num tempdir,
/// monta-o em `/work` e corre `cargo run` no container `rust:1-slim`, com o volume
/// de cache `dxtutor-cargo` e **rede ligada** (para `cargo add`/registo). Devolve a
/// saída capturada.
///
/// É a costura que os caminhos de drill/measured usam quando o motor não é Host.
/// `dir` (TempDir) vive até ao fim — o container compila/corre antes do regresso.
pub fn run_rust_snippet_in_container(code: &str) -> Result<RunOutput> {
    run_rust_snippet_in_container_deps(code, &[])
}

/// Like [`run_rust_snippet_in_container`] but writes extra Cargo `[dependencies]`
/// into the scaffolded crate (for drills that pull in an external crate). NOTE:
/// crates that compile C (e.g. `rusqlite` with `bundled`) need a C toolchain in
/// the image; `rust:1-slim` has none, so such deps only build on the Host engine
/// until the image is bumped.
pub fn run_rust_snippet_in_container_deps(code: &str, deps: &[String]) -> Result<RunOutput> {
    let (_dir, spec) = rust_snippet_spec_deps(code, deps)?;
    run_in_container(spec)
}

/// Prepara o tempdir scaffoldado e a [`ContainerSpec`] para correr um snippet Rust
/// no container. Devolve também o [`tempfile::TempDir`] para que o chamador o
/// mantenha vivo durante a execução (o seu conteúdo está montado em `/work`).
pub(crate) fn rust_snippet_spec_deps(
    code: &str,
    deps: &[String],
) -> Result<(tempfile::TempDir, ContainerSpec)> {
    let dir = tempfile::Builder::new()
        .prefix("dxtutor-rustsbx-")
        .tempdir()
        .context("criar tempdir do snippet rust")?;
    crate::runner::scaffold_bin_deps(dir.path(), code, deps)?;

    let image = image_for("rust").expect("rust tem imagem conhecida");
    let mut spec = ContainerSpec::new(
        image,
        dir.path(),
        vec!["cargo".into(), "run".into(), "--quiet".into()],
    );
    spec.timeout = RUST_CONTAINER_TIMEOUT;
    spec.cache_volumes = cache_volumes_for("rust");
    // Rede ligada: destrava `cargo add`/registo; um snippet sem dependências também
    // compila na mesma.
    spec.network = true;
    Ok((dir, spec))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motor_por_omissao_e_host() {
        // Só verificável quando a variável não está definida (ambiente de CI/local
        // normal). Com ela definida, respeitamos a escolha de quem corre os testes.
        if std::env::var(ENGINE_ENV).is_err() {
            assert_eq!(sandbox_engine(), SandboxEngine::Host);
        }
    }

    #[test]
    fn mapa_de_imagens_por_linguagem() {
        assert_eq!(image_for("python"), Some("python:3.12-slim"));
        assert_eq!(image_for("Py"), Some("python:3.12-slim"));
        assert_eq!(image_for("go"), Some("golang:1.25-alpine"));
        assert_eq!(image_for("rust"), Some("rust:1-slim"));
        assert_eq!(image_for("cobol"), None);
    }

    #[test]
    fn volumes_de_cache_por_linguagem() {
        assert_eq!(
            cache_volumes_for("rust"),
            vec![(
                "dxtutor-cargo".to_string(),
                "/usr/local/cargo/registry".to_string()
            )]
        );
        assert_eq!(
            cache_volumes_for("go"),
            vec![("dxtutor-go".to_string(), "/go".to_string())]
        );
        assert!(cache_volumes_for("cobol").is_empty());
    }

    #[test]
    fn nomes_de_container_sao_unicos() {
        let a = unique_name();
        let b = unique_name();
        assert_ne!(a, b, "dois nomes consecutivos têm de diferir");
        assert!(a.starts_with("dxtutor-"), "prefixo esperado: {a}");
    }

    #[test]
    fn parse_e_nome_de_motor_fazem_roundtrip() {
        for e in [
            SandboxEngine::Host,
            SandboxEngine::Delonix,
            SandboxEngine::Docker,
            SandboxEngine::Podman,
        ] {
            assert_eq!(parse_engine(engine_name(e)), Some(e));
        }
        assert_eq!(parse_engine("DELONIX"), Some(SandboxEngine::Delonix));
        assert_eq!(parse_engine("  podman "), Some(SandboxEngine::Podman));
        assert_eq!(parse_engine("qemu"), None);
    }

    #[test]
    fn codigos_de_motor_fazem_roundtrip() {
        for e in [
            SandboxEngine::Host,
            SandboxEngine::Delonix,
            SandboxEngine::Docker,
            SandboxEngine::Podman,
        ] {
            assert_eq!(code_to_engine(engine_to_code(e)), Some(e));
        }
        assert_eq!(code_to_engine(ENGINE_UNSET), None);
    }

    #[test]
    fn binario_por_motor_respeita_a_variavel_de_ambiente() {
        // Não dependemos do ambiente real: apenas confirmamos que o override
        // explícito via variável é respeitado para docker/podman.
        std::env::set_var(DOCKER_BIN_ENV, "/opt/docker-test/docker");
        std::env::set_var(PODMAN_BIN_ENV, "/opt/podman-test/podman");
        assert_eq!(
            engine_bin(SandboxEngine::Docker),
            PathBuf::from("/opt/docker-test/docker")
        );
        assert_eq!(
            engine_bin(SandboxEngine::Podman),
            PathBuf::from("/opt/podman-test/podman")
        );
        std::env::remove_var(DOCKER_BIN_ENV);
        std::env::remove_var(PODMAN_BIN_ENV);
    }

    #[test]
    fn selecao_runtime_tem_precedencia_e_reverte_para_host() {
        // Precedência: runtime (set_engine) bate o ambiente. Começamos e acabamos em
        // Host — o default seguro — para não perturbar execuções paralelas (todas as
        // que tocam o container são `#[ignore]`).
        set_engine(SandboxEngine::Docker);
        assert_eq!(current_engine(), SandboxEngine::Docker);
        set_engine(SandboxEngine::Podman);
        assert_eq!(current_engine(), SandboxEngine::Podman);
        set_engine(SandboxEngine::Host);
        assert_eq!(current_engine(), SandboxEngine::Host);
    }

    /// Prova de ponta a ponta do motor container (Python). **Portão**: só corre se o
    /// motor não for Host E o CLI do motor existir. Correr explicitamente com:
    ///
    /// ```text
    /// DXTUTOR_SANDBOX_ENGINE=delonix cargo test -p tutor-eval \
    ///     container::tests::snippet_python_corre_em_container -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "requer um motor de container + DXTUTOR_SANDBOX_ENGINE!=host; imagem python:3.12-slim"]
    fn snippet_python_corre_em_container() {
        let engine = current_engine();
        if engine == SandboxEngine::Host || !engine_available(engine) {
            eprintln!("salto: motor == host ou CLI do motor ({engine:?}) ausente");
            return;
        }
        let out = run_python_in_sandbox("print('ola do container')\n")
            .expect("correr o snippet no container não devia falhar o sandbox");
        assert!(out.ok, "o snippet devia sair com sucesso; stderr:\n{}", out.stderr);
        assert!(
            out.stdout.contains("ola do container"),
            "stdout devia conter 'ola do container', obteve-se:\n{}",
            out.stdout
        );
    }

    /// Prova de ponta a ponta do motor container (Rust): compila+corre um snippet no
    /// container `rust:1-slim`. **Portão**: motor != Host, CLI presente e imagem
    /// `rust:1-slim` disponível localmente (caso contrário salta com nota). Correr:
    ///
    /// ```text
    /// DXTUTOR_SANDBOX_ENGINE=delonix cargo test -p tutor-eval \
    ///     container::tests::snippet_rust_corre_em_container -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "requer um motor de container + imagem rust:1-slim; compila cargo no container (lento)"]
    fn snippet_rust_corre_em_container() {
        let engine = current_engine();
        if engine == SandboxEngine::Host || !engine_available(engine) {
            eprintln!("salto: motor == host ou CLI do motor ({engine:?}) ausente");
            return;
        }
        let out = run_rust_snippet_in_container(
            "fn main() { println!(\"ola rust do container\"); }\n",
        )
        .expect("o sandbox do container não devia falhar a arrancar");
        assert!(
            out.ok,
            "o snippet rust devia compilar e correr; stderr:\n{}",
            out.stderr
        );
        assert!(
            out.stdout.contains("ola rust do container"),
            "stdout devia conter a linha esperada, obteve-se:\n{}",
            out.stdout
        );
    }
}
