// shell/terminal.ts — Fase 2 (paridade): terminal real (PTY) no painel inferior.
//
// Liga ao backend REAL: pty_spawn abre uma shell de login, os bytes chegam como
// eventos `pty://data`, o input vai por pty_write e o redimensionamento por
// pty_resize. Usa xterm.js. Sem simulação.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setTerminalClearHandler } from "./index";
import { onThemeChange, currentTheme } from "./theme";

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let spawned = false;

function theme(): import("@xterm/xterm").ITheme {
  const light = currentTheme() === "Papel claro";
  return light
    ? { background: "#fbfaf6", foreground: "#1d1c1a", cursor: "#c8562a", selectionBackground: "#dcd8cc" }
    : { background: "#161618", foreground: "#d6d6d9", cursor: "#f08a4b", selectionBackground: "#2a2a30" };
}

async function resizePty(): Promise<void> {
  if (!term) return;
  try { await invoke("pty_resize", { rows: term.rows, cols: term.cols }); } catch { /* backend ausente */ }
}

export function initTerminal(): void {
  const host = document.getElementById("term");
  if (!host) return;
  host.innerHTML = "";
  term = new Terminal({
    fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
    fontSize: 12.5, cursorBlink: true, theme: theme(), convertEol: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try { fit.fit(); } catch { /* host ainda sem tamanho */ }

  term.onData((d) => { void invoke("pty_write", { data: d }).catch(() => { /* backend ausente */ }); });

  void listen<string>("pty://data", (e) => { term?.write(e.payload); }).catch(() => { /* backend ausente */ });
  void listen<number>("pty://exit", () => { term?.write("\r\n\x1b[90m[process exited — reabrir o terminal para reiniciar]\x1b[0m\r\n"); spawned = false; }).catch(() => { /* backend ausente */ });

  // Re-fit (e re-resize do PTY) quando o painel muda de tamanho/visibilidade.
  const ro = new ResizeObserver(() => {
    if (!term || !fit) return;
    try { fit.fit(); } catch { /* */ }
    void resizePty();
  });
  ro.observe(host);

  onThemeChange(() => { if (term) term.options.theme = theme(); });

  // O botão «limpar terminal» da casca passa a limpar o xterm real.
  setTerminalClearHandler(() => term?.clear());

  spawnShell();
}

async function spawnShell(): Promise<void> {
  if (spawned || !term) return;
  spawned = true;
  try {
    await invoke("pty_spawn", { rows: term.rows, cols: term.cols });
  } catch (e) {
    spawned = false;
    term.write(`\x1b[31mNão foi possível abrir o terminal: ${String(e)}\x1b[0m\r\n`);
  }
}
