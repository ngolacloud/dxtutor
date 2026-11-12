//! Debug capability detection (section 5 — DAP).
//!
//! Honest by design: real step-through debugging (breakpoints, variable/stack inspection)
//! needs a Debug Adapter Protocol adapter on the host — `codelldb`, `lldb-dap`
//! (`lldb-vscode`) — backed by an `lldb`/`gdb` engine. When none is present, the IDE must
//! say so and fall back to the instrumentation tracer (Visualize), never pretend to have a
//! debugger. This module only *detects*; it starts nothing.

use std::path::PathBuf;

use serde::Serialize;

/// DAP adapters that speak the protocol a debugger UI drives.
const ADAPTERS: &[&str] = &["codelldb", "lldb-dap", "lldb-vscode"];
/// Underlying debug engines a DAP adapter needs (and bare wrappers like `rust-lldb`).
const ENGINES: &[&str] = &["lldb", "gdb"];

/// What the host can really do for debugging, surfaced to the Run-and-Debug view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCapability {
    /// True only when a usable DAP adapter is present — the one honest gate for offering
    /// real breakpoints.
    pub available: bool,
    /// The DAP adapter binary found, if any.
    pub adapter: Option<String>,
    /// The underlying debug engine found, if any (`lldb`/`gdb`).
    pub engine: Option<String>,
    /// A human-readable explanation of what is (or isn't) possible and the fallback.
    pub note: String,
}

/// Is `tool` an executable file on `PATH`? (A dependency-free `which`.)
fn on_path(tool: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(tool);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Detect the host's debug capability. Deterministic from `PATH`; never panics.
pub fn detect_debug_adapter() -> DebugCapability {
    let adapter = ADAPTERS.iter().find(|a| on_path(a).is_some()).map(|a| a.to_string());
    let engine = ENGINES.iter().find(|e| on_path(e).is_some()).map(|e| e.to_string());
    let available = adapter.is_some();

    let note = if let Some(a) = &adapter {
        format!("DAP debugging available via `{a}` — real breakpoints and variable/stack inspection.")
    } else if let Some(e) = &engine {
        format!(
            "A debug engine (`{e}`) is installed, but no DAP adapter (codelldb / lldb-dap) was \
             found — install one for step-debugging. Until then, step through with Visualize \
             (the instrumentation tracer)."
        )
    } else {
        "No DAP adapter or debug engine found. Step-through uses the instrumentation tracer \
         (Visualize); real breakpoints need lldb-dap/codelldb plus lldb or gdb."
            .to_string()
    };

    DebugCapability { available, adapter, engine, note }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_is_honest_and_total() {
        let cap = detect_debug_adapter();
        // The note always explains the situation (and never claims a debugger we lack).
        assert!(!cap.note.is_empty());
        // `available` is true only when an adapter was actually found.
        assert_eq!(cap.available, cap.adapter.is_some());
        // When unavailable, the note must point at the honest fallback.
        if !cap.available {
            assert!(
                cap.note.contains("Visualize") || cap.note.contains("tracer"),
                "note must name the fallback: {}",
                cap.note
            );
        }
    }

    #[test]
    fn on_path_finds_a_known_binary() {
        // `sh` is on PATH on any POSIX host the tests run on.
        assert!(on_path("sh").is_some());
        assert!(on_path("definitely-not-a-real-binary-xyz").is_none());
    }
}
