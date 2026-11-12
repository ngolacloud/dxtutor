//! Declarative **language plugins** — adding a language without writing Rust.
//!
//! # Why
//!
//! Until now each language was a hand-written [`LanguageRunner`]: [`crate::runner::RustRunner`],
//! [`crate::go_runner::GoRunner`], [`crate::js_runner::JsRunner`]. Adding a language meant
//! writing a Rust type and wiring a branch in [`crate::lang`]. That is a high bar for the
//! community: a teacher who wants to add C, Zig, Ruby or Kotlin should not have to compile the
//! tutor.
//!
//! This module turns a language into **data**: a [`LanguagePlugin`] descriptor (serde-deserialized
//! from TOML) says what image to use, what files to scaffold and which shell command templates run
//! the program, the tests and the diagnostics. A single generic [`PluginRunner`] interprets that
//! descriptor and implements [`LanguageRunner`] for it — reusing the exact same host/container
//! hardening the native runners use ([`crate::runner::run_guarded`] on the host,
//! [`crate::container::run_in_container`] in a sandbox).
//!
//! # The descriptor format
//!
//! A plugin is a TOML file. Minimal C example:
//!
//! ```toml
//! id = "c"
//! aliases = ["clang", "gcc"]
//! display_name = "C"
//! monaco_id = "c"
//! extensions = ["c", "h"]
//! image = "gcc:13"              # container image (used when the engine is not Host)
//! host_bin = "cc"              # host binary to probe for availability (optional)
//! network = false              # give the container network (for package managers)
//!
//! # File scaffolding. The student's code goes into `code_file`; the phase's tests go
//! # into `test_file` (optional), each optionally prefixed with a prelude.
//! code_file = "student.c"
//! test_file = "student_test.c"
//! code_prelude = ""
//! test_prelude = "#include \"student.c\"\n"   # the test translation unit pulls the student in
//!
//! # Command templates. Run as `sh -c "<script>"`, with the work dir as cwd. Placeholders:
//! #   {dir}  → the work directory ("." — cwd is already the work dir)
//! #   {file} → the code file name          {test_file} → the test file name
//! #   {entry}→ the phase entry-point name (the function the student must implement)
//! run_cmd  = "cc -O2 {file} -o prog && ./prog"          # run a COMPLETE program (drill)
//! test_cmd = "cc -O2 {test_file} -o testbin && ./testbin"  # CORRECTNESS: exit 0 == passed
//! diag_cmd = "cc -fsyntax-only {file}"                   # DIAGNOSTICS: file:line:col: sev: msg
//!
//! # Optional: persistent package caches (mounted only in the container path).
//! # [[cache_volumes]]
//! # name = "dxtutor-npm"
//! # target = "/root/.npm"
//! ```
//!
//! # The correctness protocol
//!
//! Deliberately simple and honest: **exit code 0 ⇒ passed**. `test_cmd` compiles the student code
//! together with the phase tests and runs them; a failing assertion must make the test binary exit
//! non-zero. No bespoke harness, no heuristic — the language's own tooling is the source of truth,
//! exactly like the native runners. The human-readable summary is derived from the exit code and a
//! light scan for a compile error (`error:` in the output).
//!
//! # Diagnostics
//!
//! `diag_cmd` compiles the student code alone; each `file:line:col: severity: message` line
//! (the GCC/Clang family's format) becomes a positional [`Diagnostic`].
//!
//! # Complexity probing
//!
//! Optional and **off by default** for plugins: a generic empirical complexity probe would need a
//! language-specific timing harness, which the native runners hand-write. A plugin therefore
//! reports no samples (so the estimate is simply absent) rather than faking one — keeping the
//! honesty principle. Native languages that want probing keep their dedicated runner.
//!
//! # Registry
//!
//! [`registry`] returns the built-in descriptors ([`builtin_plugins`]) plus any `*.toml` dropped in
//! the user plugin directory (`$XDG_CONFIG_HOME/dxtutor/plugins/` or `~/.config/dxtutor/plugins/`).
//! User plugins are searched first, so a drop-in can override a built-in id. [`find_plugin`] matches
//! a language string against each descriptor's `id`, `aliases` or `extensions`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;
use tutor_core::Phase;

use crate::complexity::Sample;
use crate::container::{current_engine, run_in_container, ContainerSpec, SandboxEngine};
use crate::lang::{Diagnostic, LanguageRunner, Severity};
use crate::runner::{run_guarded, RunOutput};

/// A persistent package cache mounted in the container path — `(name, /target)`.
#[derive(Debug, Clone, Deserialize)]
pub struct CacheVolume {
    pub name: String,
    pub target: String,
}

fn default_timeout_secs() -> u64 {
    60
}

/// A declarative language descriptor. Deserialized from a TOML plugin file; see the module header
/// for the full format and an example.
#[derive(Debug, Clone, Deserialize)]
pub struct LanguagePlugin {
    /// Canonical id (e.g. `"c"`). Primary match key for [`find_plugin`].
    pub id: String,
    /// Alternative names that also select this plugin (e.g. `["clang", "gcc"]`).
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Human-facing name for the UI (e.g. `"C"`).
    pub display_name: String,
    /// Monaco editor language id for syntax highlighting (e.g. `"c"`).
    #[serde(default)]
    pub monaco_id: String,
    /// File extensions handled (also usable as match keys), without the dot.
    #[serde(default)]
    pub extensions: Vec<String>,
    /// Container image used when the engine is not Host (e.g. `"gcc:13"`).
    pub image: String,
    /// Host binary probed for availability on the host path (e.g. `"cc"`). Optional.
    #[serde(default)]
    pub host_bin: Option<String>,
    /// Give the container network access (needed for package managers). Default `false`.
    #[serde(default)]
    pub network: bool,
    /// Persistent package caches (container path only).
    #[serde(default)]
    pub cache_volumes: Vec<CacheVolume>,

    /// File name the student's code is written to (e.g. `"student.c"`).
    pub code_file: String,
    /// File name the phase tests are written to (e.g. `"student_test.c"`). Optional: languages whose
    /// `test_cmd` embeds the tests differently may omit it.
    #[serde(default)]
    pub test_file: Option<String>,
    /// Text prepended to the student's code when scaffolding (imports, headers…).
    #[serde(default)]
    pub code_prelude: String,
    /// Text prepended to the phase tests when scaffolding (e.g. `#include "student.c"`).
    #[serde(default)]
    pub test_prelude: String,

    /// Shell script template to run a **complete** program (drill). See placeholders above.
    pub run_cmd: String,
    /// Shell script template to run the **tests** (correctness). Exit 0 ⇒ passed.
    pub test_cmd: String,
    /// Shell script template to produce **diagnostics**. Optional. `file:line:col: sev: msg`.
    #[serde(default)]
    pub diag_cmd: Option<String>,

    /// Wall-clock timeout (seconds) on the host path.
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    /// Wall-clock timeout (seconds) in the container path. Defaults to `4 ×` the host timeout (the
    /// first container run may pull images / warm caches). Optional.
    #[serde(default)]
    pub container_timeout_secs: Option<u64>,
}

impl LanguagePlugin {
    /// `true` if `language` (case-insensitive) matches this plugin's id, an alias or an extension.
    pub fn matches(&self, language: &str) -> bool {
        let want = language.trim().to_ascii_lowercase();
        if self.id.eq_ignore_ascii_case(&want) {
            return true;
        }
        if self.aliases.iter().any(|a| a.eq_ignore_ascii_case(&want)) {
            return true;
        }
        self.extensions.iter().any(|e| e.eq_ignore_ascii_case(&want))
    }

    /// The effective host timeout.
    fn host_timeout(&self) -> Duration {
        Duration::from_secs(self.timeout_secs.max(1))
    }

    /// The effective container timeout (explicit, or `4 ×` the host timeout).
    fn container_timeout(&self) -> Duration {
        let secs = self
            .container_timeout_secs
            .unwrap_or_else(|| self.timeout_secs.saturating_mul(4).max(1));
        Duration::from_secs(secs.max(1))
    }

    /// `true` if this plugin can run on the host right now — i.e. `host_bin` is resolvable on the
    /// `PATH` (or no `host_bin` was declared). Used by gated tests.
    pub fn host_available(&self) -> bool {
        match &self.host_bin {
            None => true,
            Some(bin) => bin_on_path(bin),
        }
    }
}

/// Lightweight, UI-facing view of a registered language (for a future language picker).
#[derive(Debug, Clone)]
pub struct LanguageInfo {
    pub id: String,
    pub display_name: String,
    pub monaco_id: String,
    pub extensions: Vec<String>,
    /// `true` for a built-in descriptor, `false` for one loaded from the plugin directory.
    pub builtin: bool,
}

// ── Template expansion ───────────────────────────────────────────────────────────

/// Expand a command template's `{dir}`/`{file}`/`{test_file}`/`{entry}` placeholders. The work dir
/// is the process cwd in both host and container, so `{dir}` is `"."` and the file placeholders are
/// plain relative names — identical on both paths.
fn expand(template: &str, plugin: &LanguagePlugin, entry: &str) -> String {
    template
        .replace("{dir}", ".")
        .replace("{file}", &plugin.code_file)
        .replace("{test_file}", plugin.test_file.as_deref().unwrap_or(""))
        .replace("{entry}", entry)
}

// ── The generic runner ───────────────────────────────────────────────────────────

/// A [`LanguageRunner`] driven entirely by a [`LanguagePlugin`] descriptor.
#[derive(Debug, Clone)]
pub struct PluginRunner {
    plugin: LanguagePlugin,
}

impl PluginRunner {
    pub fn new(plugin: LanguagePlugin) -> Self {
        PluginRunner { plugin }
    }

    /// The descriptor this runner serves.
    pub fn plugin(&self) -> &LanguagePlugin {
        &self.plugin
    }

    /// Scaffold the student code (and, if `tests` is given and the plugin declares a `test_file`,
    /// the phase tests) into a fresh temp dir. Returns the dir handle (kept alive by the caller).
    fn scaffold(&self, code: &str, tests: Option<&str>) -> Result<tempfile::TempDir> {
        let dir = tempfile::Builder::new()
            .prefix("dxtutor-plugin-")
            .tempdir()
            .context("create plugin work dir")?;
        let root = dir.path();
        let code_body = format!("{}{}", self.plugin.code_prelude, code);
        std::fs::write(root.join(&self.plugin.code_file), code_body)
            .with_context(|| format!("write {}", self.plugin.code_file))?;
        if let (Some(tests), Some(test_file)) = (tests, self.plugin.test_file.as_deref()) {
            let test_body = format!("{}{}", self.plugin.test_prelude, tests);
            std::fs::write(root.join(test_file), test_body)
                .with_context(|| format!("write {test_file}"))?;
        }
        Ok(dir)
    }

    /// Run a shell `script` in `dir`, host or container depending on [`current_engine`].
    fn run_script(&self, dir: &Path, script: &str) -> Result<RunOutput> {
        match current_engine() {
            SandboxEngine::Host => self.run_host(dir, script),
            _ => self.run_container(dir, script),
        }
    }

    /// Host path: `sh -c "<script>"` with a minimal environment, own process group and a wall-clock
    /// timeout — the same cheap hardening the native runners use for toolchain invocations.
    fn run_host(&self, dir: &Path, script: &str) -> Result<RunOutput> {
        use std::process::Command;
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script).current_dir(dir);
        cmd.env_clear();
        cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin");
        cmd.env("HOME", dir);
        cmd.env("LANG", "C");
        let timeout = self.plugin.host_timeout();
        let outcome = run_guarded(cmd, dir, "plugin", timeout, None)
            .with_context(|| format!("run plugin `{}` command on host", self.plugin.id))?;
        if outcome.timed_out {
            return Ok(RunOutput {
                ok: false,
                stdout: outcome.stdout,
                stderr: format!("exceeded wall-clock timeout ({}s)", timeout.as_secs()),
            });
        }
        let ok = outcome.status.map(|s| s.success()).unwrap_or(false);
        Ok(RunOutput {
            ok,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
        })
    }

    /// Container path: `sh -c "<script>"` inside the plugin image, mounting `dir` at `/work`, with
    /// the plugin's cache volumes and network setting.
    fn run_container(&self, dir: &Path, script: &str) -> Result<RunOutput> {
        let mut spec = ContainerSpec::new(
            self.plugin.image.clone(),
            dir,
            vec!["sh".into(), "-c".into(), script.into()],
        );
        spec.timeout = self.plugin.container_timeout();
        spec.network = self.plugin.network;
        spec.cache_volumes = self
            .plugin
            .cache_volumes
            .iter()
            .map(|c| (c.name.clone(), c.target.clone()))
            .collect();
        run_in_container(spec)
    }

    /// Run a **complete** program (with its own entry point) and return its output — the drill path,
    /// analogous to [`crate::runner::run_rust_snippet`] / [`crate::go_runner::run_go_program`].
    pub fn run_program(&self, code: &str) -> Result<RunOutput> {
        let dir = self.scaffold(code, None)?;
        let script = expand(&self.plugin.run_cmd, &self.plugin, "");
        self.run_script(dir.path(), &script)
    }
}

impl LanguageRunner for PluginRunner {
    /// Correctness = run `test_cmd` over the student code + phase tests. **Exit 0 ⇒ passed.**
    fn check_correctness(&self, phase: &Phase, student_code: &str) -> Result<crate::Correctness> {
        let dir = self.scaffold(student_code, Some(&phase.tests))?;
        let script = expand(&self.plugin.test_cmd, &self.plugin, &phase.entry);
        let out = self
            .run_script(dir.path(), &script)
            .with_context(|| format!("run plugin `{}` tests", self.plugin.id))?;

        let mut raw = String::new();
        raw.push_str(&out.stdout);
        raw.push_str(&out.stderr);
        let summary = summarize(&raw, out.ok);
        Ok(crate::Correctness {
            passed: out.ok,
            summary,
            raw,
        })
    }

    /// Complexity probing is not provided for declarative plugins (see the module header): we return
    /// no samples rather than fabricate an estimate.
    fn probe_complexity(&self, _phase: &Phase, _student_code: &str) -> Result<Vec<Sample>> {
        Ok(Vec::new())
    }

    /// Diagnostics = run `diag_cmd` over the student code alone and parse `file:line:col: sev: msg`.
    /// No `diag_cmd` ⇒ no diagnostics.
    fn diagnostics(&self, student_code: &str) -> Result<Vec<Diagnostic>> {
        let diag_cmd = match &self.plugin.diag_cmd {
            Some(c) => c,
            None => return Ok(Vec::new()),
        };
        let dir = self.scaffold(student_code, None)?;
        let script = expand(diag_cmd, &self.plugin, "");
        let out = self
            .run_script(dir.path(), &script)
            .with_context(|| format!("run plugin `{}` diagnostics", self.plugin.id))?;
        let mut diags = parse_cc_diagnostics(&out.stderr);
        diags.extend(parse_cc_diagnostics(&out.stdout));
        Ok(diags)
    }
}

// ── Output interpretation ─────────────────────────────────────────────────────────

/// Human-readable summary from the exit result and a light scan for a compile error.
fn summarize(raw: &str, passed: bool) -> String {
    if passed {
        return "testes passaram".to_string();
    }
    if raw.contains("error:") || raw.contains("error[") {
        return "não compilou (erro de compilação)".to_string();
    }
    "testes falharam".to_string()
}

/// Parse `path:line:col: severity: message` lines (the GCC/Clang family's format). Lines without
/// that shape are ignored. `error`/`fatal error` ⇒ [`Severity::Error`]; `warning` ⇒
/// [`Severity::Warning`]; notes are skipped.
fn parse_cc_diagnostics(text: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        // Need at least "f:L:C: sev: msg" → four ':' separators before the message.
        let mut it = line.splitn(5, ':');
        let (_file, l, c, sev, msg) = match (it.next(), it.next(), it.next(), it.next(), it.next()) {
            (Some(f), Some(l), Some(c), Some(s), Some(m)) if !f.is_empty() => (f, l, c, s, m),
            _ => continue,
        };
        let line_no = match l.trim().parse::<u32>() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let col_no = c.trim().parse::<u32>().unwrap_or(0);
        let severity = match sev.trim() {
            "error" | "fatal error" => Severity::Error,
            "warning" => Severity::Warning,
            _ => continue,
        };
        let message = msg.trim().to_string();
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

// ── Registry ───────────────────────────────────────────────────────────────────────

/// The built-in **C** descriptor, embedded as TOML so the declarative path is exercised even for
/// the shipped plugins. C needs only a host C compiler (`cc`), which virtually every machine has.
const BUILTIN_C_TOML: &str = r##"
id = "c"
aliases = ["clang", "gcc"]
display_name = "C"
monaco_id = "c"
extensions = ["c", "h"]
image = "gcc:13"
host_bin = "cc"
network = false

code_file = "student.c"
test_file = "student_test.c"
test_prelude = "#include \"student.c\"\n"

run_cmd  = "cc -O2 -std=c11 {file} -o prog && ./prog"
test_cmd = "cc -O2 -std=c11 {test_file} -o testbin && ./testbin"
diag_cmd = "cc -std=c11 -fsyntax-only {file}"

timeout_secs = 30
"##;

/// Parse and return the built-in descriptors. Panics only on a programmer error (a malformed
/// embedded TOML), which a unit test guards against.
pub fn builtin_plugins() -> Vec<LanguagePlugin> {
    let mut out = Vec::new();
    match toml::from_str::<LanguagePlugin>(BUILTIN_C_TOML) {
        Ok(p) => out.push(p),
        Err(e) => {
            // Never crash the evaluator over a built-in; a test catches this in CI.
            eprintln!("[dxtutor] built-in C plugin failed to parse: {e}");
        }
    }
    out
}

/// The user plugin directory: `$XDG_CONFIG_HOME/dxtutor/plugins/` if set, else
/// `~/.config/dxtutor/plugins/`. `None` if neither base is resolvable.
pub fn plugin_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Some(PathBuf::from(xdg).join("dxtutor/plugins"));
        }
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config/dxtutor/plugins"))
}

/// Load every `*.toml` descriptor in `dir`. Unreadable or malformed files are skipped with a note
/// on stderr — one bad drop-in never breaks the registry.
pub fn load_plugin_dir(dir: &Path) -> Vec<LanguagePlugin> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out, // absent dir is the normal case
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("toml") {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(text) => match toml::from_str::<LanguagePlugin>(&text) {
                Ok(p) => out.push(p),
                Err(e) => eprintln!("[dxtutor] skipping plugin {}: {e}", path.display()),
            },
            Err(e) => eprintln!("[dxtutor] cannot read plugin {}: {e}", path.display()),
        }
    }
    out
}

/// The full registry: user plugins first (so a drop-in can override a built-in id), then the
/// built-ins. Computed once and cached.
pub fn registry() -> &'static [LanguagePlugin] {
    static REGISTRY: OnceLock<Vec<LanguagePlugin>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut plugins = Vec::new();
        if let Some(dir) = plugin_dir() {
            plugins.extend(load_plugin_dir(&dir));
        }
        plugins.extend(builtin_plugins());
        plugins
    })
}

/// Find a registered plugin matching `language` by id, alias or extension. User plugins win over
/// built-ins (registry order).
pub fn find_plugin(language: &str) -> Option<LanguagePlugin> {
    registry().iter().find(|p| p.matches(language)).cloned()
}

/// All registered languages, for a future frontend picker. Built-ins are flagged via the count of
/// user plugins loaded first.
pub fn available_languages() -> Vec<LanguageInfo> {
    let user_count = plugin_dir().map(|d| load_plugin_dir(&d).len()).unwrap_or(0);
    registry()
        .iter()
        .enumerate()
        .map(|(i, p)| LanguageInfo {
            id: p.id.clone(),
            display_name: p.display_name.clone(),
            monaco_id: p.monaco_id.clone(),
            extensions: p.extensions.clone(),
            builtin: i >= user_count,
        })
        .collect()
}

/// `true` if `bin` resolves on the `PATH` (absolute path tested directly).
fn bin_on_path(bin: &str) -> bool {
    let p = Path::new(bin);
    if p.is_absolute() {
        return p.is_file();
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

#[cfg(test)]
mod tests {
    use super::*;
    use tutor_core::{Gabarito, Level};

    /// Build a minimal C phase for the gated proof below.
    fn c_add_phase() -> Phase {
        Phase {
            id: "c-add".into(),
            title: "Soma em C".into(),
            level: Level::Basico,
            language: "c".into(),
            instructions: "Implementa `int add(int a, int b)`.".into(),
            entry: "add".into(),
            starter: "int add(int a, int b) { return 0; }".into(),
            // Correctness test: a C `main` that asserts; non-zero exit on failure.
            tests: "#include <assert.h>\nint main(void){ assert(add(2,3)==5); assert(add(-1,1)==0); return 0; }\n".into(),
            gabarito: Gabarito {
                solution: "int add(int a, int b) { return a + b; }".into(),
                time: "O(1)".into(),
                space: "O(1)".into(),
                justification: "Soma aritmética directa.".into(),
            },
            probe: None,
            hints: Vec::new(),
            dependencies: Vec::new(),
        }
    }

    #[test]
    fn builtin_c_plugin_parses() {
        let plugins = builtin_plugins();
        assert_eq!(plugins.len(), 1, "exactly the C built-in");
        let c = &plugins[0];
        assert_eq!(c.id, "c");
        assert!(c.matches("C"));
        assert!(c.matches("gcc"));
        assert!(c.matches("h"), "extension should match");
        assert_eq!(c.test_file.as_deref(), Some("student_test.c"));
        assert!(c.run_cmd.contains("{file}"));
    }

    #[test]
    fn registry_exposes_c() {
        assert!(find_plugin("c").is_some());
        assert!(find_plugin("clang").is_some());
        assert!(
            find_plugin("brainfuck").is_none(),
            "unknown language has no plugin"
        );
        let langs = available_languages();
        assert!(langs.iter().any(|l| l.id == "c" && l.display_name == "C"));
    }

    #[test]
    fn load_plugin_dir_reads_dropins_and_skips_junk() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A valid drop-in descriptor for a new language (Python), minus any Rust.
        std::fs::write(
            dir.path().join("python.toml"),
            "id = \"python\"\n\
             aliases = [\"py\", \"python3\"]\n\
             display_name = \"Python\"\n\
             monaco_id = \"python\"\n\
             extensions = [\"py\"]\n\
             image = \"python:3.12-slim\"\n\
             host_bin = \"python3\"\n\
             code_file = \"student.py\"\n\
             run_cmd = \"python3 {file}\"\n\
             test_cmd = \"python3 {file}\"\n",
        )
        .unwrap();
        // A malformed file (missing required keys) must be skipped, not fatal.
        std::fs::write(dir.path().join("broken.toml"), "id = \"x\"\n").unwrap();
        // A non-TOML file is ignored.
        std::fs::write(dir.path().join("notes.txt"), "ignore me").unwrap();

        let loaded = load_plugin_dir(dir.path());
        assert_eq!(loaded.len(), 1, "only the valid drop-in loads: {loaded:?}");
        let py = &loaded[0];
        assert_eq!(py.id, "python");
        assert!(py.matches("py"), "alias matches");
        assert!(py.matches("python3"));
        assert_eq!(py.code_file, "student.py");
    }

    #[test]
    fn expand_fills_placeholders() {
        let c = &builtin_plugins()[0];
        let s = expand("run {file} test {test_file} entry {entry} dir {dir}", c, "add");
        assert_eq!(s, "run student.c test student_test.c entry add dir .");
    }

    #[test]
    fn parse_cc_diagnostics_reads_gcc_format() {
        let text = "student.c:3:10: error: 'x' undeclared (first use in this function)\n\
                    student.c:5:2: warning: unused variable 'y' [-Wunused-variable]\n\
                    student.c:5:2: note: each undeclared identifier is reported only once\n";
        let diags = parse_cc_diagnostics(text);
        assert_eq!(diags.len(), 2, "error + warning, note skipped: {diags:?}");
        assert_eq!(diags[0].line, 3);
        assert_eq!(diags[0].col, 10);
        assert_eq!(diags[0].severity, Severity::Error);
        assert!(diags[0].message.contains("undeclared"));
        assert_eq!(diags[1].severity, Severity::Warning);
    }

    /// End-to-end proof that a brand-new language — **C** — works purely through the declarative
    /// plugin, with no Rust runner of its own. **Gate**: Host engine + a host C compiler (`cc`).
    /// Run with:
    ///
    /// ```text
    /// cargo test -p tutor-eval plugin::tests::c_via_plugin_runs_and_tests -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "requires a host C compiler (cc) on PATH"]
    fn c_via_plugin_runs_and_tests() {
        let plugin = find_plugin("c").expect("C plugin is registered");
        if current_engine() != SandboxEngine::Host {
            eprintln!("skip: engine != Host");
            return;
        }
        let runner = PluginRunner::new(plugin.clone());
        if !plugin.host_available() {
            eprintln!("skip: no host C compiler (cc) on PATH");
            return;
        }

        // 1) A complete program runs via run_cmd.
        let out = runner
            .run_program("#include <stdio.h>\nint main(void){ printf(\"ola do C\\n\"); return 0; }\n")
            .expect("running a complete C program should not fail the sandbox");
        assert!(out.ok, "C program should compile and run; stderr:\n{}", out.stderr);
        assert!(
            out.stdout.contains("ola do C"),
            "stdout should contain the printed line, got:\n{}",
            out.stdout
        );

        // 2) Correctness (exit 0 == passed) via test_cmd: the right solution passes.
        let phase = c_add_phase();
        let good = runner
            .check_correctness(&phase, "int add(int a, int b) { return a + b; }")
            .expect("correctness run should not fail the sandbox");
        assert!(good.passed, "correct solution should pass; raw:\n{}", good.raw);

        // 3) …and a wrong solution fails.
        let bad = runner
            .check_correctness(&phase, "int add(int a, int b) { return a - b; }")
            .expect("correctness run should not fail the sandbox");
        assert!(!bad.passed, "wrong solution must fail");

        // 4) Diagnostics parse a real compile error.
        let diags = runner
            .diagnostics("int add(int a, int b) { return a + ; }")
            .expect("diagnostics run should not fail the sandbox");
        assert!(
            diags.iter().any(|d| d.severity == Severity::Error),
            "a syntax error should yield an error diagnostic, got: {diags:?}"
        );
    }
}
