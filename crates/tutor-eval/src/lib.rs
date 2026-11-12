//! `tutor-eval` — o avaliador do dxtutor.
//!
//! Duas responsabilidades, bem separadas e **honestas**:
//!
//! 1. **Correcção** (fonte da verdade): corre os testes da fase na linguagem dela.
//! 2. **Complexidade** (dica empírica): cronometra a solução do aluno em tamanhos
//!    crescentes e ajusta a classe — declarada sempre como estimativa, nunca prova.
//!
//! # Multi-linguagem
//!
//! O contrato está no trait [`LanguageRunner`] (ver [`lang`]): cada linguagem serve
//! `check_correctness`, `probe_complexity` e `diagnostics` à sua maneira. [`assess`]
//! despacha pela [`tutor_core::Phase::language`] — `"rust"` usa o [`runner::RustRunner`]
//! (compila e corre um pacote cargo isolado, com sandbox); `"js"` usa o
//! [`js_runner::JsRunner`] (motor QuickJS embebido). A API pública ([`assess`],
//! [`Assessment`], [`Correctness`]) mantém-se estável — acrescentar uma linguagem é
//! aditivo.

pub mod advisor;
pub mod codemap;
pub mod complexity;
pub mod container;
pub mod dap;
pub mod entrypoint;
pub mod git;
pub mod go_runner;
pub mod lsp;
pub mod js_runner;
pub mod lang;
pub mod measured;
pub mod plugin;
pub mod review;
pub mod runner;
pub mod search;
pub mod testnav;
pub mod textdiff;
pub mod rust_tracer;
pub mod tracer;

pub use advisor::advise;
pub use complexity::{Class, Confidence, Estimate, Sample};
pub use container::{
    build_image, cache_volumes_for, current_engine, engine_available, engine_name, image_for,
    session_down, session_exec, session_name, session_running, session_shell_command, session_up, parse_engine,
    run_in_container, run_python_in_sandbox, run_rust_snippet_in_container,
    run_rust_snippet_in_container_deps, sandbox_engine, set_engine, ContainerSpec, SandboxEngine,
};
pub use go_runner::{run_go_program, run_go_program_with_deps};
pub use lang::{assess, diagnostics, diagnostics_for, Diagnostic, LanguageRunner, Severity};
pub use measured::{compile_pipeline, run_rust_snippet_measured, MemSample, Pipeline, Telemetry};
pub use plugin::{
    available_languages, builtin_plugins, find_plugin, registry, LanguageInfo, LanguagePlugin,
    PluginRunner,
};
pub use runner::{run_rust_snippet, run_rust_snippet_with_deps, Assessment, Correctness, RunOutput};
pub use tracer::{trace_execution, trace_python, ExecutionTrace, TraceStep, Var};
