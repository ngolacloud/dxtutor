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

    Ok(Relations {
        symbol: symbol.to_string(),
        resolution: Resolution::Inferred,
        definitions,
        references,
        callers,
    })
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
fn rust_files(root: &Path) -> Vec<std::path::PathBuf> {
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
                if matches!(name.as_ref(), "target" | ".git" | "node_modules") {
                    continue;
                }
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }
    out
}

fn display_path(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
    }
}
