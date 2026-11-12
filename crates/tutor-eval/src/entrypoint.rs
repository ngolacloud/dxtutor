//! Entry-point insertion (prompt §3: "add the main entrypoint that works").
//!
//! Given a file's language and current content, decide whether it already has a runnable
//! entry point and, if not, propose the idiomatic snippet to append. Syntactic and
//! conservative: it never duplicates an existing entry. The caller inserts the snippet as a
//! localized edit (with review), then validates via the project's normal run command.

use serde::Serialize;

/// A proposal to add an entry point: the snippet to append, plus a human note.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntrypointProposal {
    /// Text to append at the end of the file (already includes a leading blank line).
    pub snippet: String,
    /// What it does / why.
    pub note: String,
}

/// Propose an entry point for `lang` given `code`, or `None` when one already exists.
/// Languages: `rust`, `go`, `python` (others return `None`).
pub fn propose_entrypoint(lang: &str, code: &str) -> Option<EntrypointProposal> {
    match lang {
        "rust" => (!has_rust_main(code)).then(|| EntrypointProposal {
            snippet: "\nfn main() {\n    // TODO: program entry point\n}\n".into(),
            note: "Added `fn main()` — the Rust binary entry point.".into(),
        }),
        "go" => (!has_go_main(code)).then(|| EntrypointProposal {
            snippet: "\nfunc main() {\n\t// TODO: program entry point\n}\n".into(),
            note: if has_go_package_main(code) {
                "Added `func main()` — the Go executable entry point.".into()
            } else {
                "Added `func main()`. NOTE: the file's `package` must be `main` for this to be \
                 an executable."
                    .into()
            },
        }),
        "python" => (!has_python_main_guard(code)).then(|| EntrypointProposal {
            // Call main() if the file defines one, else a direct body.
            snippet: if code.contains("def main(") {
                "\n\nif __name__ == \"__main__\":\n    main()\n".into()
            } else {
                "\n\nif __name__ == \"__main__\":\n    # TODO: program entry point\n    pass\n".into()
            },
            note: "Added the `if __name__ == \"__main__\":` run guard.".into(),
        }),
        _ => None,
    }
}

fn has_rust_main(code: &str) -> bool {
    code.lines().any(|l| {
        let t = l.trim_start();
        (t.starts_with("fn main(") || t.starts_with("pub fn main(") || t.starts_with("async fn main("))
            && !t.starts_with("//")
    })
}

fn has_go_main(code: &str) -> bool {
    code.lines().any(|l| l.trim_start().starts_with("func main("))
}

fn has_go_package_main(code: &str) -> bool {
    code.lines().any(|l| l.trim() == "package main")
}

fn has_python_main_guard(code: &str) -> bool {
    code.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with("if __name__") && t.contains("__main__")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_adds_main_only_when_missing() {
        assert!(propose_entrypoint("rust", "struct S;").unwrap().snippet.contains("fn main()"));
        assert!(propose_entrypoint("rust", "fn main() {}\n").is_none());
        assert!(propose_entrypoint("rust", "async fn main() {}").is_none());
        // A commented-out main does not count.
        assert!(propose_entrypoint("rust", "// fn main() {}").is_some());
    }

    #[test]
    fn go_main_and_package_note() {
        let p = propose_entrypoint("go", "package foo\n").unwrap();
        assert!(p.snippet.contains("func main()"));
        assert!(p.note.contains("package"), "warns about package main: {}", p.note);
        let ok = propose_entrypoint("go", "package main\n").unwrap();
        assert!(!ok.note.contains("NOTE"));
        assert!(propose_entrypoint("go", "package main\nfunc main() {}\n").is_none());
    }

    #[test]
    fn python_guard_calls_main_when_present() {
        assert!(propose_entrypoint("python", "x = 1\n").unwrap().snippet.contains("pass"));
        assert!(propose_entrypoint("python", "def main():\n    pass\n").unwrap().snippet.contains("main()"));
        assert!(propose_entrypoint("python", "if __name__ == '__main__':\n    pass\n").is_none());
    }

    #[test]
    fn other_languages_decline() {
        assert!(propose_entrypoint("java", "class X {}").is_none());
    }
}
