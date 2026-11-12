//! CodeMap engine (P3) — symbol navigation over a real project.
//!
//! Given a symbol name, it answers: where is it **defined**, where is it
//! **referenced**, and which functions **call** it. This first slice covers Rust
//! using `syn` (already a dependency) — a purely **syntactic** analysis, so every
//! relation is honestly labelled `Inferred`. A later slice drives `rust-analyzer`
//! for `Resolved` relations (and flags unresolved dynamic calls); the model below
//! already carries the `Resolution` tag so the UI can distinguish the two.
//!
//! Inferred means: definitions come from the AST (reliable), while references and
//! callers are matched by identifier name across the crate. Name matching cannot
//! tell two same-named items apart — that is exactly what `rust-analyzer` will fix.

use std::path::Path;

use anyhow::Result;
use proc_macro2::TokenTree;
use serde::Serialize;
use syn::spanned::Spanned;

/// How a relation was established.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Resolution {
    /// Proven by a semantic engine (rust-analyzer/gopls). Not yet in this slice.
    Resolved,
    /// Matched syntactically by name — reliable for definitions, best-effort for refs.
    Inferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SymbolKind {
    Function,
    Method,
    Struct,
    Enum,
    Trait,
    Other,
}

/// A located symbol occurrence (definition, reference, or the anchor of a caller).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolRef {
    pub name: String,
    pub kind: SymbolKind,
    pub file: String,
    pub line: u32,
    pub col: u32,
}

/// The relations of one symbol across the project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relations {
    pub symbol: String,
    pub resolution: Resolution,
    pub definitions: Vec<SymbolRef>,
    pub references: Vec<SymbolRef>,
    /// Functions whose body references the symbol (inferred call sites).
    pub callers: Vec<SymbolRef>,
    /// True when more than one definition shares this name (homonyms). With only the
    /// syntactic matcher, references/callers cannot be attributed to a specific
    /// definition — the UI must warn that navigation here is ambiguous until a semantic
    /// engine (rust-analyzer) binds each occurrence. Honest signal, not a guess.
    pub ambiguous: bool,
}

// ── Internal per-file model ─────────────────────────────────────────────────────

#[derive(Clone)]
struct FnDef {
    name: String,
    kind: SymbolKind,
    def_line: u32,
    def_col: u32,
    start_line: u32,
    end_line: u32,
}

struct FileIndex {
    file: String,
    fns: Vec<FnDef>,
    types: Vec<SymbolRef>,
    /// Every identifier occurrence: (name, line, col).
    idents: Vec<(String, u32, u32)>,
}

/// Build the relations of `symbol` across every `.rs` file under `root`.
pub fn symbol_relations(root: &Path, symbol: &str) -> Result<Relations> {
    let mut definitions = Vec::new();
    let mut references = Vec::new();
    let mut callers = Vec::new();

    for path in rust_files(root) {
        let code = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let rel = display_path(&path, root);
        let idx = match index_file(&rel, &code) {
            Some(i) => i,
            None => continue, // unparseable file: skip, never abort the whole map
        };

        // Definitions: functions/methods and types named `symbol`.
        for f in &idx.fns {
            if f.name == symbol {
                definitions.push(SymbolRef {
                    name: f.name.clone(),
                    kind: f.kind,
                    file: idx.file.clone(),
                    line: f.def_line,
                    col: f.def_col,
                });
            }
        }
        for t in &idx.types {
            if t.name == symbol {
                definitions.push(t.clone());
            }
        }

        // References: every identifier occurrence of `symbol`.
        for (name, line, col) in &idx.idents {
            if name == symbol {
                references.push(SymbolRef {
                    name: name.clone(),
                    kind: SymbolKind::Other,
                    file: idx.file.clone(),
                    line: *line,
                    col: *col,
                });
                // The enclosing function (if any, and not the definition itself) is a
                // caller — inferred, since we match by name rather than by binding.
                if let Some(f) = enclosing_fn(&idx.fns, *line) {
                    let is_own_def = f.def_line == *line;
                    if !is_own_def {
                        callers.push(SymbolRef {
                            name: f.name.clone(),
                            kind: f.kind,
                            file: idx.file.clone(),
                            line: f.def_line,
                            col: f.def_col,
                        });
                    }
                }
            }
        }
    }

    dedup(&mut callers);

    // Go and Python definitions (syntactic): make "go to definition" work for those
    // symbols too. Their references/callers need a tokenizer and are not inferred here.
    definitions.extend(go_definitions(root, symbol));
    definitions.extend(python_definitions(root, symbol));

    // Homonyms: more than one definition with this name means the syntactic matcher
    // cannot say which one each reference binds to — flag it so the UI is honest.
    let ambiguous = definitions.len() > 1;

    Ok(Relations {
        symbol: symbol.to_string(),
        resolution: Resolution::Inferred,
        definitions,
        references,
        callers,
        ambiguous,
    })
}

/// Every top-level symbol definition across the project (Rust via `syn`: fns, methods,
/// types, consts/statics/type-aliases; Go and Python via their syntactic line scanners),
/// The full line span of a named function/method — the target for a SCOPED edit.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolRange {
    pub name: String,
    pub kind: SymbolKind,
    /// 1-based, inclusive line range covering the whole fn/method block.
    pub start_line: u32,
    pub end_line: u32,
}

/// Every function/method named `name` in Rust `code`, with its full line span. Used to edit
/// EXACTLY one method: the caller shows the range, and when the name repeats (homonyms) the
/// several candidates let the developer pick the target. Empty when `code` doesn't parse or
/// nothing matches.
pub fn symbol_ranges(code: &str, name: &str) -> Vec<SymbolRange> {
    let idx = match index_file("", code) {
        Some(i) => i,
        None => return Vec::new(),
    };
    idx.fns
        .into_iter()
        .filter(|f| f.name == name)
        .map(|f| SymbolRange {
            name: f.name,
            kind: f.kind,
            start_line: f.start_line,
            end_line: f.end_line,
        })
        .collect()
}

/// A file outline for ANY supported language: precise (Rust, from the AST) or heuristic
/// (Python/Go/JS/TS, from a light line scan). Powers a line-anchored Explain.
pub fn outline(code: &str, lang: &str) -> Vec<SymbolRange> {
    match lang {
        "rust" => file_outline(code),
        other => outline_heuristic(code, other),
    }
}

/// The identifier that follows `kw` at the start of `s` (after trimming), if any.
fn ident_after<'a>(s: &'a str, kw: &str) -> Option<&'a str> {
    let rest = s.trim_start().strip_prefix(kw)?.trim_start();
    let end = rest
        .find(|c: char| !(c.is_alphanumeric() || c == '_'))
        .unwrap_or(rest.len());
    (end > 0).then(|| &rest[..end])
}

/// Heuristic, dependency-free outline for Python / Go / JS / TS: top-level (and class)
/// functions, methods, classes and types, by a line scan. Anchors are the definition line
/// (`end_line == start_line`). Best-effort — favours precision over recall to avoid noise.
fn outline_heuristic(code: &str, lang: &str) -> Vec<SymbolRange> {
    let py = matches!(lang, "python" | "py");
    let go = matches!(lang, "go");
    let js = matches!(lang, "javascript" | "typescript" | "js" | "ts" | "jsx" | "tsx" | "mjs" | "cjs");
    let mut out = Vec::new();
    let mut push = |name: &str, kind: SymbolKind, line: u32| {
        out.push(SymbolRange {
            name: name.to_string(),
            kind,
            start_line: line,
            end_line: line,
        });
    };
    for (i, raw) in code.lines().enumerate() {
        let line = (i + 1) as u32;
        let t = raw.trim_start();
        if py {
            if let Some(n) = ident_after(t, "async def ").or_else(|| ident_after(t, "def ")) {
                push(n, SymbolKind::Function, line);
            } else if let Some(n) = ident_after(t, "class ") {
                push(n, SymbolKind::Struct, line);
            }
        } else if go {
            if t.starts_with("func ") {
                let after = t[5..].trim_start();
                // Skip a method receiver `(r T)` if present.
                let name_part = if after.starts_with('(') {
                    after.find(')').map(|c| after[c + 1..].trim_start()).unwrap_or(after)
                } else {
                    after
                };
                let end = name_part
                    .find(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .unwrap_or(name_part.len());
                if end > 0 {
                    push(&name_part[..end], SymbolKind::Function, line);
                }
            } else if let Some(n) = ident_after(t, "type ") {
                push(n, SymbolKind::Struct, line);
            }
        } else if js {
            // Normalise leading export/default modifiers.
            let mut s = t;
            for p in ["export ", "default "] {
                s = s.strip_prefix(p).unwrap_or(s).trim_start();
            }
            if let Some(n) = ident_after(s, "async function ").or_else(|| ident_after(s, "function ")) {
                push(n, SymbolKind::Function, line);
            } else if let Some(n) = ident_after(s, "class ") {
                push(n, SymbolKind::Struct, line);
            } else if let Some(kw) = ["const ", "let ", "var "].iter().find(|k| s.starts_with(**k)) {
                // Arrow/function assigned to a binding: `const foo = (…) => …` / `= async …`.
                if let Some(n) = ident_after(s, kw) {
                    let rhs = s.splitn(2, '=').nth(1).unwrap_or("");
                    if rhs.contains("=>") || rhs.contains("function") || rhs.trim_start().starts_with("async") {
                        push(n, SymbolKind::Function, line);
                    }
                }
            }
        }
    }
    out
}

/// The full outline of a Rust file: every function/method with its line span, in file order.
/// Powers a precise, LSP-grade Explain (real anchors instead of model-guessed line numbers).
/// Empty when `code` doesn't parse as Rust.
pub fn file_outline(code: &str) -> Vec<SymbolRange> {
    let idx = match index_file("", code) {
        Some(i) => i,
        None => return Vec::new(),
    };
    let mut out: Vec<SymbolRange> = idx
        .fns
        .into_iter()
        .map(|f| SymbolRange {
            name: f.name,
            kind: f.kind,
            start_line: f.start_line,
            end_line: f.end_line,
        })
        .collect();
    out.sort_by_key(|s| s.start_line);
    out
}

/// for a workspace "go to symbol" palette. Capped; sorted by name then file.
pub fn all_symbols(root: &Path, max: usize) -> Vec<SymbolRef> {
    let mut out = Vec::new();

    // Rust (precise, from the AST).
    for path in rust_files(root) {
        if out.len() >= max {
            break;
        }
        let code = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let file = display_path(&path, root);
        if let Some(idx) = index_file(&file, &code) {
            for f in idx.fns {
                out.push(SymbolRef {
                    name: f.name,
                    kind: f.kind,
                    file: file.clone(),
                    line: f.def_line,
                    col: f.def_col,
                });
            }
            out.extend(idx.types);
        }
    }

    // Go and Python (syntactic, by line).
    for (ext, name_of) in [("go", go_def_name as fn(&str) -> Option<&str>), ("py", python_def_name)] {
        for path in files_with_ext(root, ext) {
            if out.len() >= max {
                break;
            }
            let code = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let file = display_path(&path, root);
            for (i, line) in code.lines().enumerate() {
                if let Some(n) = name_of(line) {
                    out.push(SymbolRef {
                        name: n.to_string(),
                        kind: SymbolKind::Other,
                        file: file.clone(),
                        line: (i + 1) as u32,
                        col: 1,
                    });
                }
            }
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.file.cmp(&b.file)));
    out.truncate(max);
    out
}

// ── Indexing ─────────────────────────────────────────────────────────────────────

fn index_file(file: &str, code: &str) -> Option<FileIndex> {
    let ast = syn::parse_file(code).ok()?;
    let mut fns = Vec::new();
    let mut types = Vec::new();
    collect_items(file, &ast.items, &mut fns, &mut types);

    let mut idents = Vec::new();
    if let Ok(ts) = code.parse::<proc_macro2::TokenStream>() {
        collect_idents(ts, &mut idents);
    }

    Some(FileIndex {
        file: file.to_string(),
        fns,
        types,
        idents,
    })
}

fn collect_items(file: &str, items: &[syn::Item], fns: &mut Vec<FnDef>, types: &mut Vec<SymbolRef>) {
    for it in items {
        match it {
            syn::Item::Fn(f) => fns.push(fn_def(&f.sig.ident, SymbolKind::Function, it.span())),
            syn::Item::Impl(imp) => {
                for ii in &imp.items {
                    if let syn::ImplItem::Fn(m) = ii {
                        fns.push(fn_def(&m.sig.ident, SymbolKind::Method, m.span()));
                    }
                }
            }
            syn::Item::Trait(t) => {
                types.push(type_ref(file, &t.ident, SymbolKind::Trait));
                for ti in &t.items {
                    if let syn::TraitItem::Fn(m) = ti {
                        fns.push(fn_def(&m.sig.ident, SymbolKind::Method, m.span()));
                    }
                }
            }
            syn::Item::Struct(s) => types.push(type_ref(file, &s.ident, SymbolKind::Struct)),
            syn::Item::Enum(e) => types.push(type_ref(file, &e.ident, SymbolKind::Enum)),
            // Consts, statics and type aliases are navigable definitions too — without
            // these, jumping to a `const MAX` or a `type NodeId` found no definition.
            syn::Item::Const(c) => types.push(type_ref(file, &c.ident, SymbolKind::Other)),
            syn::Item::Static(s) => types.push(type_ref(file, &s.ident, SymbolKind::Other)),
            syn::Item::Type(t) => types.push(type_ref(file, &t.ident, SymbolKind::Other)),
            syn::Item::Mod(m) => {
                if let Some((_, items)) = &m.content {
                    collect_items(file, items, fns, types);
                }
            }
            _ => {}
        }
    }
}

fn fn_def(ident: &syn::Ident, kind: SymbolKind, whole: proc_macro2::Span) -> FnDef {
    let ds = ident.span().start();
    let start = whole.start();
    let end = whole.end();
    FnDef {
        name: ident.to_string(),
        kind,
        def_line: ds.line as u32,
        def_col: ds.column as u32 + 1,
        start_line: start.line as u32,
        end_line: end.line as u32,
    }
}

fn type_ref(file: &str, ident: &syn::Ident, kind: SymbolKind) -> SymbolRef {
    let s = ident.span().start();
    SymbolRef {
        name: ident.to_string(),
        kind,
        file: file.to_string(),
        line: s.line as u32,
        col: s.column as u32 + 1,
    }
}

/// Walk a token stream collecting every identifier occurrence with its position.
fn collect_idents(ts: proc_macro2::TokenStream, out: &mut Vec<(String, u32, u32)>) {
    for tt in ts {
        match tt {
            TokenTree::Ident(id) => {
                let s = id.span().start();
                out.push((id.to_string(), s.line as u32, s.column as u32 + 1));
            }
            TokenTree::Group(g) => collect_idents(g.stream(), out),
            _ => {}
        }
    }
}

/// The innermost function whose line range contains `line`.
fn enclosing_fn(fns: &[FnDef], line: u32) -> Option<&FnDef> {
    fns.iter()
        .filter(|f| f.start_line <= line && line <= f.end_line)
        .min_by_key(|f| f.end_line - f.start_line)
}

fn dedup(refs: &mut Vec<SymbolRef>) {
    refs.sort_by(|a, b| (a.file.as_str(), a.line, a.col).cmp(&(b.file.as_str(), b.line, b.col)));
    refs.dedup_by(|a, b| a.file == b.file && a.line == b.line && a.col == b.col);
}

// ── File discovery ───────────────────────────────────────────────────────────────

/// All `.rs` files under `root`, skipping the usual noise dirs.
pub(crate) fn rust_files(root: &Path) -> Vec<std::path::PathBuf> {
    files_with_ext(root, "rs")
}

/// Every file with extension `ext` under `root`, skipping heavy/VCS dirs, capped.
pub(crate) fn files_with_ext(root: &Path, ext: &str) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            seen += 1;
            if seen > 50_000 {
                return out;
            }
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if matches!(name.as_ref(), "target" | ".git" | "node_modules" | "vendor") {
                    continue;
                }
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some(ext) {
                out.push(path);
            }
        }
    }
    out
}

/// Top-level Go definition name on a line, if any: `func Name(`, `func (r R) Name(`,
/// `type Name …`, `const Name …`, `var Name …`. Syntactic and conservative.
fn go_def_name(line: &str) -> Option<&str> {
    let line = line.trim_start();
    if let Some(rest) = line.strip_prefix("func ") {
        let mut rest = rest.trim_start();
        if rest.starts_with('(') {
            // skip the receiver "(r *R) "
            let close = rest.find(')')?;
            rest = rest[close + 1..].trim_start();
        }
        let end = rest.find(|c: char| c == '(' || c.is_whitespace() || c == '[')?;
        return (end > 0).then(|| &rest[..end]);
    }
    for kw in ["type ", "const ", "var "] {
        if let Some(rest) = line.strip_prefix(kw) {
            let rest = rest.trim_start();
            let end = rest.find(|c: char| c.is_whitespace() || c == '=' || c == '(')?;
            return (end > 0).then(|| &rest[..end]);
        }
    }
    None
}

/// Syntactic Go definitions of `symbol` across `.go` files under `root`. Definitions only
/// (precise); Go references/callers need a tokenizer and are not inferred here.
pub(crate) fn go_definitions(root: &Path, symbol: &str) -> Vec<SymbolRef> {
    defs_by_line(root, "go", symbol, go_def_name)
}

/// Top-level Python definition name on a line, if any: `def name(` / `class Name(` /
/// `class Name:`. Indentation-tolerant, so methods inside classes count too.
fn python_def_name(line: &str) -> Option<&str> {
    let line = line.trim_start();
    for kw in ["def ", "class "] {
        if let Some(rest) = line.strip_prefix(kw) {
            let end = rest.find(|c: char| c == '(' || c == ':' || c.is_whitespace())?;
            return (end > 0).then(|| &rest[..end]);
        }
    }
    None
}

/// Syntactic Python definitions of `symbol` (`def`/`class`) across `.py` files. Definitions
/// only; references need a tokenizer and are not inferred here.
pub(crate) fn python_definitions(root: &Path, symbol: &str) -> Vec<SymbolRef> {
    defs_by_line(root, "py", symbol, python_def_name)
}

/// Shared line scanner for the syntactic language adapters: every line whose definition
/// name (via `name_of`) equals `symbol` becomes a `SymbolRef`.
fn defs_by_line(
    root: &Path,
    ext: &str,
    symbol: &str,
    name_of: fn(&str) -> Option<&str>,
) -> Vec<SymbolRef> {
    let mut out = Vec::new();
    for path in files_with_ext(root, ext) {
        let code = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let file = display_path(&path, root);
        for (i, line) in code.lines().enumerate() {
            if name_of(line) == Some(symbol) {
                out.push(SymbolRef {
                    name: symbol.to_string(),
                    kind: SymbolKind::Other,
                    file: file.clone(),
                    line: (i + 1) as u32,
                    col: 1,
                });
            }
        }
    }
    out
}

pub(crate) fn display_path(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn heuristic_outline_python_go_js() {
        let py = "import os\n\nclass Foo:\n    def method_a(self):\n        pass\n\nasync def run():\n    pass\n";
        let p = outline(py, "python");
        assert!(p.iter().any(|s| s.name == "Foo" && s.start_line == 3), "{p:?}");
        assert!(p.iter().any(|s| s.name == "method_a" && s.start_line == 4), "{p:?}");
        assert!(p.iter().any(|s| s.name == "run" && s.start_line == 7), "{p:?}");

        let go = "package main\n\ntype User struct{}\n\nfunc (u User) Name() string { return \"\" }\n\nfunc main() {}\n";
        let g = outline(go, "go");
        assert!(g.iter().any(|s| s.name == "User"), "{g:?}");
        assert!(g.iter().any(|s| s.name == "Name" && s.start_line == 5), "{g:?}");
        assert!(g.iter().any(|s| s.name == "main" && s.start_line == 7), "{g:?}");

        let js = "export function parse(x) {}\nclass Widget {}\nconst build = async (n) => n + 1;\nif (x) {}\n";
        let j = outline(js, "js");
        assert!(j.iter().any(|s| s.name == "parse" && s.start_line == 1), "{j:?}");
        assert!(j.iter().any(|s| s.name == "Widget"), "{j:?}");
        assert!(j.iter().any(|s| s.name == "build" && s.start_line == 3), "{j:?}");
        assert!(!j.iter().any(|s| s.name == "if"), "control keywords excluded: {j:?}");
    }

    #[test]
    fn finds_definition_references_and_callers_across_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        // `helper` is defined in lib.rs and called from main.rs's `run`.
        fs::write(
            root.join("src/lib.rs"),
            "pub fn helper(n: i32) -> i32 {\n    n + 1\n}\n",
        )
        .unwrap();
        fs::write(
            root.join("src/main.rs"),
            "mod lib;\n\nfn run() {\n    let x = lib::helper(2);\n    println!(\"{x}\");\n}\n\nfn main() {\n    run();\n}\n",
        )
        .unwrap();

        let rel = symbol_relations(root, "helper").expect("relations");
        assert_eq!(rel.resolution, Resolution::Inferred);

        // One definition, in lib.rs on line 1.
        assert_eq!(rel.definitions.len(), 1, "defs: {:?}", rel.definitions);
        let def = &rel.definitions[0];
        assert!(def.file.ends_with("lib.rs"));
        assert_eq!(def.line, 1);
        assert_eq!(def.kind, SymbolKind::Function);

        // References include both the definition and the call site.
        assert!(
            rel.references.iter().any(|r| r.file.ends_with("main.rs")),
            "refs: {:?}",
            rel.references
        );

        // `run` is a caller; `helper` itself (its own def) is not listed as a caller.
        assert!(
            rel.callers.iter().any(|c| c.name == "run"),
            "callers: {:?}",
            rel.callers
        );
        assert!(!rel.callers.iter().any(|c| c.name == "helper"));
        assert!(!rel.ambiguous, "a single definition is unambiguous");
    }

    /// Section 5: two homonymous symbols (same name, different modules) must be flagged
    /// `ambiguous` — the syntactic matcher can't bind a reference to one of them, and the
    /// UI needs to say so until rust-analyzer resolves it.
    #[test]
    fn homonymous_definitions_are_flagged_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        // Two different `helper` functions, one per module.
        fs::write(root.join("src/a.rs"), "pub fn helper(n: i32) -> i32 {\n    n + 1\n}\n").unwrap();
        fs::write(root.join("src/b.rs"), "pub fn helper(s: &str) -> usize {\n    s.len()\n}\n").unwrap();
        fs::write(
            root.join("src/main.rs"),
            "mod a;\nmod b;\nfn main() {\n    let _ = a::helper(1);\n    let _ = b::helper(\"x\");\n}\n",
        )
        .unwrap();

        let rel = symbol_relations(root, "helper").expect("relations");
        assert_eq!(rel.definitions.len(), 2, "defs: {:?}", rel.definitions);
        assert!(rel.ambiguous, "two same-named defs must be ambiguous");
        assert_eq!(rel.resolution, Resolution::Inferred);
    }

    #[test]
    fn all_symbols_reune_rust_go_python() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn rust_fn() {}\npub struct RustType;\n").unwrap();
        fs::write(root.join("srv.go"), "package d\nfunc GoFunc() {}\ntype GoType struct{}\n").unwrap();
        fs::write(root.join("app.py"), "class PyClass:\n    def py_method(self):\n        pass\n").unwrap();

        let syms = all_symbols(root, 1000);
        let names: Vec<&str> = syms.iter().map(|s| s.name.as_str()).collect();
        for want in ["rust_fn", "RustType", "GoFunc", "GoType", "PyClass", "py_method"] {
            assert!(names.contains(&want), "faltou {want} em {names:?}");
        }
        // Ordenado por nome (palette estável).
        let mut sorted = syms.clone();
        sorted.sort_by(|a, b| a.name.cmp(&b.name).then(a.file.cmp(&b.file)));
        assert_eq!(syms.iter().map(|s| &s.name).collect::<Vec<_>>(), sorted.iter().map(|s| &s.name).collect::<Vec<_>>());
    }

    #[test]
    fn symbol_ranges_localiza_metodo_e_homonimos() {
        let code = "\
fn helper() {
    let x = 1;
}

struct S;
impl S {
    fn helper(&self) {
        println!(\"m\");
    }
}

fn other() {}
";
        let ranges = symbol_ranges(code, "helper");
        assert_eq!(ranges.len(), 2, "two `helper` (free fn + method): {ranges:?}");
        // The free fn spans lines 1..3.
        assert!(ranges.iter().any(|r| r.start_line == 1 && r.end_line == 3 && r.kind == SymbolKind::Function));
        // The method spans lines 7..9.
        assert!(ranges.iter().any(|r| r.start_line == 7 && r.end_line == 9 && r.kind == SymbolKind::Method));
        // A non-existent name yields nothing; a single match yields one range.
        assert!(symbol_ranges(code, "nope").is_empty());
        assert_eq!(symbol_ranges(code, "other").len(), 1);
    }

    #[test]
    fn go_def_name_reconhece_formas() {
        assert_eq!(go_def_name("func Add(a, b int) int {"), Some("Add"));
        assert_eq!(go_def_name("func (s *Server) Start() error {"), Some("Start"));
        assert_eq!(go_def_name("type Node struct {"), Some("Node"));
        assert_eq!(go_def_name("const MaxSize = 10"), Some("MaxSize"));
        assert_eq!(go_def_name("var Logger *log.Logger"), Some("Logger"));
        assert_eq!(go_def_name("    x := 1"), None);
    }

    #[test]
    fn python_def_name_reconhece_formas() {
        assert_eq!(python_def_name("def add(a, b):"), Some("add"));
        assert_eq!(python_def_name("    def method(self):"), Some("method"));
        assert_eq!(python_def_name("class Node:"), Some("Node"));
        assert_eq!(python_def_name("class Server(Base):"), Some("Server"));
        assert_eq!(python_def_name("x = 1"), None);
    }

    #[test]
    fn navega_para_definicoes_python() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("app.py"),
            "class Server:\n    def start(self):\n        pass\ndef helper():\n    pass\n",
        )
        .unwrap();
        for sym in ["Server", "start", "helper"] {
            let rel = symbol_relations(root, sym).expect("relations");
            assert!(
                rel.definitions.iter().any(|d| d.name == sym && d.file.ends_with("app.py")),
                "{sym}: sem definição Python em {:?}",
                rel.definitions
            );
        }
    }

    #[test]
    fn navega_para_definicoes_go() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("server.go"),
            "package demo\nfunc (s *Server) Start() error { return nil }\ntype Node struct {}\nconst MaxSize = 10\n",
        )
        .unwrap();
        for sym in ["Start", "Node", "MaxSize"] {
            let rel = symbol_relations(root, sym).expect("relations");
            assert!(
                rel.definitions.iter().any(|d| d.name == sym && d.file.ends_with("server.go")),
                "{sym}: sem definição Go em {:?}",
                rel.definitions
            );
        }
    }

    /// Consts/statics/type aliases are navigable: jumping to `MAX` finds its definition.
    #[test]
    fn finds_const_static_and_type_definitions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/lib.rs"),
            "pub const MAX: usize = 10;\npub static NAME: &str = \"x\";\npub type NodeId = u32;\nfn use_it() -> usize { MAX }\n",
        )
        .unwrap();

        for sym in ["MAX", "NAME", "NodeId"] {
            let rel = symbol_relations(root, sym).expect("relations");
            assert!(
                rel.definitions.iter().any(|d| d.name == sym),
                "{sym}: no definition found in {:?}",
                rel.definitions
            );
        }
    }
}
