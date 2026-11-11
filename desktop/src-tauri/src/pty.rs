//! Real PTY bridge: an embedded xterm.js terminal talking to a live `bash`.
//!
//! The master side of a pseudo-terminal is opened with `portable-pty`; a reader
//! thread streams its bytes to the webview as `pty://data` events, and the
//! frontend sends keystrokes back through the `pty_write` command. Resize is
//! forwarded with `pty_resize`. This is a genuine interactive shell, not a
//! one-shot command runner.

use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

/// A live PTY session. The master is kept for resizing; the writer feeds
/// keystrokes to the shell; the child handle keeps the process owned.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Tauri-managed state holding at most one shell session.
#[derive(Default)]
pub struct PtyState(Mutex<Option<Session>>);

/// Spawn an interactive `bash` attached to a fresh PTY and start streaming its
/// output. Re-spawning replaces any previous session.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // Interactive login-ish shell with a sane TERM and the user's HOME as cwd.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawning shell failed: {e}"))?;
    // The slave is owned by the child now; dropping our handle avoids a deadlock
    // where the master never sees EOF.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("cloning pty reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("taking pty writer failed: {e}"))?;

    // Reader thread: pump PTY bytes to the webview until EOF.
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_for_thread.emit("pty://data", chunk);
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit("pty://exit", 0i32);
    });

    *state.0.lock().unwrap() = Some(Session {
        master: pair.master,
        writer,
        child,
    });
    Ok(())
}

/// Forward keystrokes (or pasted text) from xterm to the shell.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(session) = guard.as_mut() {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("pty write failed: {e}"))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("pty flush failed: {e}"))?;
        Ok(())
    } else {
        Err("no active shell".into())
    }
}

/// Resize the PTY when the terminal pane changes size.
#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, rows: u16, cols: u16) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    if let Some(session) = guard.as_ref() {
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize failed: {e}"))?;
    }
    Ok(())
}

impl Drop for Session {
    fn drop(&mut self) {
        // Best-effort: ask the shell to exit when the session is replaced/closed.
        let _ = self.child.kill();
    }
}
