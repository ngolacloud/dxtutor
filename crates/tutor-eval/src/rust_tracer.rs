//! Traçador de execução de **Rust** por instrumentação de código-fonte — honesto.
//!
//! O Python é traçável «de borla» com `sys.settrace`; o Rust não tem esse gancho
//! e aqui não há depurador (gdb/lldb). Em vez de inventar, **instrumentamos o
//! código-fonte do aluno**: parseamos o programa com [`syn`], injectamos, antes
//! ou depois de cada instrução, uma chamada a um helper de traço que imprime para
//! **stderr** uma linha JSON `{line, func, depth, vars:[{name,value,ty}]}`, e
//! compilamos+corremos o binário instrumentado no mesmo sandbox do avaliador.
//! O traço é a execução REAL — nada é fabricado.
//!
//! # O truque do Debug (autoref-specialization)
//!
//! Para capturar o valor de uma variável sem exigir que o seu tipo implemente
//! [`std::fmt::Debug`] (o que faria a instrumentação deixar de compilar em código
//! legítimo), usamos *autoref-specialization*: dois traços com o mesmo método
//! `__dxtutor_dbg`, um especializado `impl<T: Debug> … for T` (recebe `&T`) e um
//! genérico de recurso `impl<T> … for &T` (recebe `&&T`). A chamada `(&x).__dxtutor_dbg()`
//! resolve para o especializado quando `T: Debug` (0 autorefs) e cai para o genérico
//! (`"<opaque>"`, 1 autoref) caso contrário. A referência partilhada `&x` nunca
//! move o valor.
//!
//! # Degradação honesta
//!
//! 1. **Traço completo** (linhas + variáveis). Se não compilar (p.ex. um valor foi
//!    movido antes do ponto de captura), cai para…
//! 2. **Traço só-de-linhas** (marcadores de linha, sem variáveis — nunca referencia
//!    variáveis do aluno, logo compila sempre que o próprio programa compila). Se
//!    nem isso compilar, cai para…
//! 3. **Só execução**: corre o programa original e devolve `supported:true`,
//!    `steps` vazios e uma nota honesta (o `stdout` e os erros do compilador vão na
//!    nota). Nunca se inventam valores.

use anyhow::{Context, Result};
use proc_macro2::Span;
use quote::quote;
use serde::Deserialize;
use std::process::Command;
use std::time::Duration;

use crate::runner::{
    configure_cargo_env, configure_probe_env, run_guarded, scaffold_bin, RunOutput, CARGO_TIMEOUT,
    PROBE_LIMITS,
};
use crate::tracer::{ExecutionTrace, TraceStep, Var};

/// Marcador de linha de traço no stderr do programa instrumentado. Distingue as
/// nossas linhas JSON do stderr genuíno do aluno (`eprintln!`, panics, …).
const SENTINEL: &str = "@@DXTRACE@@";

/// Tecto de passos (igual em espírito ao `MAX_STEPS` do harness Python). Além
/// deste valor o programa pára de emitir e assinala truncagem.
const MAX_STEPS: usize = 5000;

/// Tempo de parede para correr o binário instrumentado (o traço torna-o mais lento
/// que a execução directa, por isso damos folga).
const TRACE_RUN_TIMEOUT: Duration = Duration::from_secs(15);

/// O runtime de traço injectado no topo do ficheiro do aluno. Tudo com prefixo
/// `__dxtutor_`/`__Dxtutor` para não colidir com identificadores do aluno.
const RUNTIME_PRELUDE: &str = r#"
#[allow(unused)]
use std::sync::atomic::{AtomicUsize, AtomicI32, Ordering as __DxtutorOrdering};

static __DXTUTOR_STEPS: AtomicUsize = AtomicUsize::new(0);
static __DXTUTOR_DEPTH: AtomicI32 = AtomicI32::new(0);
const __DXTUTOR_MAX_STEPS: usize = 5000;

struct __DxtutorDepthGuard;
impl __DxtutorDepthGuard {
    #[allow(unused)]
    fn enter() -> Self {
        __DXTUTOR_DEPTH.fetch_add(1, __DxtutorOrdering::Relaxed);
        __DxtutorDepthGuard
    }
}
impl Drop for __DxtutorDepthGuard {
    fn drop(&mut self) {
        __DXTUTOR_DEPTH.fetch_sub(1, __DxtutorOrdering::Relaxed);
    }
}

#[allow(unused)]
fn __dxtutor_depth() -> u32 {
    let d = __DXTUTOR_DEPTH.load(__DxtutorOrdering::Relaxed);
    if d > 1 { (d - 1) as u32 } else { 0 }
}

#[allow(unused)]
fn __dxtutor_tyname<T: ?Sized>(_: &T) -> &'static str { std::any::type_name::<T>() }

trait __DxtutorViaDebug { fn __dxtutor_dbg(&self) -> String; }
impl<T: std::fmt::Debug> __DxtutorViaDebug for T {
    fn __dxtutor_dbg(&self) -> String { __dxtutor_trunc(format!("{:?}", self)) }
}
trait __DxtutorViaFallback { fn __dxtutor_dbg(&self) -> String; }
impl<T> __DxtutorViaFallback for &T {
    fn __dxtutor_dbg(&self) -> String { String::from("<opaque>") }
}

#[allow(unused)]
fn __dxtutor_trunc(s: String) -> String {
    const MAX: usize = 200;
    if s.chars().count() > MAX {
        let head: String = s.chars().take(MAX).collect();
        format!("{}…", head)
    } else {
        s
    }
}

#[allow(unused)]
fn __dxtutor_json_escape(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
}

#[allow(unused)]
fn __dxtutor_step(line: u32, func: &str, vars: Vec<(&'static str, String, String)>) {
    use std::io::Write;
    let n = __DXTUTOR_STEPS.fetch_add(1, __DxtutorOrdering::Relaxed);
    if n == __DXTUTOR_MAX_STEPS {
        let _ = writeln!(std::io::stderr(), "@@DXTRACE@@{{\"trunc\":true}}");
        return;
    }
    if n > __DXTUTOR_MAX_STEPS { return; }
    let mut s = String::from("@@DXTRACE@@{\"line\":");
    s.push_str(&line.to_string());
    s.push_str(",\"func\":\"");
    __dxtutor_json_escape(func, &mut s);
    s.push_str("\",\"depth\":");
    s.push_str(&__dxtutor_depth().to_string());
    s.push_str(",\"vars\":[");
    for (i, (name, val, ty)) in vars.iter().enumerate() {
        if i > 0 { s.push(','); }
        s.push_str("{\"name\":\"");
        __dxtutor_json_escape(name, &mut s);
        s.push_str("\",\"value\":\"");
        __dxtutor_json_escape(val, &mut s);
        s.push_str("\",\"ty\":\"");
        __dxtutor_json_escape(ty, &mut s);
        s.push_str("\"}");
    }
    s.push_str("]}");
    let _ = writeln!(std::io::stderr(), "{}", s);
}
"#;

/// Modo de instrumentação.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Linhas + variáveis em scope (pode não compilar se houver movimentos).
    Full,
    /// Apenas marcadores de linha, sem referenciar variáveis do aluno.
    LinesOnly,
}

// ── API pública ──────────────────────────────────────────────────────────────

/// Traça a execução de um programa Rust **completo** (com `fn main`) por
/// instrumentação de código-fonte. Nunca devolve `Err` por o programa do aluno
/// falhar — degrada honestamente (ver cabeçalho do módulo).
pub fn trace_rust(code: &str) -> Result<ExecutionTrace> {
    let file = match syn::parse_file(code) {
        Ok(f) => f,
        Err(e) => {
            return Ok(run_only(
                code,
                format!(
                    "couldn't parse this Rust program for step-through tracing ({e}); showing the \
                     run only"
                ),
            ));
        }
    };

    // 1) Traço completo (linhas + variáveis).
    let full_src = build_instrumented(&file, Mode::Full);
    match compile_and_trace(&full_src)? {
        TraceOutcome::Traced(t) => return Ok(finish(t, None)),
        TraceOutcome::BuildFailed(_) => { /* cai para só-de-linhas */ }
    }

    // 2) Traço só-de-linhas (sem referenciar variáveis do aluno).
    let line_src = build_instrumented(&file, Mode::LinesOnly);
    match compile_and_trace(&line_src)? {
        TraceOutcome::Traced(t) => {
            return Ok(finish(
                t,
                Some(
                    "variable values weren't capturable for this program (e.g. a value was moved); \
                     showing line-by-line control flow only"
                        .to_string(),
                ),
            ));
        }
        TraceOutcome::BuildFailed(stderr) => {
            // 3) Nem as linhas compilam → corre o programa original tal e qual.
            return Ok(run_only(
                code,
                format!(
                    "couldn't instrument this program for step-through tracing; showing the run \
                     only.\n{}",
                    truncate(&stderr, 800)
                ),
            ));
        }
    }
}

// ── Construção do programa instrumentado ─────────────────────────────────────

/// Devolve o código-fonte do programa do aluno com o runtime de traço no topo e
/// cada função de topo (incluindo `main`) e método de `impl` de topo instrumentados.
fn build_instrumented(file: &syn::File, mode: Mode) -> String {
    let mut file = file.clone();

    // Os atributos internos (`#![...]`) do aluno têm de ficar no TOPO absoluto do
    // ficheiro — antes de QUALQUER item, incluindo os do nosso runtime. Removemo-los
    // do ficheiro (que vamos re-emitir depois do prelude) e re-escrevemo-los à cabeça.
    let student_inner = std::mem::take(&mut file.attrs);
    let mut inner_block = String::from(
        "#![allow(unused, unused_parens, unused_braces, unreachable_code, non_snake_case)]\n",
    );
    for attr in &student_inner {
        inner_block.push_str(&quote! { #attr }.to_string());
        inner_block.push('\n');
    }

    // Instrumenta apenas itens de topo: funções livres e métodos de `impl`s de
    // topo. Módulos aninhados ficam de fora (os traços de traço precisam dos
    // nossos traits em scope, e só o estão no módulo-raiz).
    for item in &mut file.items {
        match item {
            syn::Item::Fn(f) => {
                let func = f.sig.ident.to_string();
                let params = collect_params(&f.sig.inputs);
                instrument_fn_body(&mut f.block, &func, &params, mode);
            }
            syn::Item::Impl(imp) => {
                for ii in &mut imp.items {
                    if let syn::ImplItem::Fn(m) = ii {
                        let func = m.sig.ident.to_string();
                        let params = collect_params(&m.sig.inputs);
                        instrument_fn_body(&mut m.block, &func, &params, mode);
                    }
                }
            }
            _ => {}
        }
    }

    // Ordem final: atributos internos (topo absoluto) + runtime + programa
    // instrumentado (já sem os seus atributos internos, que foram hasteados).
    let body = quote! { #file }.to_string();
    format!("{inner_block}{RUNTIME_PRELUDE}\n{body}\n")
}

/// Nomes de parâmetros simples (ignora `self` e padrões destruturados).
fn collect_params(inputs: &syn::punctuated::Punctuated<syn::FnArg, syn::Token![,]>) -> Vec<syn::Ident> {
    let mut out = Vec::new();
    for arg in inputs {
        if let syn::FnArg::Typed(pt) = arg {
            if let syn::Pat::Ident(pi) = &*pt.pat {
                // Ignora `ref`/subpadrões; aceita só o binding simples (com ou sem `mut`).
                if pi.subpat.is_none() {
                    out.push(pi.ident.clone());
                }
            }
        }
    }
    out
}

/// Instrumenta o corpo de uma **função** (ou método): instrumenta o bloco e
/// prepende a guarda de profundidade, que vive durante toda a chamada.
fn instrument_fn_body(body: &mut syn::Block, func: &str, params: &[syn::Ident], mode: Mode) {
    instrument_block(body, func, params, mode);
    let guard: syn::Stmt = syn::parse_quote! {
        let __dxtutor_guard = __DxtutorDepthGuard::enter();
    };
    body.stmts.insert(0, guard);
}

/// Instrumenta um bloco: para cada instrução, recorre aos blocos aninhados e
/// injecta uma chamada de traço (antes de instruções divergentes/cauda, depois das
/// restantes). `outer_scope` são as variáveis visíveis à entrada do bloco.
fn instrument_block(block: &mut syn::Block, func: &str, outer_scope: &[syn::Ident], mode: Mode) {
    let mut scope: Vec<syn::Ident> = outer_scope.to_vec();
    let stmts = std::mem::take(&mut block.stmts);
    let n = stmts.len();
    let mut out: Vec<syn::Stmt> = Vec::with_capacity(n * 2 + 1);

    for (idx, mut stmt) in stmts.into_iter().enumerate() {
        let is_last = idx + 1 == n;
        let line = stmt_line(&stmt);

        // Instrumenta blocos aninhados dentro desta instrução.
        recurse_into_stmt(&mut stmt, func, &scope, mode);

        if is_divergent(&stmt) || (is_last && is_tail_expr(&stmt)) {
            // Traço ANTES (não quebra o valor de retorno nem gera código morto).
            if line > 0 {
                out.push(trace_stmt(line, func, &scope, mode));
            }
            out.push(stmt);
        } else {
            // Regista o novo binding (se for `let <ident> = …;`) e traça DEPOIS.
            let new_binding = local_binding(&stmt);
            out.push(stmt);
            if let Some(id) = new_binding {
                push_binding(&mut scope, id);
            }
            if line > 0 {
                out.push(trace_stmt(line, func, &scope, mode));
            }
        }
    }

    block.stmts = out;
}

/// Recorre aos blocos aninhados de uma instrução, instrumentando-os com o scope
/// corrente (acrescido das variáveis de ligação do `for`, quando simples).
fn recurse_into_stmt(stmt: &mut syn::Stmt, func: &str, scope: &[syn::Ident], mode: Mode) {
    match stmt {
        syn::Stmt::Local(local) => {
            if let Some(init) = &mut local.init {
                recurse_into_expr(&mut init.expr, func, scope, mode);
                if let Some((_, else_block)) = &mut init.diverge {
                    recurse_into_expr(else_block, func, scope, mode);
                }
            }
        }
        syn::Stmt::Expr(expr, _) => recurse_into_expr(expr, func, scope, mode),
        // Macros e itens aninhados: não instrumentamos o seu interior.
        syn::Stmt::Macro(_) | syn::Stmt::Item(_) => {}
    }
}

/// Instrumenta os blocos aninhados dentro de uma expressão (control-flow).
fn recurse_into_expr(expr: &mut syn::Expr, func: &str, scope: &[syn::Ident], mode: Mode) {
    match expr {
        syn::Expr::If(e) => {
            instrument_block(&mut e.then_branch, func, scope, mode);
            if let Some((_, else_expr)) = &mut e.else_branch {
                recurse_into_expr(else_expr, func, scope, mode);
            }
        }
        syn::Expr::ForLoop(e) => {
            let mut inner = scope.to_vec();
            if let syn::Pat::Ident(pi) = &*e.pat {
                if pi.subpat.is_none() {
                    push_binding(&mut inner, pi.ident.clone());
                }
            }
            instrument_block(&mut e.body, func, &inner, mode);
        }
        syn::Expr::While(e) => instrument_block(&mut e.body, func, scope, mode),
        syn::Expr::Loop(e) => instrument_block(&mut e.body, func, scope, mode),
        syn::Expr::Block(e) => instrument_block(&mut e.block, func, scope, mode),
        syn::Expr::Unsafe(e) => instrument_block(&mut e.block, func, scope, mode),
        syn::Expr::Match(e) => {
            for arm in &mut e.arms {
                recurse_into_expr(&mut arm.body, func, scope, mode);
            }
        }
        _ => {}
    }
}

/// Acrescenta (ou actualiza, por *shadowing*) uma ligação ao scope, sem duplicar
/// o nome.
fn push_binding(scope: &mut Vec<syn::Ident>, id: syn::Ident) {
    let name = id.to_string();
    scope.retain(|e| e != &name);
    scope.push(id);
}

/// O `Ident` ligado por um `let <ident> = …;` simples (com inicializador), ou `None`.
fn local_binding(stmt: &syn::Stmt) -> Option<syn::Ident> {
    if let syn::Stmt::Local(local) = stmt {
        if local.init.is_some() {
            if let syn::Pat::Ident(pi) = &local.pat {
                if pi.subpat.is_none() {
                    return Some(pi.ident.clone());
                }
            }
        }
    }
    None
}

/// Uma instrução cujo valor é o do bloco (expressão de cauda sem `;`).
fn is_tail_expr(stmt: &syn::Stmt) -> bool {
    matches!(stmt, syn::Stmt::Expr(_, None))
}

/// Uma instrução que desvia o fluxo (return/break/continue) — traçar DEPOIS seria
/// código morto.
fn is_divergent(stmt: &syn::Stmt) -> bool {
    if let syn::Stmt::Expr(expr, _) = stmt {
        matches!(
            expr,
            syn::Expr::Return(_) | syn::Expr::Break(_) | syn::Expr::Continue(_)
        )
    } else {
        false
    }
}

/// Linha original (base 1) da instrução, via `proc-macro2` com `span-locations`.
fn stmt_line(stmt: &syn::Stmt) -> u32 {
    use syn::spanned::Spanned;
    stmt.span().start().line as u32
}

/// Constrói a instrução de traço para uma linha. Em [`Mode::Full`] empurra o
/// valor (via autoref-specialization) e o tipo de cada variável em scope; em
/// [`Mode::LinesOnly`] emite só o marcador de linha.
fn trace_stmt(line: u32, func: &str, scope: &[syn::Ident], mode: Mode) -> syn::Stmt {
    let pushes: Vec<proc_macro2::TokenStream> = if mode == Mode::Full {
        scope
            .iter()
            .map(|id| {
                let name = id.to_string();
                quote! {
                    __dxtutor_vars.push((
                        #name,
                        (&#id).__dxtutor_dbg(),
                        __dxtutor_tyname(&#id).to_string(),
                    ));
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    let line_lit = proc_macro2::Literal::u32_unsuffixed(line);
    let func_lit = proc_macro2::Literal::string(func);
    let _ = Span::call_site();

    syn::parse_quote! {
        {
            let mut __dxtutor_vars: Vec<(&'static str, String, String)> = Vec::new();
            #(#pushes)*
            __dxtutor_step(#line_lit, #func_lit, __dxtutor_vars);
        };
    }
}

// ── Compilar + correr + ler o traço ──────────────────────────────────────────

/// O que resultou de compilar/correr uma variante instrumentada.
enum TraceOutcome {
    Traced(Traced),
    /// A instrumentação não compilou (stderr do compilador).
    BuildFailed(String),
}

struct Traced {
    steps: Vec<TraceStep>,
    stdout: String,
    truncated: bool,
    /// Nota adicional de execução (timeout, erro em runtime), se houver.
    runtime_note: Option<String>,
}

/// Compila o programa instrumentado e corre o binário no sandbox. Só devolve `Err`
/// se o próprio sandbox não arrancar; uma falha de compilação é
/// [`TraceOutcome::BuildFailed`].
fn compile_and_trace(src: &str) -> Result<TraceOutcome> {
    // Motor != Host ⇒ compila+corre o programa instrumentado no container
    // `rust:1-slim`, lendo o traço do stderr. Host mantém-se exacto.
    if crate::container::current_engine() != crate::container::SandboxEngine::Host {
        return compile_and_trace_container(src);
    }

    let dir = tempfile::Builder::new()
        .prefix("dxtutor-rtrace-")
        .tempdir()
        .context("criar directório temporário do traçado Rust")?;
    let root = dir.path();
    scaffold_bin(root, src)?;

    // 1) Compilar (sem correr).
    let mut build = Command::new("cargo");
    build.args(["build", "--quiet"]).current_dir(root);
    configure_cargo_env(&mut build);
    let b = run_guarded(build, root, "build", CARGO_TIMEOUT, None)
        .context("compilar o programa instrumentado")?;
    if b.timed_out {
        return Ok(TraceOutcome::BuildFailed(format!(
            "a compilação excedeu o tempo limite ({}s)",
            CARGO_TIMEOUT.as_secs()
        )));
    }
    if !b.status.map(|s| s.success()).unwrap_or(false) {
        return Ok(TraceOutcome::BuildFailed(b.stderr));
    }

    // 2) Correr o binário instrumentado, lendo o traço do stderr.
    let bin = root.join("target/debug/drill");
    let mut run = Command::new(&bin);
    run.current_dir(root);
    configure_probe_env(&mut run, root);
    let r = run_guarded(run, root, "rtrace", TRACE_RUN_TIMEOUT, Some(PROBE_LIMITS))
        .with_context(|| format!("correr o binário instrumentado em {}", bin.display()))?;

    let (steps, truncated) = parse_trace(&r.stderr);

    let mut runtime_note = None;
    if r.timed_out {
        runtime_note = Some(format!(
            "trace timed out after {}s and was terminated (possible infinite loop)",
            TRACE_RUN_TIMEOUT.as_secs()
        ));
    } else if !r.status.map(|s| s.success()).unwrap_or(false) {
        let tail = non_sentinel_tail(&r.stderr, 600);
        runtime_note = Some(if tail.is_empty() {
            "program exited with a non-zero status during the trace".to_string()
        } else {
            format!("program reported an error during the trace:\n{tail}")
        });
    }

    Ok(TraceOutcome::Traced(Traced {
        steps,
        stdout: r.stdout,
        truncated,
        runtime_note,
    }))
}

/// Caminho container do [`compile_and_trace`]: scaffolda o pacote `bin`, compila-o
/// no container `rust:1-slim` (com cache de cargo e rede) e, se compilar, corre o
/// binário instrumentado no mesmo `/work`, lendo o traço do stderr. Espelha o fluxo
/// host em duas invocações de container (build, depois run).
fn compile_and_trace_container(src: &str) -> Result<TraceOutcome> {
    use crate::container::{
        cache_volumes_for, image_for, run_in_container, ContainerSpec, RUST_CONTAINER_TIMEOUT,
    };

    let dir = tempfile::Builder::new()
        .prefix("dxtutor-rtrace-")
        .tempdir()
        .context("criar directório temporário do traçado Rust")?;
    let root = dir.path();
    scaffold_bin(root, src)?;

    let image = image_for("rust").expect("rust tem imagem conhecida");

    // 1) Compilar (sem correr) no container, com cache de cargo + rede.
    let mut build = ContainerSpec::new(
        image,
        root,
        vec!["cargo".into(), "build".into(), "--quiet".into()],
    );
    build.timeout = RUST_CONTAINER_TIMEOUT;
    build.cache_volumes = cache_volumes_for("rust");
    build.network = true;
    let b = run_in_container(build)?;
    if !b.ok {
        return Ok(TraceOutcome::BuildFailed(b.stderr));
    }

    // 2) Correr o binário instrumentado (sem rede); o traço sai no stderr.
    let mut run = ContainerSpec::new(
        image,
        root,
        vec!["./target/debug/drill".into()],
    );
    run.timeout = TRACE_RUN_TIMEOUT;
    let r = run_in_container(run)?;

    let (steps, truncated) = parse_trace(&r.stderr);
    let runtime_note = if !r.ok {
        let tail = non_sentinel_tail(&r.stderr, 600);
        Some(if tail.is_empty() {
            "program exited with a non-zero status during the trace".to_string()
        } else {
            format!("program reported an error during the trace:\n{tail}")
        })
    } else {
        None
    };

    Ok(TraceOutcome::Traced(Traced {
        steps,
        stdout: r.stdout,
        truncated,
        runtime_note,
    }))
}

/// Uma linha de traço, tal como o programa instrumentado a emite.
#[derive(Deserialize)]
struct RawStep {
    line: u32,
    func: String,
    depth: u32,
    vars: Vec<RawVar>,
}

#[derive(Deserialize)]
struct RawVar {
    name: String,
    value: String,
    ty: String,
}

/// Lê as linhas-sentinela do stderr e converte-as em [`TraceStep`]. Devolve também
/// se o traço foi truncado pelo tecto de passos.
fn parse_trace(stderr: &str) -> (Vec<TraceStep>, bool) {
    let mut steps = Vec::new();
    let mut truncated = false;
    for line in stderr.lines() {
        let Some(payload) = line.strip_prefix(SENTINEL) else {
            continue;
        };
        if payload.contains("\"trunc\":true") {
            truncated = true;
            continue;
        }
        let raw: RawStep = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => continue,
        };
        steps.push(TraceStep {
            line: raw.line,
            event: "line".to_string(),
            func: raw.func,
            depth: raw.depth,
            locals: raw
                .vars
                .into_iter()
                .map(|v| Var {
                    name: v.name,
                    value: v.value,
                    ty: v.ty,
                })
                .collect(),
            // Não interceptamos o stdout do aluno a meio da execução; honestamente 0.
            stdout_len: 0,
        });
    }
    (steps, truncated)
}

/// As últimas `max` bytes do stderr que NÃO são linhas-sentinela (o stderr real do
/// aluno: panics, `eprintln!`, …).
fn non_sentinel_tail(stderr: &str, max: usize) -> String {
    let real: Vec<&str> = stderr
        .lines()
        .filter(|l| !l.starts_with(SENTINEL))
        .collect();
    let joined = real.join("\n");
    let trimmed = joined.trim();
    truncate(trimmed, max)
}

/// Monta a [`ExecutionTrace`] final a partir de um traço, juntando notas honestas.
fn finish(t: Traced, degrade_note: Option<String>) -> ExecutionTrace {
    let mut notes = String::new();
    let mut push = |s: &str| {
        if !notes.is_empty() {
            notes.push('\n');
        }
        notes.push_str(s);
    };
    if let Some(n) = degrade_note {
        push(&n);
    }
    if t.truncated {
        push(&format!("trace truncated at {MAX_STEPS} steps"));
    }
    if let Some(n) = &t.runtime_note {
        push(n);
    }
    ExecutionTrace {
        supported: true,
        notes,
        steps: t.steps,
        stdout: t.stdout,
    }
}

/// Último recurso: corre o programa original (sem instrumentar) para mostrar ao
/// menos o `stdout` e os erros do compilador. `steps` fica vazio; nunca se inventa.
fn run_only(code: &str, note: String) -> ExecutionTrace {
    let mut notes = note;
    let stdout = match crate::runner::run_rust_snippet(code) {
        Ok(RunOutput { ok, stdout, stderr }) => {
            if !ok {
                if !notes.is_empty() {
                    notes.push('\n');
                }
                notes.push_str(&format!("compiler/run output:\n{}", truncate(&stderr, 1200)));
            }
            stdout
        }
        Err(e) => {
            if !notes.is_empty() {
                notes.push('\n');
            }
            notes.push_str(&format!("(could not run the program either: {e})"));
            String::new()
        }
    };
    ExecutionTrace {
        supported: true,
        notes,
        steps: Vec::new(),
        stdout,
    }
}

/// Trunca um texto a `max` bytes (em fronteira de char), com marca honesta.
fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… (truncated)", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Em [`Mode::LinesOnly`] a instrumentação não deve referenciar nenhuma variável
    /// do aluno (compila sempre que o programa compila).
    #[test]
    fn lines_only_nao_referencia_variaveis() {
        let file = syn::parse_file("fn main() { let x = 1; println!(\"{}\", x); }").unwrap();
        let src = build_instrumented(&file, Mode::LinesOnly);
        assert!(src.contains("__dxtutor_step"), "devia injectar passos");
        // O runtime (prelude) *define* `__dxtutor_dbg`, mas o modo só-de-linhas nunca
        // deve *chamar* `.__dxtutor_dbg()` sobre uma variável do aluno.
        assert!(
            !src.contains(".__dxtutor_dbg()"),
            "modo só-de-linhas não devia chamar o captador de valores"
        );
    }

    /// Em [`Mode::Full`] a instrumentação captura as variáveis em scope.
    #[test]
    fn full_captura_variaveis() {
        let file = syn::parse_file("fn main() { let total = 3; println!(\"{}\", total); }").unwrap();
        let src = build_instrumented(&file, Mode::Full);
        assert!(src.contains("__dxtutor_dbg"), "modo completo devia capturar valores");
        assert!(src.contains("\"total\""), "devia referir a variável total");
    }

    #[test]
    #[ignore = "compila e corre um cargo aninhado; lento"]
    fn trace_rust_let_e_loop() {
        // Um programa com um `let mut`, um ciclo que muda um inteiro, e um print.
        let code = "\
fn main() {
    let mut total = 0;
    for i in 1..=3 {
        total += i;
    }
    println!(\"total = {}\", total);
}
";
        let trace = trace_rust(code).expect("o traçado não devia devolver Err");
        assert!(trace.supported, "rust devia ser suportado");
        assert!(
            !trace.steps.is_empty(),
            "o traço não devia estar vazio; notas:\n{}",
            trace.notes
        );

        // Há um passo em que `total` vale 6 (1+2+3) — valor REAL observado.
        let viu_total_6 = trace.steps.iter().any(|s| {
            s.locals
                .iter()
                .any(|v| v.name == "total" && v.value == "6")
        });
        assert!(
            viu_total_6,
            "devia existir um passo com total=6; passos:\n{:#?}",
            trace
                .steps
                .iter()
                .map(|s| (s.line, s.func.clone(), s.locals.clone()))
                .collect::<Vec<_>>()
        );

        // O inteiro aparece a mudar (vários valores distintos de `total`).
        let valores: std::collections::BTreeSet<String> = trace
            .steps
            .iter()
            .flat_map(|s| s.locals.iter())
            .filter(|v| v.name == "total")
            .map(|v| v.value.clone())
            .collect();
        assert!(
            valores.len() >= 2,
            "`total` devia mudar de valor ao longo do traço; vistos: {valores:?}"
        );

        // O stdout real do programa.
        assert!(
            trace.stdout.contains("total = 6"),
            "stdout devia conter 'total = 6', obteve-se: {:?}",
            trace.stdout
        );
    }
}
