//! Minimal LSP client for **resolved** navigation via rust-analyzer (section 5).
//!
//! The CodeMap's syntactic analysis is honest but name-based (`Inferred`). This module
//! drives rust-analyzer over stdio — JSON-RPC with `Content-Length` framing — to answer a
//! real `textDocument/definition`, so "go to definition" can bind to the *actual* symbol
//! (`Resolved`). It is best-effort: when rust-analyzer is absent, the project doesn't
//! index, or it takes too long, the caller falls back to the syntactic result.
//!
//! A watchdog thread kills the server after a hard timeout, so a request never hangs the UI.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

/// Overall wall-clock budget for one definition request (spawn + index + answer).
const BUDGET: Duration = Duration::from_secs(30);

/// Is rust-analyzer on PATH?
pub fn available() -> bool {
    Command::new("rust-analyzer")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A resolved location: `file://` URI, 0-based line and character (LSP-native).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    pub uri: String,
    pub line: u32,
    pub character: u32,
}

/// Resolve the definition of the symbol at (`line`, `character`) — both 0-based — in
/// `file` (absolute) of the project at `root`, using rust-analyzer. `None` on any failure
/// (absent server, no result, timeout) so the caller can fall back to the syntactic map.
pub fn resolve_definition(
    root: &Path,
    file: &Path,
    line: u32,
    character: u32,
    text: Option<&str>,
) -> Option<Location> {
    request(root, file, line, character, "textDocument/definition", false, text)
        .map(|v| parse_locations(&v))
        .and_then(|ls| ls.into_iter().next())
}

/// Resolve ALL references to the symbol at (`line`, `character`) across the project via
/// rust-analyzer (`textDocument/references`, including the declaration). Empty on failure.
pub fn resolve_references(
    root: &Path,
    file: &Path,
    line: u32,
    character: u32,
    text: Option<&str>,
) -> Vec<Location> {
    request(root, file, line, character, "textDocument/references", true, text)
        .map(|v| parse_locations(&v))
        .unwrap_or_default()
}

/// Hover info (type signature / docs, as markdown) for the symbol at (`line`, `character`)
/// via rust-analyzer (`textDocument/hover`). `None` on failure.
pub fn resolve_hover(
    root: &Path,
    file: &Path,
    line: u32,
    character: u32,
    text: Option<&str>,
) -> Option<String> {
    request(root, file, line, character, "textDocument/hover", false, text)
        .and_then(|v| parse_hover(&v))
}

/// Shared driver: spawn rust-analyzer, handshake, open the file, poll `method` at the
/// position until it yields locations (or the budget runs out). A watchdog kills the
/// server so it never hangs. `text`, when given, is the LIVE editor buffer — used for the
/// `didOpen` so navigation is correct even with unsaved edits; otherwise the file is read
/// from disk. Returns the parsed locations (empty on any failure).
#[allow(clippy::too_many_arguments)]
fn request(
    root: &Path,
    file: &Path,
    line: u32,
    character: u32,
    method: &'static str,
    include_decl: bool,
    text: Option<&str>,
) -> Option<Value> {
    // rust-analyzer only speaks Rust: skip it (and its multi-second cold start) for other
    // files, so the caller falls back to the syntactic map immediately.
    if file.extension().and_then(|e| e.to_str()) != Some("rs") {
        return None;
    }
    // Agent routing: when a persistent container session is running for this project, drive
    // rust-analyzer INSIDE the container (its toolchain + deps) over `exec -i`, translating
    // host paths ↔ the container's /work mount. Otherwise run it on the host.
    let use_container = crate::container::session_running(&crate::container::session_name(root));
    let spawn = if use_container {
        let (prog, args) = crate::container::session_exec_command(root, "rust-analyzer");
        Command::new(prog)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    } else {
        Command::new("rust-analyzer")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    };
    let mut child = match spawn {
        Ok(c) => c,
        Err(_) => return None,
    };
    let (mut stdin, stdout) = match (child.stdin.take(), child.stdout.take()) {
        (Some(i), Some(o)) => (i, o),
        _ => return None,
    };
    let mut reader = BufReader::new(stdout);

    // In container mode the workspace is mounted at /work; build URIs there and map results
    // back to host paths afterwards.
    let (root_uri, file_uri) = if use_container {
        let rel = file
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file.display().to_string());
        ("file:///work".to_string(), format!("file:///work/{rel}"))
    } else {
        (format!("file://{}", root.display()), format!("file://{}", file.display()))
    };
    // Prefer the live buffer (unsaved edits) over the on-disk content.
    let text = match text {
        Some(t) => t.to_string(),
        None => match std::fs::read_to_string(file) {
            Ok(t) => t,
            Err(_) => return None,
        },
    };

    // Run the exchange on a worker thread; recv_timeout enforces the hard budget.
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let r = exchange(&mut stdin, &mut reader, &root_uri, &file_uri, &text, line, character, method, include_decl);
        let _ = tx.send(r);
    });
    let mut result = rx.recv_timeout(BUDGET).ok().flatten();
    let _ = child.kill(); // closes the pipes → the worker's blocking read unblocks
    let _ = child.wait();
    let _ = worker.join();
    // Map container URIs (file:///work/…) back to host paths so navigation opens real files.
    if use_container {
        if let Some(v) = &result {
            let host = format!("file://{}", root.display());
            if let Ok(mapped) = serde_json::from_str(&v.to_string().replace("file:///work", &host)) {
                result = Some(mapped);
            }
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn exchange(
    stdin: &mut impl Write,
    reader: &mut impl BufRead,
    root_uri: &str,
    file_uri: &str,
    text: &str,
    line: u32,
    character: u32,
    method: &str,
    include_decl: bool,
) -> Option<Value> {
    send(stdin, &json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "processId": null, "rootUri": root_uri, "capabilities": {} }
    }))?;
    read_until_id(reader, 1)?; // initialize result (ignored)
    send(stdin, &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }))?;
    send(stdin, &json!({
        "jsonrpc": "2.0", "method": "textDocument/didOpen",
        "params": { "textDocument": { "uri": file_uri, "languageId": "rust", "version": 1, "text": text } }
    }))?;

    // rust-analyzer returns null/[] until it has indexed the crate — poll a few times.
    for id in 2..40 {
        let mut params = json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": line, "character": character }
        });
        if include_decl {
            params["context"] = json!({ "includeDeclaration": true });
        }
        send(stdin, &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let result = read_until_id(reader, id)?;
        if is_ready(&result) {
            return Some(result);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Some(Value::Null)
}

/// Has rust-analyzer produced a real answer (vs still indexing)? Non-null and not an empty
/// array means ready — covers locations (`[]` → not ready) and hover (`null` → not ready).
fn is_ready(v: &Value) -> bool {
    !v.is_null() && v.as_array().map(|a| !a.is_empty()).unwrap_or(true)
}

fn send(stdin: &mut impl Write, v: &Value) -> Option<()> {
    let body = serde_json::to_vec(v).ok()?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).ok()?;
    stdin.write_all(&body).ok()?;
    stdin.flush().ok()
}

/// Read framed messages, skipping notifications and other ids, until the response with
/// `id` arrives; returns its `result` (may be `Null`). `None` if the stream closes.
fn read_until_id(reader: &mut impl BufRead, id: i64) -> Option<Value> {
    loop {
        let msg = read_msg(reader)?;
        if msg.get("id").and_then(|v| v.as_i64()) == Some(id) {
            return Some(msg.get("result").cloned().unwrap_or(Value::Null));
        }
        // else: a notification or a different response — keep reading.
    }
}

fn read_msg(reader: &mut impl BufRead) -> Option<Value> {
    let mut content_len = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None; // stream closed
        }
        let line = line.trim_end();
        if line.is_empty() {
            break; // end of headers
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            content_len = v.trim().parse().ok()?;
        }
    }
    let mut buf = vec![0u8; content_len];
    reader.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

/// Convert a `file://` URI to a filesystem path, percent-decoding it (rust-analyzer
/// returns e.g. `file:///home/my%20project/src/lib.rs` for paths with spaces/accents).
pub fn uri_to_path(uri: &str) -> String {
    percent_decode(uri.strip_prefix("file://").unwrap_or(uri))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Extract the hover text from a `textDocument/hover` result. `contents` may be a
/// `MarkupContent {value}`, a `MarkedString` (string or `{value}`), or an array of those.
fn parse_hover(result: &Value) -> Option<String> {
    let contents = result.get("contents")?;
    let text = match contents {
        Value::String(s) => s.clone(),
        Value::Object(o) => o.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        Value::Array(a) => a
            .iter()
            .map(|p| match p {
                Value::String(s) => s.clone(),
                Value::Object(o) => o.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => return None,
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Normalise a definition/references result (`Location`, `Location[]`, or `LocationLink[]`)
/// into our `Location`s.
fn parse_locations(result: &Value) -> Vec<Location> {
    let items: Vec<&Value> = match result {
        Value::Array(a) => a.iter().collect(),
        Value::Object(_) => vec![result],
        _ => return Vec::new(),
    };
    items.into_iter().filter_map(parse_one).collect()
}

fn parse_one(v: &Value) -> Option<Location> {
    // LocationLink uses targetUri/targetRange; Location uses uri/range.
    let uri = v
        .get("uri")
        .or_else(|| v.get("targetUri"))
        .and_then(|x| x.as_str())?
        .to_string();
    let range = v.get("range").or_else(|| v.get("targetRange"))?;
    let start = range.get("start")?;
    Some(Location {
        uri,
        line: start.get("line")?.as_u64()? as u32,
        character: start.get("character")?.as_u64()? as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_locations_handles_the_shapes() {
        let loc = json!({ "uri": "file:///a.rs", "range": { "start": { "line": 3, "character": 4 } } });
        assert_eq!(parse_locations(&loc), vec![Location { uri: "file:///a.rs".into(), line: 3, character: 4 }]);

        let arr = json!([
            { "uri": "file:///b.rs", "range": { "start": { "line": 1, "character": 0 } } },
            { "uri": "file:///b.rs", "range": { "start": { "line": 9, "character": 2 } } }
        ]);
        assert_eq!(parse_locations(&arr).len(), 2);

        let link = json!([{ "targetUri": "file:///c.rs", "targetRange": { "start": { "line": 5, "character": 2 } } }]);
        assert_eq!(parse_locations(&link)[0].line, 5);

        assert!(parse_locations(&Value::Null).is_empty());
        assert!(parse_locations(&json!([])).is_empty());
    }

    #[test]
    fn parse_hover_handles_markup_string_and_array() {
        let markup = json!({ "contents": { "kind": "markdown", "value": "fn helper(n: i32) -> i32" } });
        assert_eq!(parse_hover(&markup).unwrap(), "fn helper(n: i32) -> i32");
        let s = json!({ "contents": "plain hover" });
        assert_eq!(parse_hover(&s).unwrap(), "plain hover");
        let arr = json!({ "contents": ["a", { "value": "b" }] });
        assert_eq!(parse_hover(&arr).unwrap(), "a\n\nb");
        assert!(parse_hover(&Value::Null).is_none());
        assert!(parse_hover(&json!({ "contents": "" })).is_none());
    }

    #[test]
    fn uri_to_path_decodes_percent_escapes() {
        assert_eq!(uri_to_path("file:///home/u/src/a.rs"), "/home/u/src/a.rs");
        assert_eq!(uri_to_path("file:///home/my%20project/a.rs"), "/home/my project/a.rs");
        assert_eq!(uri_to_path("file:///p/a%C3%A7%C3%A3o.rs"), "/p/ação.rs"); // UTF-8 bytes
        assert_eq!(uri_to_path("/already/plain"), "/already/plain");
    }

    #[test]
    fn non_rust_files_skip_the_server_fast() {
        // A .py file must return immediately (no rust-analyzer spawn / 30s budget),
        // letting the caller fall back to the syntactic map. Timed to prove it's instant.
        let dir = tempfile::tempdir().unwrap();
        let py = dir.path().join("app.py");
        std::fs::write(&py, "def f():\n    pass\n").unwrap();
        let t0 = std::time::Instant::now();
        assert!(resolve_definition(dir.path(), &py, 0, 4, None).is_none());
        assert!(resolve_references(dir.path(), &py, 0, 4, None).is_empty());
        assert!(t0.elapsed().as_secs() < 2, "non-Rust must not pay the LSP cold start");
    }

    #[test]
    #[ignore = "needs rust-analyzer; indexes a crate; run with --ignored"]
    fn resolves_a_cross_file_definition() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("Cargo.toml"), "[package]\nname=\"demo\"\nversion=\"0.0.0\"\nedition=\"2021\"\n\n[workspace]\n").unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "pub fn helper(n: i32) -> i32 { n + 1 }\n").unwrap();
        // main.rs line 2 (0-based 1) calls demo::helper — resolve that usage.
        let main = "fn main() {\n    let _ = demo::helper(2);\n}\n";
        std::fs::write(root.join("src/main.rs"), main).unwrap();

        // Position on `helper` in the call (0-based line 1, character ~ the 'h').
        let col = main.lines().nth(1).unwrap().find("helper").unwrap() as u32;
        let loc = resolve_definition(root, &root.join("src/main.rs"), 1, col, None)
            .expect("rust-analyzer should resolve the definition");
        assert!(loc.uri.ends_with("src/lib.rs"), "resolved to {}", loc.uri);
        assert_eq!(loc.line, 0, "helper is defined on line 1 (0-based 0)");
    }

    #[test]
    #[ignore = "needs rust-analyzer; indexes a crate; run with --ignored"]
    fn resolves_references_across_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("Cargo.toml"), "[package]\nname=\"demo\"\nversion=\"0.0.0\"\nedition=\"2021\"\n\n[workspace]\n").unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        let lib = "pub fn helper(n: i32) -> i32 { n + 1 }\n";
        std::fs::write(root.join("src/lib.rs"), lib).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {\n    let _ = demo::helper(2);\n}\n").unwrap();

        // Position on `helper` at its declaration in lib.rs (line 0).
        let col = lib.find("helper").unwrap() as u32;
        let refs = resolve_references(root, &root.join("src/lib.rs"), 0, col, None);
        // With includeDeclaration: the decl in lib.rs + the use in main.rs.
        assert!(refs.len() >= 2, "expected ≥2 references, got {refs:?}");
        assert!(refs.iter().any(|r| r.uri.ends_with("src/main.rs")), "a use in main.rs: {refs:?}");
    }
}
