// theme.ts — os 3 temas da casca e a sua aplicação/persistência.
//
// Portado de docs/prototype/index.html (THEMES/setTheme). Cada tema é um mapa de
// overrides de variáveis CSS aplicado em document.documentElement.style; o tema
// base ("Grafite laranja") é o :root de shell.css, logo o seu mapa é vazio.
// Persistido em localStorage sob "dxtutor.theme".

export type ThemeName = "Grafite laranja" | "Slate índigo" | "Papel claro";

export const THEMES: Record<string, Record<string, string>> = {
  "Grafite laranja": {},
  "Slate índigo": {
    "--accent": "#6d7cff", "--accent-hover": "#8f9bff",
    "--accent-grad": "linear-gradient(135deg,#6d7cff,#8f9bff)",
    "--accent-soft": "rgba(109,124,255,.14)", "--sh-acc": "0 4px 14px rgba(109,124,255,.3)",
    "--bg-base": "#0e1016", "--bg-editor": "#141722", "--bg-elevated": "#191d2a",
    "--bg-side": "#161a26", "--bg-activity": "#11141d", "--bg-title": "#11141d",
    "--bg-status": "#11141d", "--bg-panel": "#141722", "--bg-tab-inactive": "#161a26",
    "--bg-input": "#1e2331", "--bg-hover": "#232939", "--bg-sel": "#2a3145",
    "--bg-sel-inactive": "#252b3c", "--bg-menu": "#1a1f2c", "--border": "#272d3d",
    "--border-strong": "#343b50", "--seam": "#1e2331", "--guide": "#2c3346",
  },
  "Papel claro": {
    "--bg-base": "#f4f2ec", "--bg-editor": "#fbfaf6", "--bg-elevated": "#f6f4ee",
    "--bg-side": "#efede6", "--bg-activity": "#e9e6de", "--bg-title": "#e9e6de",
    "--bg-status": "#e9e6de", "--bg-panel": "#fbfaf6", "--bg-tab-inactive": "#efede6",
    "--bg-input": "#ffffff", "--bg-hover": "#e6e3da", "--bg-sel": "#dcd8cc",
    "--bg-sel-inactive": "#e3e0d6", "--bg-menu": "#ffffff", "--border": "#dcd8cc",
    "--border-strong": "#c9c4b6", "--seam": "#e2dfd5", "--guide": "#d6d2c6",
    "--fg": "#1d1c1a", "--fg-dim": "#5f5d57", "--fg-muted": "#86837b", "--fg-bright": "#000000",
    "--accent": "#c8562a", "--accent-hover": "#b84a20", "--purple": "#8b3fc0",
    "--blue": "#1f6fd6", "--cyan": "#0f7f8c", "--green": "#1e8a63", "--git-u": "#1e8a63",
    "--git-m": "#a66a00", "--git-d": "#c8323f", "--red": "#c8323f", "--yellow": "#9a7400",
    "--folder": "#7a7669",
    "--sh-card": "0 1px 2px rgba(0,0,0,.06),0 6px 18px rgba(0,0,0,.06)",
    "--sh-pop": "0 10px 30px rgba(0,0,0,.18)",
  },
};

const STORE_KEY = "dxtutor.theme";
let current: string = "Grafite laranja";
const listeners: Array<(n: string) => void> = [];

export function currentTheme(): string {
  return current;
}

export function onThemeChange(cb: (n: string) => void): void {
  listeners.push(cb);
}

/** Aplica o tema `n`, persiste-o e notifica os ouvintes. */
export function setTheme(n: string): void {
  const r = document.documentElement.style;
  // Limpa todas as chaves de todos os temas antes de aplicar o escolhido.
  Object.values(THEMES).forEach((t) => Object.keys(t).forEach((k) => r.removeProperty(k)));
  Object.entries(THEMES[n] || {}).forEach(([k, v]) => r.setProperty(k, v));
  current = THEMES[n] ? n : "Grafite laranja";
  r.colorScheme = current === "Papel claro" ? "light" : "dark";
  try { localStorage.setItem(STORE_KEY, current); } catch { /* ignore */ }
  listeners.forEach((cb) => cb(current));
}

/** Restaura o tema persistido (ou o default) e aplica-o. */
export function initTheme(): void {
  let saved = "Grafite laranja";
  try { saved = localStorage.getItem(STORE_KEY) || saved; } catch { /* ignore */ }
  setTheme(THEMES[saved] ? saved : "Grafite laranja");
}
