// Multi-language LSP client (JSON-RPC over stdio) for the dxtutor IDE.
//
// ONE server per PROJECT, per language: a session is keyed by (languageId, project
// root), where the root is the NEAREST ancestor holding that language's marker
// (Cargo.toml for Rust, go.mod for Go, tsconfig/package.json for TS, pyproject for
// Python). Rooting the server at the file's own project keeps the index small, fast
// and correct, and makes a DETACHED project resolve — which a single server rooted
// at a huge monorepo never would. The language registry (`LANGS` + `server_cmd`)
// is the ONLY language-specific part; everything below is protocol-generic.
//
// THREADING: every command is `async` and runs its blocking work (the LSP
// round-trip and the "wait for index" poll) on `spawn_blocking`, NEVER on the
// webview's main thread — otherwise a hover (which fires continuously) blocking on
// the index would freeze the whole app.
//
// Each session owns a child process and a reader thread that demultiplexes
// responses by id and forwards `publishDiagnostics` to the UI. A `ready` flag is
// set when the server finishes its first indexing pass; user-driven navigation
// waits (bounded) for it, hover does not.

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

struct Session {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    next_id: i64,
    pending: HashMap<i64, Sender<Value>>,
    open: HashSet<String>,
    ready: bool,
    /// Human label of the backing server ("rust-analyzer", "gopls", …) for the pill.
    label: &'static str,
    /// Substring marking the end-of-index `$/progress` for this server (see `Lang`).
    ready_signal: &'static str,
    /// token → begin-title, so an `end` event (whose own title is empty) can be matched
    /// against `ready_signal` by the title announced when the work began.
    progress_titles: HashMap<String, String>,
}

type SessionMap = Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>;

#[derive(Default, Clone)]
pub struct LspState(SessionMap);

/// A supported language: how to recognise its files and find its project root.
/// This (+ `server_cmd`) is the ONLY place that knows about specific languages.
struct Lang {
    /// LSP `languageId` — also the session-key prefix and the UI's language tag.
    id: &'static str,
    /// File extensions (no dot) that map to this language.
    exts: &'static [&'static str],
    /// Project-root markers: the session roots at the nearest ancestor holding ANY.
    markers: &'static [&'static str],
    /// Human label of the server binary, for the progress pill ("rust-analyzer", "gopls", …).
    server_label: &'static str,
    /// Lowercase substring that, in the TOKEN or the BEGIN-title of a finishing
    /// `$/progress`, marks the symbol index as built (session becomes `ready`). MEASURED
    /// per server: rust-analyzer's token is `rustAnalyzer/cachePriming`; gopls titles its
    /// startup "Setting up workspace". The ts/python signals are best-effort until their
    /// servers are installed and measured the same way.
    ready_signal: &'static str,
}

const LANGS: &[Lang] = &[
    Lang { id: "rust", exts: &["rs"], markers: &["Cargo.toml"], server_label: "rust-analyzer", ready_signal: "cachepriming" },
    Lang { id: "go", exts: &["go"], markers: &["go.work", "go.mod"], server_label: "gopls", ready_signal: "setting up workspace" },
    Lang {
        id: "typescript",
        exts: &["ts", "tsx", "js", "jsx", "mjs", "cjs"],
        markers: &["tsconfig.json", "jsconfig.json", "package.json"],
        server_label: "typescript-language-server",
        ready_signal: "initializ",
    },
    Lang {
        id: "python",
        exts: &["py", "pyi"],
        markers: &["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", ".git"],
        server_label: "pyright",
        // Measured: pyright emits NO startup indexing progress (only transient per-request
        // tokens) and answers immediately. Empty signal ⇒ ready as soon as `initialized`.
        ready_signal: "",
    },
];

fn lang_for_path(path: &str) -> Option<&'static Lang> {
    let ext = std::path::Path::new(path).extension()?.to_str()?;
    LANGS.iter().find(|l| l.exts.contains(&ext))
}

/// The rust-analyzer binary to spawn. The bare `rust-analyzer` on PATH is often the
/// rustup PROXY, which INFINITELY RECURSES (and crashes) when the active toolchain of the
/// opened project lacks the rust-analyzer component (common with a nightly-pinned fuzz
/// crate). We therefore resolve a CONCRETE toolchain binary. Cached for the process.
fn ra_bin() -> String {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        if let Ok(p) = std::env::var("DXTUTOR_RUST_ANALYZER") {
            if !p.is_empty() {
                return p;
            }
        }
        if let Ok(out) = Command::new("rustup").args(["which", "--toolchain", "stable", "rust-analyzer"]).output() {
            if out.status.success() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if std::path::Path::new(&p).is_file() {
                    return p;
                }
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            if let Ok(rd) = std::fs::read_dir(std::path::Path::new(&home).join(".rustup/toolchains")) {
                let mut fallback = None;
                for e in rd.flatten() {
                    let b = e.path().join("bin/rust-analyzer");
                    if b.is_file() {
                        if e.file_name().to_string_lossy().starts_with("stable") {
                            return b.to_string_lossy().to_string();
                        }
                        fallback.get_or_insert_with(|| b.to_string_lossy().to_string());
                    }
                }
                if let Some(f) = fallback {
                    return f;
                }
            }
        }
        "rust-analyzer".to_string()
    })
    .clone()
}

/// First existing file among `$HOME/<rel>` candidates, else None.
fn home_bin(rels: &[&str]) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    rels.iter()
        .map(|r| std::path::Path::new(&home).join(r))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
}

/// gopls: `$DXTUTOR_GOPLS`, then `$(go env GOPATH)/bin`, then `~/go/bin`, then PATH.
fn gopls_bin() -> Result<String, String> {
    static BIN: OnceLock<Option<String>> = OnceLock::new();
    BIN.get_or_init(|| {
        if let Ok(p) = std::env::var("DXTUTOR_GOPLS") {
            if std::path::Path::new(&p).is_file() {
                return Some(p);
            }
        }
        if let Ok(out) = Command::new("go").env("PATH", augmented_path()).args(["env", "GOPATH"]).output() {
            if out.status.success() {
                let gp = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let b = std::path::Path::new(&gp).join("bin/gopls");
                if b.is_file() {
                    return Some(b.to_string_lossy().to_string());
                }
            }
        }
        home_bin(&["go/bin/gopls"])
    })
    .clone()
    .ok_or_else(|| "gopls não encontrado (instala com `go install golang.org/x/tools/gopls@latest`)".into())
}

/// A node-based stdio server (typescript-language-server, pyright-langserver): look in
/// the active nvm node bin dir, then PATH.
fn node_server(name: &'static str) -> Result<String, String> {
    if let Some(p) = home_bin(&[&format!(".nvm/versions/node/v25.0.0/bin/{name}"), &format!(".local/bin/{name}")]) {
        return Ok(p);
    }
    // nvm has many node versions — pick the newest that carries the binary.
    if let Ok(home) = std::env::var("HOME") {
        if let Ok(rd) = std::fs::read_dir(std::path::Path::new(&home).join(".nvm/versions/node")) {
            let mut cands: Vec<_> = rd.flatten().map(|e| e.path().join("bin").join(name)).filter(|p| p.is_file()).collect();
            cands.sort();
            if let Some(p) = cands.pop() {
                return Ok(p.to_string_lossy().to_string());
            }
        }
    }
    Err(format!("{name} não encontrado (instala com `npm i -g {name}`)"))
}

/// The newest nvm node's GLOBAL `node_modules`, for `NODE_PATH`. typescript-language-server
/// does `require('typescript')` and does NOT bundle it, so without this it can't find the
/// globally-installed `typescript` and silently answers nothing. (pyright bundles its own.)
/// NOTE: it needs the classic TypeScript 5.x `tsserver.js`; `typescript@7` (the native tsgo
/// preview) ships no tsserver and breaks it — keep the global `typescript` on the 5.x line.
fn node_global_modules() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let rd = std::fs::read_dir(std::path::Path::new(&home).join(".nvm/versions/node")).ok()?;
    let mut cands: Vec<_> = rd
        .flatten()
        .map(|e| e.path().join("lib/node_modules"))
        .filter(|p| p.is_dir())
        .collect();
    cands.sort();
    cands.pop().map(|p| p.to_string_lossy().to_string())
}

/// Resolve the language server command (program + args) for `lang_id`. A human error
/// when the server isn't installed lets the UI tell the student what to add.
fn server_cmd(lang_id: &str) -> Result<(String, Vec<String>), String> {
    match lang_id {
        "rust" => Ok((ra_bin(), vec![])),
        "go" => Ok((gopls_bin()?, vec![])),
        "typescript" => Ok((node_server("typescript-language-server")?, vec!["--stdio".into()])),
        "python" => Ok((node_server("pyright-langserver")?, vec!["--stdio".into()])),
        other => Err(format!("linguagem sem servidor LSP: {other}")),
    }
}

/// PATH augmented with the host's go + node toolchains so spawned servers find their
/// runtimes (gopls needs `go`; the node servers need `node`) regardless of the app's PATH.
fn augmented_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let mut extra = vec!["/usr/local/go/bin".to_string()];
    if let Ok(home) = std::env::var("HOME") {
        extra.push(format!("{home}/go/bin"));
        extra.push(format!("{home}/.nvm/versions/node/v25.0.0/bin"));
    }
    extra.push(base);
    extra.join(":")
}

/// Nearest ancestor directory of `path` holding any of `markers` (the file's project root).
fn project_root_for(path: &str, markers: &[&str]) -> Option<String> {
    let mut dir = std::path::Path::new(path).parent();
    while let Some(d) = dir {
        if markers.iter().any(|m| d.join(m).exists()) {
            return Some(d.to_string_lossy().to_string());
        }
        dir = d.parent();
    }
    None
}

fn path_to_uri(p: &str) -> String {
    let mut s = String::from("file://");
    for ch in p.chars() {
        match ch {
            '/' => s.push('/'),
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => s.push(ch),
            _ => {
                for b in ch.to_string().as_bytes() {
                    s.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    s
}

fn write_msg(stdin: &mut ChildStdin, v: &Value) -> std::io::Result<()> {
    let body = serde_json::to_string(v).unwrap_or_default();
    write!(stdin, "Content-Length: {}\r\n\r\n{}", body.len(), body)?;
    stdin.flush()
}

fn read_message<R: Read>(r: &mut R) -> Option<Value> {
    let mut content_len = 0usize;
    let mut byte = [0u8; 1];
    loop {
        let mut line = Vec::new();
        loop {
            if r.read(&mut byte).ok()? == 0 {
                return None;
            }
            if byte[0] == b'\n' {
                break;
            }
            if byte[0] != b'\r' {
                line.push(byte[0]);
            }
        }
        if line.is_empty() {
            break;
        }
        let s = String::from_utf8_lossy(&line);
        if let Some(v) = s.strip_prefix("Content-Length:") {
            content_len = v.trim().parse().ok()?;
        }
    }
    let mut buf = vec![0u8; content_len];
    r.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn dispatch(session: &Arc<Mutex<Session>>, app: &AppHandle, root: &str, label: &str, msg: Value) {
    if let Some(id) = msg.get("id").and_then(Value::as_i64) {
        if let Some(method) = msg.get("method").and_then(Value::as_str) {
            let result = if method == "workspace/configuration" {
                let n = msg["params"]["items"].as_array().map_or(0, Vec::len);
                Value::Array(vec![Value::Null; n])
            } else {
                Value::Null
            };
            let reply = json!({ "jsonrpc": "2.0", "id": id, "result": result });
            if let Ok(mut g) = session.lock() {
                if let Some(si) = g.stdin.as_mut() {
                    let _ = write_msg(si, &reply);
                }
            }
        } else if let Ok(mut g) = session.lock() {
            if let Some(tx) = g.pending.remove(&id) {
                let _ = tx.send(msg.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    } else if let Some(method) = msg.get("method").and_then(Value::as_str) {
        if method == "textDocument/publishDiagnostics" {
            let _ = app.emit("lsp://diagnostics", msg.get("params").cloned().unwrap_or(Value::Null));
        } else if method == "$/progress" {
            let token = msg["params"]["token"].as_str().unwrap_or("").to_string();
            let v = &msg["params"]["value"];
            let kind = v["kind"].as_str().unwrap_or("");
            let title = v["title"].as_str().unwrap_or("");
            // Surface the server's own indexing progress so the UI can show it (with the
            // server's label, so the pill reads "gopls · …" for Go, "rust-analyzer · …" etc.).
            let _ = app.emit(
                "lsp://status",
                json!({
                    "root": root,
                    "server": label,
                    "kind": kind,
                    "title": title,
                    "message": v["message"].as_str().unwrap_or(""),
                    "percentage": v["percentage"].as_u64(),
                }),
            );
            // The session is READY only when the SYMBOL INDEX is built, NOT on the first
            // `end`: earlier phases (ra's Fetching/CrateGraph/Roots-Scanned, …) finish while
            // find-references / rename still see a partial project — exactly what broke on a
            // fresh open. We match a MEASURED per-server signal (`ready_signal`) against the
            // token OR the work's begin-title (the `end` event carries neither title nor the
            // readable token for gopls), so we remember begin-titles by token to look up here.
            if let Ok(mut g) = session.lock() {
                match kind {
                    "begin" if !title.is_empty() => {
                        g.progress_titles.insert(token.clone(), title.to_string());
                    }
                    "end" => {
                        let begin_title = g.progress_titles.remove(&token).unwrap_or_default();
                        let hay = format!("{} {}", token, begin_title).to_ascii_lowercase();
                        if !g.ready_signal.is_empty() && hay.contains(g.ready_signal) {
                            g.ready = true;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

fn session_request(session: &Arc<Mutex<Session>>, method: &str, params: Value) -> Result<Value, String> {
    let (tx, rx) = channel();
    {
        let mut g = session.lock().map_err(|_| "lsp lock")?;
        g.next_id += 1;
        let id = g.next_id;
        g.pending.insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let si = g.stdin.as_mut().ok_or("lsp not started")?;
        write_msg(si, &msg).map_err(|e| e.to_string())?;
    }
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| format!("lsp timeout: {method}"))
}

fn session_notify(session: &Arc<Mutex<Session>>, method: &str, params: Value) -> Result<(), String> {
    let mut g = session.lock().map_err(|_| "lsp lock")?;
    let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    let si = g.stdin.as_mut().ok_or("lsp not started")?;
    write_msg(si, &msg).map_err(|e| e.to_string())
}

fn is_ready(session: &Arc<Mutex<Session>>) -> bool {
    session.lock().map(|g| g.ready).unwrap_or(false)
}

/// Block (bounded) until rust-analyzer finished its first indexing pass. Runs only on a
/// blocking task, never the UI thread.
fn wait_ready(session: &Arc<Mutex<Session>>, budget: Duration) {
    let start = Instant::now();
    while !is_ready(session) && start.elapsed() < budget {
        thread::sleep(Duration::from_millis(150));
    }
}

fn capabilities() -> Value {
    json!({
        "textDocument": {
            "synchronization": { "didSave": false, "dynamicRegistration": false },
            "definition": { "linkSupport": true },
            "references": {},
            "hover": { "contentFormat": ["markdown", "plaintext"] },
            "rename": { "prepareSupport": true },
            "publishDiagnostics": { "relatedInformation": true }
        },
        // `window.workDoneProgress` is MANDATORY for server-initiated progress: without it
        // rust-analyzer (per the LSP spec) never sends the `$/progress` stream for indexing.
        // That would both hide the progress pill AND — because `ready` only flips on a
        // `$/progress` "end" — leave the session permanently "not ready", disabling hover /
        // prepareRename and forcing every navigation to burn the full `wait_ready` budget.
        "window": { "workDoneProgress": true },
        "workspace": { "workspaceEdit": { "documentChanges": true }, "configuration": true }
    })
}

/// Get the session for `key` (languageId + root), starting and initializing the resolved
/// server at `root` if needed. `program`/`args` come from `server_cmd`. Blocking.
fn get_or_start(map: &SessionMap, app: &AppHandle, key: &str, root: &str, lang: &Lang, program: &str, args: &[String]) -> Result<Arc<Mutex<Session>>, String> {
    {
        let m = map.lock().map_err(|_| "lsp map lock")?;
        if let Some(s) = m.get(key) {
            return Ok(s.clone());
        }
    }
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("PATH", augmented_path()) // so gopls finds `go`, the node servers find `node`
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(nm) = node_global_modules() {
        cmd.env("NODE_PATH", nm); // so typescript-language-server can require('typescript')
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", lang.server_label))?;
    let stdin = child.stdin.take().ok_or("lsp server: no stdin")?;
    let stdout = child.stdout.take().ok_or("lsp server: no stdout")?;
    let session = Arc::new(Mutex::new(Session {
        child: Some(child),
        stdin: Some(stdin),
        next_id: 0,
        pending: HashMap::new(),
        open: HashSet::new(),
        ready: false,
        label: lang.server_label,
        ready_signal: lang.ready_signal,
        progress_titles: HashMap::new(),
    }));
    {
        let mut m = map.lock().map_err(|_| "lsp map lock")?;
        if let Some(existing) = m.get(key) {
            if let Ok(mut g) = session.lock() {
                if let Some(mut c) = g.child.take() {
                    let _ = c.kill();
                }
            }
            return Ok(existing.clone());
        }
        m.insert(key.to_string(), session.clone());
    }
    let rsession = session.clone();
    let rapp = app.clone();
    let rroot = root.to_string();
    let rlabel = lang.server_label.to_string();
    thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        while let Some(msg) = read_message(&mut r) {
            dispatch(&rsession, &rapp, &rroot, &rlabel, msg);
        }
    });
    let uri = path_to_uri(root);
    session_request(
        &session,
        "initialize",
        json!({
            "processId": null,
            "rootUri": uri,
            "workspaceFolders": [{ "uri": uri, "name": "root" }],
            "capabilities": capabilities()
        }),
    )?;
    session_notify(&session, "initialized", json!({}))?;
    // Servers with no end-of-index `$/progress` (empty `ready_signal`, e.g. pyright) answer
    // immediately — mark them ready now so navigation doesn't burn the full `wait_ready`.
    if lang.ready_signal.is_empty() {
        if let Ok(mut g) = session.lock() {
            g.ready = true;
        }
    }
    Ok(session)
}

/// Resolve the session a file belongs to: its language (by extension), its project root
/// (nearest marker), and the server for that language — starting it if needed. Blocking.
/// `None` when the file's extension is unsupported, no project root is found, or the
/// language's server is not installed (the UI then falls back to the intra-file heuristic).
fn session_for(map: &SessionMap, app: &AppHandle, path: &str) -> Result<Option<Arc<Mutex<Session>>>, String> {
    let Some(lang) = lang_for_path(path) else { return Ok(None); };
    let Some(root) = project_root_for(path, lang.markers) else { return Ok(None); };
    let (program, args) = match server_cmd(lang.id) {
        Ok(c) => c,
        Err(_) => return Ok(None), // server not installed → no session; frontend falls back
    };
    let key = format!("{}\u{0}{}", lang.id, root);
    Ok(Some(get_or_start(map, app, &key, &root, lang, &program, &args)?))
}

fn pos(path: &str, line: u32, character: u32) -> Value {
    json!({ "textDocument": { "uri": path_to_uri(path) }, "position": { "line": line, "character": character } })
}

/// A semantic request that distinguishes "ready but nothing here" from "still indexing".
/// Empty while NOT ready → `{ "indexing": true }` so the UI says "wait" not "no definition".
fn semantic(session: &Arc<Mutex<Session>>, method: &str, params: Value) -> Result<Value, String> {
    wait_ready(session, Duration::from_secs(20));
    let ready = is_ready(session);
    let res = session_request(session, method, params)?;
    let empty = res.is_null() || res.as_array().is_some_and(|a| a.is_empty());
    if empty && !ready {
        return Ok(json!({ "indexing": true }));
    }
    Ok(res)
}

// ── Commands — all async: the blocking work runs on spawn_blocking, off the UI thread. ──

#[tauri::command]
pub async fn lsp_start(app: AppHandle, state: State<'_, LspState>, root: String) -> Result<(), String> {
    let map = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // Warm up every language whose project marker sits AT the opened folder, so the
        // (possibly minutes-long) first index starts before the student navigates.
        for lang in LANGS {
            if lang.markers.iter().any(|m| std::path::Path::new(&root).join(m).exists()) {
                if let Ok((program, args)) = server_cmd(lang.id) {
                    let key = format!("{}\u{0}{}", lang.id, root);
                    let _ = get_or_start(&map, &app, &key, &root, lang, &program, &args);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_did_open(app: AppHandle, state: State<'_, LspState>, path: String, text: String, language_id: String) -> Result<(), String> {
    let map = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let Some(session) = session_for(&map, &app, &path)? else { return Ok(()); };
        let uri = path_to_uri(&path);
        {
            let mut g = session.lock().map_err(|_| "lsp lock")?;
            if !g.open.insert(uri.clone()) {
                return Ok(());
            }
        }
        session_notify(
            &session,
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": uri, "languageId": language_id, "version": 1, "text": text } }),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_did_change(app: AppHandle, state: State<'_, LspState>, path: String, text: String, version: i64) -> Result<(), String> {
    let map = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let Some(session) = session_for(&map, &app, &path)? else { return Ok(()); };
        let uri = path_to_uri(&path);
        session_notify(
            &session,
            "textDocument/didChange",
            json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": [{ "text": text }] }),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_definition(app: AppHandle, state: State<'_, LspState>, path: String, line: u32, character: u32) -> Result<Value, String> {
    let map = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let Some(session) = session_for(&map, &app, &path)? else { return Ok(Value::Null); };
        semantic(&session, "textDocument/definition", pos(&path, line, character))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_references(app: AppHandle, state: State<'_, LspState>, path: String, line: u32, character: u32) -> Result<Value, String> {
    let map = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let Some(session) = session_for(&map, &app, &path)? else { return Ok(Value::Null); };
        let mut p = pos(&path, line, character);
        p["context"] = json!({ "includeDeclaration": true });
        semantic(&session, "textDocument/references", p)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_hover(app: AppHandle, state: State<'_, LspState>, path: String, line: u32, character: u32) -> Result<Value, String> {
    let map = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let Some(session) = session_for(&map, &app, &path)? else { return Ok(Value::Null); };
        // Hover fires continuously — NEVER block on readiness: always ask the server and let
        // it answer (it returns null fast while still indexing). Gating on `ready` here was a
        // bug: a server whose end-of-index signal we don't yet recognise would never hover.
        session_request(&session, "textDocument/hover", pos(&path, line, character))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_rename(app: AppHandle, state: State<'_, LspState>, path: String, line: u32, character: u32, new_name: String) -> Result<Value, String> {
    let map = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let Some(session) = session_for(&map, &app, &path)? else { return Ok(Value::Null); };
        let mut p = pos(&path, line, character);
        p["newName"] = json!(new_name);
        semantic(&session, "textDocument/rename", p)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_prepare_rename(app: AppHandle, state: State<'_, LspState>, path: String, line: u32, character: u32) -> Result<Value, String> {
    let map = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let Some(session) = session_for(&map, &app, &path)? else { return Ok(Value::Null); };
        session_request(&session, "textDocument/prepareRename", pos(&path, line, character))
    })
    .await
    .map_err(|e| e.to_string())?
}
