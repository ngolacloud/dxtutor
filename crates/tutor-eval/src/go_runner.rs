//! Avaliador da linguagem **Go** — scaffolda um módulo Go e corre a toolchain real.
//!
//! # Honestidade, igual ao Rust/JS
//!
//! - **Correcção**: montamos um módulo Go descartável (`go.mod` + `student.go` +
//!   `student_test.go`), corremos `go mod tidy` (resolve os imports — é o que
//!   **destrava** pacotes externos) e depois `go test ./...`. O veredicto vem dos
//!   testes da fase — nunca de uma heurística.
//! - **Complexidade**: cronometramos **em Go** (`time.Now`/`time.Since`), à volta da
//!   chamada ao código do aluno, sobre entradas de tamanho `n` crescente (geradas
//!   pela sonda da fase). Aquecemos e tiramos o melhor de várias repetições para
//!   abater o ruído; a sonda imprime `n t` por linha, que o lado Rust interpreta.
//! - **Diagnósticos**: `go build`/`go vet` sobre o código do aluno; cada mensagem
//!   `ficheiro:linha:coluna: …` vira um [`Diagnostic`] posicional.
//!
//! # Host vs. container
//!
//! Tudo respeita [`crate::container::current_engine`]:
//!
//! - **Host** (default) — corre `go`/`go test`/`go run` como subprocesso endurecido
//!   na própria máquina: ambiente mínimo (`env_clear` + só o essencial, com o
//!   `/usr/local/go/bin` no `PATH`), grupo/sessão próprios e um timeout de parede.
//!   O `GOTOOLCHAIN=local` impede descargas de toolchain.
//! - **Container** (`delonix`/`docker`/`podman`) — corre dentro de `golang:1.25-alpine`
//!   via [`crate::container::run_in_container`], montando o directório do módulo em
//!   `/work`, com o volume de cache `dxtutor-go:/go` e **rede ligada** (para que
//!   `go mod tidy`/`go get` descarreguem os módulos externos). É este par
//!   rede + cache persistente que torna os pacotes externos utilizáveis.
//!
//! # Traço
//!
//! O passo-a-passo (estilo Python Tutor) **não** está disponível para Go aqui — ver
//! [`crate::tracer::trace_execution`], que devolve `supported = false` com uma nota
//! honesta. Precisaria de um depurador (delve) que não está integrado.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result};
use tutor_core::{Phase, Probe};

use crate::complexity::Sample;
use crate::container::{
    cache_volumes_for, current_engine, image_for, run_in_container, ContainerSpec, SandboxEngine,
};
use crate::lang::{Diagnostic, LanguageRunner, Severity};
use crate::runner::{run_guarded, RunOutput};

// ── Timeouts (host vs. container) ───────────────────────────────────────────────

/// Timeout de parede do `go test`/`go mod tidy` no host. Um módulo só-stdlib compila
/// e testa em segundos; a folga é para máquinas lentas/CI frio.
const TEST_TIMEOUT_HOST: Duration = Duration::from_secs(90);
/// Timeout do `go test` em container: a primeira execução pode descarregar módulos
/// (`go mod tidy`) e aquecer a cache de compilação — por isso é bem mais generoso.
const TEST_TIMEOUT_CONTAINER: Duration = Duration::from_secs(300);
/// Timeout da sonda de complexidade (compila + corre; a variante quadrática curada
/// corre em segundos). Um ciclo infinito é abatido ao fim deste prazo.
const PROBE_TIMEOUT_HOST: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT_CONTAINER: Duration = Duration::from_secs(240);
/// Timeout de correr um programa Go completo (`go run`).
const RUN_TIMEOUT_HOST: Duration = Duration::from_secs(45);
const RUN_TIMEOUT_CONTAINER: Duration = Duration::from_secs(240);
/// Timeout de um `go build`/`go vet` para diagnósticos.
const DIAG_TIMEOUT_HOST: Duration = Duration::from_secs(45);
const DIAG_TIMEOUT_CONTAINER: Duration = Duration::from_secs(180);

/// Repetições cronometradas por tamanho na sonda; ficamos com a melhor (menos ruído).
const BEST_OF: usize = 7;

/// Escolhe um timeout conforme o motor efectivo seja Host ou container.
fn pick(host: Duration, container: Duration) -> Duration {
    match current_engine() {
        SandboxEngine::Host => host,
        _ => container,
    }
}

// ── O runner ────────────────────────────────────────────────────────────────────

/// Avaliador da linguagem Go.
#[derive(Debug, Clone, Copy, Default)]
pub struct GoRunner;

impl GoRunner {
    pub fn new() -> Self {
        GoRunner
    }
}

impl LanguageRunner for GoRunner {
    /// Correcção = `go mod tidy` + `go test ./...` sobre um módulo `student` com o
    /// código do aluno (`student.go`) e os testes da fase (`student_test.go`).
    fn check_correctness(&self, phase: &Phase, student_code: &str) -> Result<crate::Correctness> {
        let dir = tempfile::Builder::new()
            .prefix("dxtutor-go-test-")
            .tempdir()
            .context("criar directório temporário do módulo Go")?;
        let root = dir.path();
        scaffold_module(root, student_code, Some(&phase.tests), &phase.dependencies)?;

        // `go mod tidy` resolve os imports (stdlib é no-op; externos descarregam com
        // rede); depois `go test -v` para contarmos passes/falhas individuais.
        let script = "go mod tidy && go test -v ./...";
        let out = run_go_script(root, script, pick(TEST_TIMEOUT_HOST, TEST_TIMEOUT_CONTAINER), true)
            .context("correr `go test`")?;

        let mut raw = String::new();
        raw.push_str(&out.stdout);
        raw.push_str(&out.stderr);
        let summary = summarize_go(&raw, out.ok);
        Ok(crate::Correctness {
            passed: out.ok,
            summary,
            raw,
        })
    }

    /// Complexidade = scaffolda um `main` que cronometra a função do aluno sobre
    /// `probe.sizes` (usando os snippets Go `probe.generator`/`probe.call`), imprime
    /// `n t` por tamanho e corre-o com `go run`. Sem sonda ⇒ erro (quem chama deve
    /// verificar `phase.probe` antes).
    fn probe_complexity(&self, phase: &Phase, student_code: &str) -> Result<Vec<Sample>> {
        let probe = phase
            .probe
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("fase {} não tem sonda de complexidade", phase.id))?;

        let dir = tempfile::Builder::new()
            .prefix("dxtutor-go-probe-")
            .tempdir()
            .context("criar directório temporário da sonda Go")?;
        let root = dir.path();
        scaffold_probe_module(root, student_code, probe)?;

        let out = run_go_script(root, "go run .", pick(PROBE_TIMEOUT_HOST, PROBE_TIMEOUT_CONTAINER), true)
            .context("correr a sonda Go")?;
        if !out.ok {
            anyhow::bail!(
                "a sonda Go terminou com erro (possível timeout/ciclo infinito):\n{}\n{}",
                out.stdout,
                out.stderr
            );
        }

        let mut samples = Vec::new();
        for line in out.stdout.lines() {
            let mut it = line.split_whitespace();
            if let (Some(n), Some(t)) = (it.next(), it.next()) {
                if let (Ok(n), Ok(t)) = (n.parse::<f64>(), t.parse::<f64>()) {
                    samples.push(Sample { n, t });
                }
            }
        }
        Ok(samples)
    }

    /// Diagnósticos = `go build ./...` (erros de compilação com linha/coluna) e, se
    /// compilar, `go vet ./...` (avisos). Cada mensagem `ficheiro:linha:coluna: …`
    /// vira um [`Diagnostic`].
    fn diagnostics(&self, student_code: &str) -> Result<Vec<Diagnostic>> {
        let dir = tempfile::Builder::new()
            .prefix("dxtutor-go-check-")
            .tempdir()
            .context("criar directório temporário do check Go")?;
        let root = dir.path();
        scaffold_module(root, student_code, None, &[])?;

        let timeout = pick(DIAG_TIMEOUT_HOST, DIAG_TIMEOUT_CONTAINER);

        // 1) Compilação: os erros trazem posição (`student.go:L:C:`). `go build` sem
        //    artefacto (`-o /dev/null` não é portável no Windows, mas aqui é Linux).
        let build = run_go_script(root, "go build -o /dev/null ./...", timeout, false)
            .context("correr `go build` para diagnósticos")?;
        let mut diags = parse_go_diagnostics(&build.stderr, Severity::Error);
        diags.extend(parse_go_diagnostics(&build.stdout, Severity::Error));

        // 2) Só se compilou é que o `go vet` acrescenta avisos úteis.
        if build.ok {
            let vet = run_go_script(root, "go vet ./...", timeout, false)
                .context("correr `go vet` para diagnósticos")?;
            diags.extend(parse_go_diagnostics(&vet.stderr, Severity::Warning));
            diags.extend(parse_go_diagnostics(&vet.stdout, Severity::Warning));
        }

        Ok(diags)
    }
}

// ── Programa completo (drill / run_path) ─────────────────────────────────────────

/// Corre um programa Go **completo** (`package main; func main`) via `go run` e
/// devolve a sua saída. Escolhe o motor por [`current_engine`]: host corre `go run`
/// como subprocesso endurecido; container corre dentro de `golang:1.25-alpine` com a
/// cache `dxtutor-go` e rede ligada (para `go get`). É a costura que os caminhos de
/// drill/`run_path` usam quando a linguagem é Go.
///
/// Não propaga erro por o programa do aluno falhar a compilar/correr — isso é
/// resultado normal e vai em `ok = false` + `stderr`. Só devolve `Err` se o próprio
/// sandbox não arrancar.
pub fn run_go_program(code: &str) -> Result<RunOutput> {
    run_go_program_with_deps(code, &[])
}

/// Like [`run_go_program`] but pins extra modules in `go.mod` via `require` lines
/// (`módulo versão`). Needed for drills that import an external module whose latest
/// version would demand a newer Go toolchain than the evaluator's. `deps` empty ⇒
/// identical to [`run_go_program`]; stdlib-only code ignores it.
pub fn run_go_program_with_deps(code: &str, deps: &[String]) -> Result<RunOutput> {
    let dir = tempfile::Builder::new()
        .prefix("dxtutor-go-run-")
        .tempdir()
        .context("criar directório temporário do programa Go")?;
    let root = dir.path();
    scaffold_main(root, code, deps)?;
    // `go mod tidy` antes do `go run`: resolve imports externos (no-op para stdlib).
    // É o que torna um programa com `rsc.io/quote` (ou outro módulo) utilizável — a
    // rede/cache do container descarrega a dependência em falta.
    run_go_script(
        root,
        "go mod tidy && go run .",
        pick(RUN_TIMEOUT_HOST, RUN_TIMEOUT_CONTAINER),
        true,
    )
}

// ── Scaffolding do módulo ────────────────────────────────────────────────────────

/// `go.mod` mínimo de um módulo `name`.
fn write_go_mod(root: &Path, name: &str) -> Result<()> {
    write_go_mod_deps(root, name, &[])
}

/// `go.mod` de um módulo `name` com um bloco `require` fixado a partir de `deps`.
/// Cada entrada é uma linha `require` crua — `módulo versão`, ex.:
/// `modernc.org/sqlite v1.38.2`. Fixar a versão é ESSENCIAL: sem pin, `go mod tidy`
/// resolve para a última versão, que pode exigir um toolchain Go mais recente do que
/// o do avaliador (com `GOTOOLCHAIN=local`) e falhar. Vazio ⇒ sem bloco `require`.
fn write_go_mod_deps(root: &Path, name: &str, deps: &[String]) -> Result<()> {
    let mut contents = format!("module {name}\n\ngo 1.21\n");
    if !deps.is_empty() {
        contents.push_str("\nrequire (\n");
        for d in deps {
            contents.push('\t');
            contents.push_str(d.trim());
            contents.push('\n');
        }
        contents.push_str(")\n");
    }
    std::fs::write(root.join("go.mod"), contents)
        .with_context(|| format!("escrever go.mod ({name})"))?;
    Ok(())
}

/// Monta um módulo `student` com o código do aluno em `student.go` (package
/// `student`) e, opcionalmente, os testes da fase em `student_test.go` (mesmo
/// package). Serve a correcção e os diagnósticos.
fn scaffold_module(root: &Path, code: &str, tests: Option<&str>, deps: &[String]) -> Result<()> {
    write_go_mod_deps(root, "student", deps)?;
    std::fs::write(root.join("student.go"), with_package(code, "student"))
        .context("escrever student.go")?;
    if let Some(tests) = tests {
        std::fs::write(root.join("student_test.go"), with_package(tests, "student"))
            .context("escrever student_test.go")?;
    }
    Ok(())
}

/// Monta um módulo `app` com um programa completo do aluno em `main.go` (tal e qual,
/// já com `package main; func main`). Serve `run_go_program`.
fn scaffold_main(root: &Path, code: &str, deps: &[String]) -> Result<()> {
    write_go_mod_deps(root, "app", deps)?;
    std::fs::write(root.join("main.go"), code).context("escrever main.go")?;
    Ok(())
}

/// Monta um módulo `probe` cujo `main.go` cronometra a função do aluno. O código do
/// aluno entra no mesmo `package main`; `probe.prelude`/`generator`/`call` são
/// snippets Go colocados em torno da região cronometrada.
fn scaffold_probe_module(root: &Path, student_code: &str, probe: &Probe) -> Result<()> {
    write_go_mod(root, "probe")?;
    std::fs::write(root.join("main.go"), render_probe(student_code, probe))
        .context("escrever main.go da sonda")?;
    Ok(())
}

/// Prefixa `package <pkg>` se o snippet ainda não declarar um `package`. O conteúdo
/// das fases escreve só a função/testes; o programa completo (que já traz
/// `package main`) fica intacto.
fn with_package(code: &str, pkg: &str) -> String {
    let declares_package = code
        .lines()
        .map(str::trim_start)
        .any(|l| l.starts_with("package "));
    if declares_package {
        code.to_string()
    } else {
        format!("package {pkg}\n\n{code}\n")
    }
}

/// Gera o `main.go` da sonda a partir da especificação. O tempo é medido em Go e a
/// melhor de várias repetições reduz o ruído do agendador — espelha o avaliador Rust.
///
/// Nota de conteúdo: a sonda importa `fmt` e `time`; os snippets Go da fase
/// (`prelude`/`generator`/`call`) não devem reimportar esses dois pacotes.
fn render_probe(student_code: &str, p: &Probe) -> String {
    let sizes = p
        .sizes
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    const TEMPLATE: &str = r#"package main

import (
	"fmt"
	"time"
)

// Sink de nível de pacote: o snippet `call` atribui aqui o resultado para impedir a
// eliminação de código morto pelo compilador.
var __sink interface{}

//PRELUDE//

//STUDENT//

//GENERATOR//

func main() {
	sizes := []int{//SIZES//}
	for _, n := range sizes {
		// Aquecimento (não medido).
		{
			input := gen(n)
			_t := time.Now()
			//CALL//
			_ = _t
			_ = input
		}
		best := int64(1) << 62
		for _rep := 0; _rep < //BESTOF//; _rep++ {
			input := gen(n)
			_t := time.Now()
			//CALL//
			e := time.Since(_t).Nanoseconds()
			if e < best {
				best = e
			}
			_ = input
		}
		fmt.Printf("%d %d\n", n, best)
	}
}
"#;

    TEMPLATE
        .replace("//PRELUDE//", &p.prelude)
        .replace("//STUDENT//", student_code)
        .replace("//GENERATOR//", &p.generator)
        .replace("//SIZES//", &sizes)
        .replace("//BESTOF//", &BEST_OF.to_string())
        .replace("//CALL//", &p.call)
}

// ── Execução (host vs. container) ────────────────────────────────────────────────

/// Corre um script de shell (`sh -c "<script>"`) com a toolchain Go no directório do
/// módulo `dir`, escolhendo o motor por [`current_engine`]. Em container, `network`
/// liga a rede (necessário para `go mod tidy`/`go get`).
fn run_go_script(dir: &Path, script: &str, timeout: Duration, network: bool) -> Result<RunOutput> {
    match current_engine() {
        SandboxEngine::Host => run_go_host(dir, script, timeout),
        _ => run_go_container(dir, script, timeout, network),
    }
}

/// Caminho host: `sh -c "<script>"` com ambiente mínimo (com o `go` no `PATH`),
/// grupo/sessão próprios e timeout de parede. Sem `setrlimit` estrito: a toolchain
/// Go reserva muito espaço de endereçamento virtual (um `RLIMIT_AS` apertado fá-la
/// abortar), por isso a guarda é o timeout + grupo de processos próprio.
fn run_go_host(dir: &Path, script: &str, timeout: Duration) -> Result<RunOutput> {
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(script).current_dir(dir);
    configure_go_env(&mut cmd, dir);

    let outcome = run_guarded(cmd, dir, "go", timeout, None).context("correr a toolchain Go")?;
    if outcome.timed_out {
        return Ok(RunOutput {
            ok: false,
            stdout: outcome.stdout,
            stderr: format!("excedeu o tempo limite ({}s)", timeout.as_secs()),
        });
    }
    let ok = outcome.status.map(|s| s.success()).unwrap_or(false);
    Ok(RunOutput {
        ok,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
    })
}

/// Caminho container: corre `sh -c "<script>"` em `golang:1.25-alpine`, montando
/// `dir` em `/work`, com o volume de cache `dxtutor-go:/go` e `network` conforme
/// pedido. `GOTOOLCHAIN=local` evita descargas de toolchain.
fn run_go_container(dir: &Path, script: &str, timeout: Duration, network: bool) -> Result<RunOutput> {
    let image = image_for("go").expect("go tem imagem conhecida");
    let mut spec = ContainerSpec::new(
        image,
        dir,
        vec!["sh".into(), "-c".into(), script.into()],
    );
    spec.timeout = timeout;
    spec.cache_volumes = cache_volumes_for("go");
    spec.network = network;
    spec.env = vec![
        ("GOTOOLCHAIN".into(), "local".into()),
        ("GO111MODULE".into(), "on".into()),
        ("CGO_ENABLED".into(), "0".into()),
    ];
    run_in_container(spec)
}

/// Ambiente mínimo para a toolchain Go no host: limpo, com o `/usr/local/go/bin` no
/// `PATH`, HOME/caches dentro do tempdir e sem descarga de toolchain. Mantém a rede
/// (o host tem conectividade) para `go mod tidy`/`go get`.
fn configure_go_env(cmd: &mut Command, home: &Path) {
    cmd.env_clear();
    cmd.env("PATH", "/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin");
    cmd.env("HOME", home);
    cmd.env("LANG", "C");
    cmd.env("GOTOOLCHAIN", "local");
    cmd.env("GO111MODULE", "on");
    cmd.env("CGO_ENABLED", "0");
    // Caches isoladas dentro do tempdir (`.`-prefixadas ⇒ ignoradas pelo `./...`).
    cmd.env("GOCACHE", home.join(".gocache"));
    cmd.env("GOPATH", home.join(".gopath"));
    cmd.env("GOTMPDIR", home.as_os_str());
    // Deixa o `go` usar o proxy por omissão (há rede no host) ou a cache já populada.
    if let Some(v) = std::env::var_os("GOPROXY") {
        cmd.env("GOPROXY", v);
    }
    if let Some(v) = std::env::var_os("GOFLAGS") {
        cmd.env("GOFLAGS", v);
    }
}

// ── Interpretação de saída ───────────────────────────────────────────────────────

/// Resume a saída de `go test -v` num resumo legível. Conta `--- PASS:`/`--- FAIL:`;
/// se não houver, distingue falha de compilação de ausência de testes.
fn summarize_go(raw: &str, passed: bool) -> String {
    let mut pass = 0u32;
    let mut fail = 0u32;
    for line in raw.lines() {
        let l = line.trim_start();
        if l.starts_with("--- PASS:") {
            pass += 1;
        } else if l.starts_with("--- FAIL:") {
            fail += 1;
        }
    }
    if pass + fail > 0 {
        return format!("{pass} passaram, {fail} falharam");
    }
    // Erro de compilação: o `go build`/`go test` imprime `./ficheiro.go:L:C: …`.
    if raw.contains(".go:") && (raw.contains("expected") || raw.contains("undefined") || raw.contains("syntax error") || raw.contains("# ")) {
        return "não compilou (erro de compilação)".to_string();
    }
    if raw.contains("[no test files]") || raw.contains("no tests to run") {
        return "nenhum teste correu".to_string();
    }
    if passed {
        "testes passaram".to_string()
    } else {
        "testes falharam".to_string()
    }
}

/// Extrai [`Diagnostic`]s das linhas `ficheiro.go:linha[:coluna]: mensagem` que o
/// `go build`/`go vet` emitem. Linhas sem essa âncora (p.ex. o cabeçalho `# pkg`)
/// são ignoradas.
fn parse_go_diagnostics(text: &str, severity: Severity) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let anchor = match line.find(".go:") {
            Some(i) => i + ".go:".len(),
            None => continue,
        };
        let rest = &line[anchor..];
        // rest = "L:C: msg" ou "L: msg".
        let mut it = rest.splitn(3, ':');
        let line_no = match it.next().and_then(|s| s.trim().parse::<u32>().ok()) {
            Some(n) => n,
            None => continue,
        };
        let second = it.next().unwrap_or("").trim();
        let (col_no, message) = match second.parse::<u32>() {
            // "L:C: msg" — a coluna é o 2º campo; a mensagem é o 3º.
            Ok(c) => (c, it.next().unwrap_or("").trim().to_string()),
            // "L: msg" — não há coluna; o 2º campo já é (o início d)a mensagem.
            Err(_) => {
                let tail = it.next().unwrap_or("");
                let msg = if tail.is_empty() {
                    second.to_string()
                } else {
                    format!("{second}:{tail}")
                };
                (0, msg.trim().to_string())
            }
        };
        if message.is_empty() {
            continue;
        }
        out.push(Diagnostic {
            line: line_no,
            col: col_no,
            severity,
            message,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_package_prefixa_quando_falta_e_respeita_quando_existe() {
        let bare = "func Soma(a, b int) int { return a + b }";
        let wrapped = with_package(bare, "student");
        assert!(wrapped.starts_with("package student"), "devia prefixar: {wrapped}");

        let already = "package main\n\nfunc main() {}";
        assert_eq!(
            with_package(already, "student"),
            already,
            "não devia reprefixar um snippet que já declara package"
        );
    }

    #[test]
    fn summarize_conta_passes_e_falhas() {
        let raw = "=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\nFAIL\n";
        assert_eq!(summarize_go(raw, false), "1 passaram, 1 falharam");

        let ok = "=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\nok  \tstudent\t0.003s\n";
        assert_eq!(summarize_go(ok, true), "1 passaram, 0 falharam");
    }

    #[test]
    fn summarize_deteta_erro_de_compilacao() {
        let raw = "# student\n./student.go:3:10: expected ';', found '}'\n";
        assert_eq!(summarize_go(raw, false), "não compilou (erro de compilação)");
    }

    #[test]
    fn parse_diagnostics_com_linha_e_coluna() {
        let text = "# student\n./student.go:5:9: undefined: foo\n";
        let diags = parse_go_diagnostics(text, Severity::Error);
        assert_eq!(diags.len(), 1, "esperado um diagnóstico: {diags:?}");
        let d = &diags[0];
        assert_eq!(d.line, 5);
        assert_eq!(d.col, 9);
        assert_eq!(d.severity, Severity::Error);
        assert!(d.message.contains("undefined: foo"), "msg: {}", d.message);
    }

    #[test]
    fn parse_diagnostics_sem_coluna() {
        let text = "./student.go:7: something is wrong here\n";
        let diags = parse_go_diagnostics(text, Severity::Warning);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].line, 7);
        assert_eq!(diags[0].col, 0);
        assert!(diags[0].message.contains("something is wrong"));
    }

    #[test]
    fn render_probe_contem_sizes_e_student() {
        let probe = Probe {
            prelude: String::new(),
            generator: "func gen(n int) []int { s := make([]int, n); return s }".into(),
            call: "__sink = sum(input)".into(),
            sizes: vec![10, 20, 40],
            expected: "O(n)".into(),
        };
        let src = render_probe("func sum(xs []int) int { t := 0; for _, x := range xs { t += x }; return t }", &probe);
        assert!(src.contains("package main"), "deve ser package main");
        assert!(src.contains("func gen(n int)"), "deve conter o gerador");
        assert!(src.contains("func sum(xs []int)"), "deve conter o aluno");
        assert!(src.contains("sizes := []int{10, 20, 40}"), "deve conter os tamanhos: {src}");
        assert!(src.contains("__sink = sum(input)"), "deve conter a chamada");
    }
}
