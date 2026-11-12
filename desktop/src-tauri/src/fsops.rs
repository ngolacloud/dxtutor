//! IDE/Workspace mode — native folder dialog, filesystem commands and a
//! project/file runner.
//!
//! These power the Explorer and "Run" of the real-projects mode (distinct from
//! the guided drills). Everything returns `Result<_, String>` (or `Option`) and
//! never panics; paths are absolute. The runner reuses the project's hardening
//! shape — its own process group (`setsid`) so a wall-clock timeout can kill the
//! whole tree, with stdout/stderr spooled to temp files to avoid pipe-buffer
//! deadlocks. This is the user's OWN project, so there is no strict sandbox like
//! the drills — but it must never hang: timeout + kill.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// One directory entry shown in the Explorer. `path` is absolute.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDto {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Internal run outcome. The `run_path` command in `main.rs` maps this onto the
/// existing `RunDto { ok, stdout, stderr }` (reused, per the frontend contract).
pub struct RunResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Directory names hidden from the Explorer by default: VCS metadata and the
/// huge build/dependency trees that only add noise.
const HIDDEN_DIRS: &[&str] = &[".git", "target", "node_modules"];

/// Wall-clock cap for a single run. The user's project may be slow to build, so
/// this is generous; it only exists so nothing hangs forever.
const RUN_TIMEOUT: Duration = Duration::from_secs(120);

/// How often the guard polls the child while waiting.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

// ── Native folder dialog ──────────────────────────────────────────────────────

/// Open the native "pick a folder" dialog and return the chosen absolute path,
/// or `None` if the user cancels. Runs on a Tauri command worker thread (not the
/// main thread), which is exactly where the blocking dialog API is meant to run.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    // Use the NON-blocking dialog API. `blocking_pick_folder()` blocks the calling
    // thread while the GTK dialog needs the main (UI) thread, which froze the whole
    // window on Linux. Here the dialog is dispatched to the UI event loop and the
    // result comes back through a channel we await — the UI never blocks.
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog().file().pick_folder(move |path| {
        // Runs on the UI thread when the dialog closes; forward the choice.
        let _ = tx.blocking_send(path);
    });
    rx.recv()
        .await
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

// ── Filesystem commands ────────────────────────────────────────────────────────

/// List a single directory layer. Per-entry errors are skipped (never abort the
/// whole listing); directories come first, then alphabetical (case-insensitive).
/// `.git`, `target` and `node_modules` are hidden by default.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<EntryDto>, String> {
    let rd = fs::read_dir(&path).map_err(|e| format!("cannot read `{path}`: {e}"))?;
    let mut entries: Vec<EntryDto> = Vec::new();
    for item in rd {
        // Ignore entries we cannot even stat, rather than failing the listing.
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().to_string();
        if HIDDEN_DIRS.contains(&name.as_str()) {
            continue;
        }
        let Ok(ft) = item.file_type() else { continue };
        entries.push(EntryDto {
            name,
            path: item.path().to_string_lossy().to_string(),
            is_dir: ft.is_dir(),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Read a UTF-8 (lossy-free) text file in full.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("cannot read `{path}`: {e}"))
}

/// Overwrite (or create) a text file with `contents`.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("cannot write `{path}`: {e}"))
}

/// Create an empty file or a directory. Parent directories are created as needed.
/// Creating a file that already exists is an error (avoids clobbering).
#[tauri::command]
pub fn create_path(path: String, is_dir: bool) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if is_dir {
        return fs::create_dir_all(&p).map_err(|e| format!("cannot create dir `{path}`: {e}"));
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create parent of `{path}`: {e}"))?;
        }
    }
    if p.exists() {
        return Err(format!("`{path}` already exists"));
    }
    fs::File::create(&p)
        .map(|_| ())
        .map_err(|e| format!("cannot create `{path}`: {e}"))
}

/// Delete a file or a directory (recursively for directories).
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let meta = fs::symlink_metadata(&p).map_err(|e| format!("cannot stat `{path}`: {e}"))?;
    if meta.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| format!("cannot delete dir `{path}`: {e}"))
    } else {
        fs::remove_file(&p).map_err(|e| format!("cannot delete `{path}`: {e}"))
    }
}

/// Rename or move a path.
#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    fs::rename(&from, &to).map_err(|e| format!("cannot rename `{from}` -> `{to}`: {e}"))
}

// ── Project / file runner ───────────────────────────────────────────────────────

/// Run a file or project and return its captured output. Called by the
/// `run_path` command. Runner selection:
/// - `.rs`: if a `Cargo.toml` sits in the file's folder or any parent, run
///   `cargo run` from that root; otherwise `rustc <file> -o <tmp>` then the
///   produced binary.
/// - `.py`: `python3 <file>`.
/// - anything else: a `RunResult` whose stderr carries the honest note.
pub fn run_file(path: &str) -> Result<RunResult, String> {
    let file = PathBuf::from(path);
    if !file.is_file() {
        return Err(format!("`{path}` is not a file"));
    }
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Engine != Host ⇒ corre o ficheiro dentro do container da sua linguagem
    // (reusa `image_for` + a infra de container do avaliador). Host mantém-se exacto.
    if tutor_eval::current_engine() != tutor_eval::SandboxEngine::Host {
        return run_file_container(&file, &ext);
    }

    match ext.as_str() {
        "rs" => run_rust(&file),
        "go" => run_go(&file),
        "py" => {
            let mut cmd = Command::new("python3");
            cmd.arg(&file);
            if let Some(dir) = file.parent() {
                cmd.current_dir(dir);
            }
            run_guarded(cmd)
        }
        _ => Ok(RunResult {
            ok: false,
            stdout: String::new(),
            stderr: "no runner for this file type".to_string(),
        }),
    }
}

/// Locate the `go` binary: the standard Linux install path first, then the PATH.
fn go_bin() -> String {
    let p = "/usr/local/go/bin/go";
    if Path::new(p).is_file() {
        p.to_string()
    } else {
        "go".to_string()
    }
}

/// Walk up from `start` looking for the nearest `go.mod`; its directory is the
/// module root.
fn go_mod_root(start: &Path) -> Option<PathBuf> {
    let mut cur = start.to_path_buf();
    loop {
        if cur.join("go.mod").is_file() {
            return Some(cur);
        }
        if !cur.pop() {
            return None;
        }
    }
}

/// Run a `.go` file on the host: inside a module (`go run .` from the file's
/// package dir) or standalone (`go run <file>`). `GOTOOLCHAIN=local` keeps Go from
/// trying to download a different toolchain.
fn run_go(file: &Path) -> Result<RunResult, String> {
    let dir = file.parent().unwrap_or_else(|| Path::new("."));
    let mut cmd = Command::new(go_bin());
    cmd.env("GOTOOLCHAIN", "local").current_dir(dir);
    if go_mod_root(dir).is_some() {
        cmd.arg("run").arg(".");
    } else {
        cmd.arg("run").arg(file);
    }
    run_guarded(cmd)
}

/// Container timeout for running a user project/file (generous; a cold cargo build
/// inside a fresh container can be slow). Only exists so nothing hangs forever.
const CONTAINER_RUN_TIMEOUT: Duration = Duration::from_secs(300);

/// Run the file inside a container of its language (chosen by extension), mounting
/// the right working directory at `/work`:
/// - `.py`: mount the file's folder; `python3 <basename>`.
/// - `.rs` inside a Cargo project: mount the project root; `cargo run`.
/// - `.rs` standalone: mount the file's folder; `sh -c "rustc <file> -o … && …"`.
///
/// Network is on for the Rust paths (so `cargo add`/registry work) with the shared
/// `dxtutor-cargo` cache volume; off for Python. Maps `RunOutput` onto `RunResult`.
fn run_file_container(file: &Path, ext: &str) -> Result<RunResult, String> {
    use tutor_eval::{cache_volumes_for, image_for, run_in_container, ContainerSpec};

    let map = |r: tutor_eval::RunOutput| RunResult {
        ok: r.ok,
        stdout: r.stdout,
        stderr: r.stderr,
    };

    let spec = match ext {
        "py" => {
            let dir = file.parent().unwrap_or_else(|| Path::new("."));
            let name = file
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("main.py");
            let image = image_for("python").ok_or("no python image configured")?;
            let mut s = ContainerSpec::new(image, dir, vec!["python3".into(), name.into()]);
            s.timeout = CONTAINER_RUN_TIMEOUT;
            s
        }
        "rs" => {
            let image = image_for("rust").ok_or("no rust image configured")?;
            let start = file.parent().unwrap_or_else(|| Path::new("."));
            if let Some(root) = cargo_root(start) {
                // Inside a Cargo project: mount the root and `cargo run`.
                let mut s =
                    ContainerSpec::new(image, root, vec!["cargo".into(), "run".into()]);
                s.timeout = CONTAINER_RUN_TIMEOUT;
                s.cache_volumes = cache_volumes_for("rust");
                s.network = true;
                s
            } else {
                // Standalone single file: rustc then run the produced binary.
                let name = file
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("main.rs");
                let script = format!(
                    "rustc {name} -o /tmp/dxtutor-prog && /tmp/dxtutor-prog",
                    name = shell_single_quote(name)
                );
                let mut s = ContainerSpec::new(
                    image,
                    start,
                    vec!["sh".into(), "-c".into(), script],
                );
                s.timeout = CONTAINER_RUN_TIMEOUT;
                s.cache_volumes = cache_volumes_for("rust");
                s.network = true;
                s
            }
        }
        "go" => {
            let image = image_for("go").ok_or("no go image configured")?;
            let start = file.parent().unwrap_or_else(|| Path::new("."));
            let (mount, cmd) = if let Some(root) = go_mod_root(start) {
                // Inside a module: mount the package dir and `go run .`.
                (root, vec!["go".into(), "run".into(), ".".into()])
            } else {
                // Standalone single file: `go run <basename>`.
                let name = file
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("main.go");
                (
                    start.to_path_buf(),
                    vec!["go".into(), "run".into(), name.into()],
                )
            };
            let mut s = ContainerSpec::new(image, &mount, cmd);
            s.timeout = CONTAINER_RUN_TIMEOUT;
            s.cache_volumes = cache_volumes_for("go");
            s.network = true; // let `go run` fetch modules via `go mod tidy`
            s
        }
        _ => {
            return Ok(RunResult {
                ok: false,
                stdout: String::new(),
                stderr: "no runner for this file type".to_string(),
            })
        }
    };

    run_in_container(spec)
        .map(map)
        .map_err(|e| format!("container run failed: {e}"))
}

/// Single-quote a string for safe interpolation into a `sh -c` command.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Run a `.rs` file: inside a Cargo project (`cargo run` from the root) or, when
/// standalone, compile with `rustc` into a temp binary and execute it.
fn run_rust(file: &Path) -> Result<RunResult, String> {
    let start = file.parent().unwrap_or_else(|| Path::new("."));
    if let Some(root) = cargo_root(start) {
        let mut cmd = Command::new("cargo");
        cmd.arg("run").current_dir(&root);
        return run_guarded(cmd);
    }

    // Standalone single file: rustc then run the produced binary.
    let bin = std::env::temp_dir().join(format!("dxtutor-rs-{}", unique_stamp()));
    let mut rc = Command::new("rustc");
    rc.arg(file).arg("-o").arg(&bin);
    if let Some(dir) = file.parent() {
        rc.current_dir(dir);
    }
    let compiled = run_guarded(rc)?;
    if !compiled.ok {
        // Compilation failed — surface the compiler's errors as the run output.
        return Ok(compiled);
    }

    let mut run = Command::new(&bin);
    if let Some(dir) = file.parent() {
        run.current_dir(dir);
    }
    let result = run_guarded(run);
    let _ = fs::remove_file(&bin);
    result
}

/// Walk up from `start` looking for the nearest `Cargo.toml`; its directory is
/// the project root to run from.
fn cargo_root(start: &Path) -> Option<PathBuf> {
    let mut cur = start.to_path_buf();
    loop {
        if cur.join("Cargo.toml").is_file() {
            return Some(cur);
        }
        match cur.parent() {
            Some(parent) => cur = parent.to_path_buf(),
            None => return None,
        }
    }
}

/// Run `cmd` with its own process group, stdout/stderr spooled to temp files
/// (avoids pipe-buffer deadlocks on chatty programs), and a wall-clock timeout.
/// On timeout the whole group is killed with SIGKILL so nothing is left hanging.
fn run_guarded(mut cmd: Command) -> Result<RunResult, String> {
    let stamp = unique_stamp();
    let tmp = std::env::temp_dir();
    let out_path = tmp.join(format!("dxtutor-run-{stamp}.out"));
    let err_path = tmp.join(format!("dxtutor-run-{stamp}.err"));
    let out_file = fs::File::create(&out_path).map_err(|e| format!("temp stdout: {e}"))?;
    let err_file = fs::File::create(&err_path).map_err(|e| format!("temp stderr: {e}"))?;

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::from(out_file));
    cmd.stderr(Stdio::from(err_file));

    // Own session/process group so the timeout can abate the whole tree.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    libc::setpgid(0, 0);
                }
                Ok(())
            });
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("failed to start: {e}"))?;
    #[cfg(unix)]
    let pid = child.id() as libc::pid_t;
    let deadline = Instant::now() + RUN_TIMEOUT;

    let (timed_out, status) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (false, Some(status)),
            Ok(None) => {
                if Instant::now() >= deadline {
                    #[cfg(unix)]
                    unsafe {
                        libc::killpg(pid, libc::SIGKILL);
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    break (true, None);
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    };

    let stdout = read_lossy(&out_path);
    let mut stderr = read_lossy(&err_path);
    let _ = fs::remove_file(&out_path);
    let _ = fs::remove_file(&err_path);

    let ok = if timed_out {
        if !stderr.is_empty() {
            stderr.push('\n');
        }
        stderr.push_str(&format!(
            "[killed: exceeded {}s wall-clock timeout]",
            RUN_TIMEOUT.as_secs()
        ));
        false
    } else {
        status.map(|s| s.success()).unwrap_or(false)
    };

    Ok(RunResult { ok, stdout, stderr })
}

/// Read a file as text, tolerant of invalid UTF-8 (never fails).
fn read_lossy(path: &Path) -> String {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        Err(_) => String::new(),
    }
}

/// A process-unique, time-based stamp for temp artifact names.
fn unique_stamp() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), nanos)
}

// ── Workspace context + controlled actions (Dev Assistant) ───────────────────────

/// Resolve `rel` (relative, or absolute-under-root) against `root` and REFUSE anything
/// that escapes the workspace. This is the containment guard for assistant-driven file
/// actions: the assistant can only touch the open project, never `../` or `/etc`.
/// Lexical normalization (no symlink following, works for not-yet-existing paths).
fn contained_path(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root);
    if !root.is_absolute() {
        return Err("workspace root must be an absolute path".into());
    }
    // Accept an absolute path only if it is already under root; otherwise treat as relative.
    let candidate = {
        let r = Path::new(rel);
        if r.is_absolute() {
            r.to_path_buf()
        } else {
            root.join(rel)
        }
    };
    // Normalize lexically: resolve `.` and `..` without hitting the filesystem.
    let mut out = PathBuf::new();
    for comp in candidate.components() {
        use std::path::Component::*;
        match comp {
            ParentDir => {
                if !out.pop() {
                    return Err("path escapes the workspace".into());
                }
            }
            CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    if out == root || out.starts_with(&root) {
        Ok(out)
    } else {
        Err("path escapes the workspace".into())
    }
}

/// A compact text tree of the workspace (depth-limited, heavy dirs skipped, capped),
/// used to GROUND the Dev Assistant in the real, active project instead of answering
/// as a generic chat. Directories first, then files, each line indented by depth.
#[tauri::command]
pub fn workspace_tree(root: String, max_depth: u32, max_entries: u32) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("`{root}` is not a folder"));
    }
    let mut out = String::new();
    let mut count = 0u32;
    walk_tree(&root_path, 0, max_depth, max_entries, &mut count, &mut out);
    if count >= max_entries {
        out.push_str("… (truncated)\n");
    }
    Ok(out)
}

fn walk_tree(dir: &Path, depth: u32, max_depth: u32, cap: u32, count: &mut u32, out: &mut String) {
    if depth > max_depth || *count >= cap {
        return;
    }
    let mut entries: Vec<_> = match fs::read_dir(dir) {
        Ok(rd) => rd.flatten().collect(),
        Err(_) => return,
    };
    // Directories first, then files; each alphabetical — a stable, readable tree.
    entries.sort_by_key(|e| {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, e.file_name())
    });
    for e in entries {
        if *count >= cap {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".github" && name != ".ai" {
            continue; // hide dotfiles/dirs except a couple that matter for context
        }
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && HIDDEN_DIRS.contains(&name.as_str()) {
            out.push_str(&format!("{}{}/  (skipped)\n", "  ".repeat(depth as usize), name));
            continue;
        }
        *count += 1;
        out.push_str(&format!(
            "{}{}{}\n",
            "  ".repeat(depth as usize),
            name,
            if is_dir { "/" } else { "" }
        ));
        if is_dir {
            walk_tree(&e.path(), depth + 1, max_depth, cap, count, out);
        }
    }
}

/// Resolve `path` (relative, or absolute-under-root) to an absolute path STRICTLY inside
/// the workspace `root`, or an error if it escapes. The Dev delegate calls this before
/// opening/streaming into a model-proposed file, so a `../` in a `dxcode` can never read
/// or write outside the project.
#[tauri::command]
pub fn workspace_resolve(root: String, path: String) -> Result<String, String> {
    contained_path(&root, &path).map(|p| p.to_string_lossy().to_string())
}

/// Perform a controlled, user-approved filesystem action from the Dev Assistant, STRICTLY
/// inside the open workspace. `op` is "createDir" | "createFile" | "writeFile"; `path` is
/// relative to `root` (an absolute path is accepted only if it is already under root).
/// Returns the absolute path acted on. The containment guard refuses any `../` escape.
#[tauri::command]
pub fn workspace_action(
    root: String,
    op: String,
    path: String,
    content: Option<String>,
) -> Result<String, String> {
    let target = contained_path(&root, &path)?;
    match op.as_str() {
        "createDir" => {
            fs::create_dir_all(&target).map_err(|e| format!("cannot create dir: {e}"))?;
        }
        "createFile" => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("cannot create parent: {e}"))?;
            }
            if target.exists() {
                return Err(format!("`{}` already exists", target.display()));
            }
            fs::write(&target, content.unwrap_or_default())
                .map_err(|e| format!("cannot create file: {e}"))?;
        }
        "writeFile" => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("cannot create parent: {e}"))?;
            }
            fs::write(&target, content.unwrap_or_default())
                .map_err(|e| format!("cannot write file: {e}"))?;
        }
        other => return Err(format!("unknown workspace action `{other}`")),
    }
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contained_path_accepts_inside_and_refuses_escape() {
        let root = if cfg!(windows) { "C:\\ws" } else { "/home/u/ws" };
        // inside
        assert!(contained_path(root, "examples/dxtutor").is_ok());
        assert_eq!(
            contained_path(root, "examples/dxtutor").unwrap(),
            PathBuf::from(root).join("examples").join("dxtutor")
        );
        // the exact root is allowed
        assert!(contained_path(root, ".").is_ok());
        // escapes are refused
        assert!(contained_path(root, "../secrets").is_err());
        assert!(contained_path(root, "examples/../../etc/passwd").is_err());
        let outside = if cfg!(windows) { "C:\\other" } else { "/etc/passwd" };
        assert!(contained_path(root, outside).is_err());
    }

    #[test]
    fn workspace_action_creates_dir_and_file_then_refuses_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        let made = workspace_action(root.clone(), "createDir".into(), "examples/dxtutor".into(), None)
            .expect("createDir");
        assert!(PathBuf::from(&made).is_dir());

        let f = workspace_action(
            root.clone(),
            "createFile".into(),
            "examples/dxtutor/notes.md".into(),
            Some("hello".into()),
        )
        .expect("createFile");
        assert_eq!(fs::read_to_string(&f).unwrap(), "hello");

        // escape is refused — nothing is written outside the workspace
        assert!(workspace_action(root, "createDir".into(), "../evil".into(), None).is_err());
    }

    #[test]
    fn workspace_resolve_contains_the_dev_delegate_target() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        // A normal dxcode target resolves under the root.
        let ok = workspace_resolve(root.clone(), "examples/dxtutor/main.rs".into()).unwrap();
        assert!(ok.starts_with(tmp.path().to_string_lossy().as_ref()));
        // A `../` escape is refused — the Dev delegate can never open/stream outside.
        assert!(workspace_resolve(root, "../../etc/passwd".into()).is_err());
    }

    #[test]
    fn workspace_tree_lists_real_files_and_skips_heavy_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("examples")).unwrap();
        fs::write(root.join("examples/main.rs"), "fn main() {}").unwrap();
        fs::create_dir_all(root.join("target/debug")).unwrap();
        fs::write(root.join("target/debug/junk"), "x").unwrap();

        let tree = workspace_tree(root.to_string_lossy().to_string(), 2, 100).unwrap();
        assert!(tree.contains("examples/"), "tree: {tree}");
        assert!(tree.contains("main.rs"), "tree: {tree}");
        // the build dir is named but NOT walked into
        assert!(tree.contains("target/  (skipped)"), "tree: {tree}");
        assert!(!tree.contains("junk"), "heavy dir must be skipped: {tree}");
    }
}
