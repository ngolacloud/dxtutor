//! Avaliador de **JavaScript** sobre um motor embebido (QuickJS via `rquickjs`).
//!
//! # Porquê QuickJS embebido
//!
//! O tutor tem de julgar JS sem depender de um browser nem do `node`: quer ser
//! auto-contido, determinístico e barato de sandboxar. `rquickjs` embebe o QuickJS
//! (um interpretador ES2020 pequeno, em C) e compila-o a partir da fonte com o `cc`
//! do sistema — **sem** `bindgen`/`clang` (usa bindings pré-gerados), sem rede e sem
//! toolchain de JS instalada. Comparado com `boa_engine` (motor puro-Rust, a opção
//! de recurso), o QuickJS é mais rápido e mais completo em conformidade, o que importa
//! para cronometrar com fidelidade — por isso é a escolha primária.
//!
//! # Honestidade, igual ao Rust
//!
//! - **Correcção**: injectamos o código do aluno + os testes JS da fase e corremos um
//!   arnês mínimo de `assert` (`test`/`assertEqual`/`assertTrue`) que acumula
//!   passes/falhas. O veredicto vem desses testes — nunca de uma heurística.
//! - **Complexidade**: cronometramos **em Rust** (`Instant`), à volta da chamada ao
//!   motor, a solução do aluno sobre entradas de tamanho `n` crescente (geradas pela
//!   sonda da fase). Aquecemos e tiramos o melhor de várias repetições para abater o
//!   ruído. O resultado é uma *estimativa* empírica, declarada como tal.
//!
//! # Limites
//!
//! Cada avaliação corre num `Runtime` novo com:
//! - **limite de memória** (`set_memory_limit`) para conter bombas de alocação;
//! - **interrupção por tempo de parede** (`set_interrupt_handler` com prazo absoluto):
//!   um ciclo infinito do aluno é abatido quando o prazo expira, e o `eval` devolve
//!   erro em vez de pendurar.
//!
//! Isto não é isolamento de SO (o motor corre no processo); é a 1ª linha de defesa
//! adequada a correr exercícios, análoga ao timeout/rlimits do avaliador Rust.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Context as _, Result};
use rquickjs::{context::EvalOptions, CatchResultExt, Context, Ctx, Runtime, Value};
use tutor_core::Phase;

use crate::complexity::Sample;
use crate::lang::{Correctness, Diagnostic, LanguageRunner, Severity};

/// Prazo de parede para a execução dos testes de correcção.
const CORRECTNESS_TIMEOUT: Duration = Duration::from_secs(10);
/// Prazo de parede para a sonda inteira (todos os tamanhos × repetições). Generoso:
/// a variante O(n²) curada corre em segundos num motor interpretado, mas damos folga
/// para máquinas lentas/CI frio; um ciclo infinito é abatido ao fim deste prazo.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// Prazo de parede para um `check` de diagnósticos (parse + execução de topo).
const DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(5);
/// Tecto de memória do motor: contém bombas de alocação sem derrubar a máquina.
const MEMORY_LIMIT: usize = 256 * 1024 * 1024;
/// Repetições cronometradas por tamanho; ficamos com a melhor (menos ruído).
const BEST_OF: usize = 5;

/// Arnês de testes injectado antes do código do aluno e dos testes da fase.
///
/// Define `test(nome, fn)` (corre `fn` em try/catch, registando passe/falha) e os
/// asserts que os testes da fase usam. Os resultados acumulam em `globalThis.__results`
/// e são lidos em Rust via `JSON.stringify`.
const HARNESS: &str = r#"
globalThis.__results = [];
function __eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function test(name, fn) {
  try {
    fn();
    globalThis.__results.push({ name: name, ok: true, err: "" });
  } catch (e) {
    var m = (e && e.message !== undefined) ? e.message : String(e);
    globalThis.__results.push({ name: name, ok: false, err: String(m) });
  }
}
function assertEqual(actual, expected) {
  if (!__eq(actual, expected)) {
    throw new Error("esperado " + JSON.stringify(expected) + ", obtido " + JSON.stringify(actual));
  }
}
function assertTrue(cond) { if (!cond) throw new Error("condicao falsa"); }
function assertFalse(cond) { if (cond) throw new Error("condicao verdadeira"); }
"#;

/// Avaliador da linguagem JavaScript.
#[derive(Debug, Clone, Copy, Default)]
pub struct JsRunner;

impl JsRunner {
    pub fn new() -> Self {
        JsRunner
    }
}

/// Resultado de um teste individual (espelha o objecto de `__results`).
#[derive(Debug, serde::Deserialize)]
struct TestResult {
    name: String,
    ok: bool,
    #[serde(default)]
    err: String,
}

impl LanguageRunner for JsRunner {
    fn check_correctness(&self, phase: &Phase, student_code: &str) -> Result<Correctness> {
        let (rt, ctx) = new_engine(CORRECTNESS_TIMEOUT)?;
        let _rt = &rt; // manter o Runtime vivo enquanto o Context existe

        ctx.with(|ctx| {
            // 1) Arnês (fidedigno).
            eval_unit(&ctx, HARNESS).context("carregar o arnês de testes JS")?;

            // 2) Código do aluno. Um erro aqui (sintaxe/execução de topo) é uma falha
            //    de correcção legível, não um pânico.
            if let Err(e) = eval_unit(&ctx, student_code) {
                let raw = format!("erro ao carregar o código do aluno:\n{e}");
                return Ok(Correctness {
                    passed: false,
                    summary: "não carregou (erro de sintaxe/execução)".to_string(),
                    raw,
                });
            }

            // 3) Testes da fase (chamam `test(...)`, que captura as falhas internamente).
            if let Err(e) = eval_unit(&ctx, &phase.tests) {
                let raw = format!("erro ao correr os testes da fase:\n{e}");
                return Ok(Correctness {
                    passed: false,
                    summary: "os testes da fase não correram".to_string(),
                    raw,
                });
            }

            // 4) Ler o relatório.
            let json: String = ctx
                .eval("JSON.stringify(globalThis.__results)")
                .catch(&ctx)
                .map_err(|e| anyhow!("ler os resultados dos testes: {e}"))?;
            let results: Vec<TestResult> =
                serde_json::from_str(&json).context("desserializar os resultados dos testes JS")?;

            Ok(summarize(&results))
        })
    }

    fn probe_complexity(&self, phase: &Phase, student_code: &str) -> Result<Vec<Sample>> {
        let probe = phase
            .probe
            .as_ref()
            .ok_or_else(|| anyhow!("fase {} não tem sonda de complexidade", phase.id))?;

        // Programa da sonda: preâmbulo + aluno + gerador + invólucros de medição.
        // `__gen(n)` produz a entrada (não cronometrada); `__call()` corre o código do
        // aluno sobre `globalThis.__input` (a parte cronometrada), devolvendo o
        // resultado para um sink global — impede a eliminação de código morto.
        let program = format!(
            "{prelude}\n{student}\n{generator}\n\
             globalThis.__input = null; globalThis.__sink = null;\n\
             function __gen(n) {{ return gen(n); }}\n\
             function __call() {{ const input = globalThis.__input;\n{call}\n}}\n",
            prelude = probe.prelude,
            student = student_code,
            generator = probe.generator,
            call = probe.call,
        );

        let (rt, ctx) = new_engine(PROBE_TIMEOUT)?;
        let _rt = &rt;

        let start = Instant::now();
        let samples = ctx.with(|ctx| -> Result<Vec<Sample>> {
            eval_unit(&ctx, &program).context("carregar o programa da sonda JS")?;

            let mut samples = Vec::with_capacity(probe.sizes.len());
            for &n in &probe.sizes {
                // Aquecimento (não medido).
                eval_unit(&ctx, &format!("globalThis.__input = __gen({n});"))
                    .with_context(|| format!("gerar entrada de tamanho {n}"))?;
                eval_unit(&ctx, "globalThis.__sink = __call();")
                    .with_context(|| format!("aquecer a chamada em n={n}"))?;

                // Melhor de várias repetições. Cada repetição regenera a entrada fora
                // da região cronometrada, tal como o avaliador Rust.
                let mut best = u128::MAX;
                for _ in 0..BEST_OF {
                    eval_unit(&ctx, &format!("globalThis.__input = __gen({n});"))
                        .with_context(|| format!("gerar entrada de tamanho {n}"))?;
                    let t = Instant::now();
                    eval_unit(&ctx, "globalThis.__sink = __call();")
                        .with_context(|| format!("cronometrar a chamada em n={n}"))?;
                    let e = t.elapsed().as_nanos();
                    if e < best {
                        best = e;
                    }
                }
                samples.push(Sample {
                    n: n as f64,
                    t: best as f64,
                });
            }
            Ok(samples)
        });

        // Se o motor foi interrompido por prazo, dá uma mensagem clara.
        match samples {
            Ok(s) => Ok(s),
            Err(e) if start.elapsed() >= PROBE_TIMEOUT => Err(anyhow!(
                "a sonda JS excedeu o tempo limite ({}s) — possível ciclo infinito: {e}",
                PROBE_TIMEOUT.as_secs()
            )),
            Err(e) => Err(e),
        }
    }

    fn diagnostics(&self, student_code: &str) -> Result<Vec<Diagnostic>> {
        let (rt, ctx) = new_engine(DIAGNOSTICS_TIMEOUT)?;
        let _rt = &rt;

        ctx.with(|ctx| {
            // Avaliamos o código do aluno isolado, por isso as posições de erro
            // mapeiam directamente para as linhas do editor.
            let mut opts = EvalOptions::default();
            opts.strict = false;
            let r: Result<(), rquickjs::Error> = ctx.eval_with_options(student_code, opts);
            match r {
                Ok(()) => Ok(Vec::new()),
                Err(rquickjs::Error::Exception) => {
                    let v: Value = ctx.catch();
                    Ok(vec![diagnostic_from_exception(&v)])
                }
                Err(e) => Ok(vec![Diagnostic {
                    line: 0,
                    col: 0,
                    severity: Severity::Error,
                    message: e.to_string(),
                }]),
            }
        })
    }
}

/// Constrói um `Runtime` + `Context` com limite de memória e interrupção por prazo.
fn new_engine(timeout: Duration) -> Result<(Runtime, Context)> {
    let rt = Runtime::new().context("criar o Runtime QuickJS")?;
    rt.set_memory_limit(MEMORY_LIMIT);
    let deadline = Instant::now() + timeout;
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let ctx = Context::full(&rt).context("criar o Context QuickJS")?;
    Ok((rt, ctx))
}

/// Avalia uma unidade de script (statements), devolvendo a mensagem de erro JS
/// completa (com posição) em caso de excepção.
fn eval_unit(ctx: &Ctx, src: &str) -> Result<()> {
    let mut opts = EvalOptions::default();
    opts.strict = false;
    let r: Result<(), rquickjs::Error> = ctx.eval_with_options(src, opts);
    r.catch(ctx).map_err(|e| anyhow!("{e}")).map(|_| ())
}

/// Resume os resultados dos testes num [`Correctness`].
fn summarize(results: &[TestResult]) -> Correctness {
    let total = results.len();
    let failed: Vec<&TestResult> = results.iter().filter(|r| !r.ok).collect();
    let passed_count = total - failed.len();
    // Passa se houve testes e todos passaram.
    let passed = total > 0 && failed.is_empty();

    let summary = format!("{passed_count} passaram, {} falharam", failed.len());

    let mut raw = String::new();
    for r in results {
        if r.ok {
            raw.push_str(&format!("ok    {}\n", r.name));
        } else {
            raw.push_str(&format!("FALHA {}: {}\n", r.name, r.err));
        }
    }
    if total == 0 {
        raw.push_str("(nenhum teste correu)\n");
    }

    Correctness {
        passed,
        summary,
        raw,
    }
}

/// Extrai um [`Diagnostic`] de um valor de excepção JS (um objecto `Error` com
/// `.message` e `.stack`). A posição vem do primeiro quadro `eval_script:L:C` da
/// pilha; a mensagem vem de `.message`.
fn diagnostic_from_exception(v: &Value) -> Diagnostic {
    let obj = v.as_object();
    let message = obj
        .and_then(|o| o.get::<_, String>("message").ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "erro de JavaScript".to_string());
    let stack = obj
        .and_then(|o| o.get::<_, String>("stack").ok())
        .unwrap_or_default();
    let (line, col) = parse_position(&stack);
    Diagnostic {
        line,
        col,
        severity: Severity::Error,
        message,
    }
}

/// Lê a 1ª posição `eval_script:<linha>:<coluna>` de uma pilha QuickJS.
/// Devolve `(0, 0)` se não encontrar (posição desconhecida).
fn parse_position(stack: &str) -> (u32, u32) {
    const MARKER: &str = "eval_script:";
    let idx = match stack.find(MARKER) {
        Some(i) => i + MARKER.len(),
        None => return (0, 0),
    };
    let rest = &stack[idx..];
    // rest começa em "<linha>:<coluna>" seguido de ')' ou fim de linha.
    let mut it = rest.split(|c: char| c == ':' || c == ')' || c == '\n' || c == ' ');
    let line = it.next().and_then(|s| s.trim().parse::<u32>().ok()).unwrap_or(0);
    let col = it.next().and_then(|s| s.trim().parse::<u32>().ok()).unwrap_or(0);
    (line, col)
}
