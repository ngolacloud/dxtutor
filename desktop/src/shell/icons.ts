// icons.ts — biblioteca de ícones da casca (SVG estilo codicon).
//
// Portado VERBATIM de docs/prototype/index.html (objecto `P`, svg(), hydrate()).
// São ícones puros, reutilizáveis: os elementos com `data-ic="nome"` são
// preenchidos por hydrate() com o SVG correspondente, preservando filhos
// existentes (ex.: badges). O protótipo é a fonte de verdade visual.

export const P: Record<string, string> = {
  explorer: '<rect x="5.2" y="2.3" width="7" height="9.3" rx="1"/><path d="M5.2 4.6H3.8a1 1 0 0 0-1 1v7.1a1 1 0 0 0 1 1h5.9a1 1 0 0 0 1-1v-1.1"/>',
  search: '<circle cx="7" cy="7" r="4.1"/><path d="M10 10l3.6 3.6"/>',
  scm: '<circle cx="4.5" cy="3.6" r="1.7"/><circle cx="4.5" cy="12.4" r="1.7"/><circle cx="11.5" cy="6" r="1.7"/><path d="M4.5 5.3v5.4"/><path d="M11.5 7.7a4 4 0 0 1-4 4h-1.3"/>',
  run: '<path d="M5 3.4v9.2l7-4.6z"/>',
  remote: '<rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.6h4M8 11v2.6"/>',
  ext: '<rect x="2.4" y="2.4" width="4.6" height="4.6" rx=".7"/><rect x="2.4" y="9" width="4.6" height="4.6" rx=".7"/><rect x="9" y="9" width="4.6" height="4.6" rx=".7"/><path d="M11.3 2v4.6M9 4.3h4.6"/>',
  test: '<path d="M6.3 2v3.8L3.4 11a1.1 1.1 0 0 0 1 1.7h7.2a1.1 1.1 0 0 0 1-1.7L9.7 5.8V2"/><path d="M5.4 2h5.2M4.7 9.3h6.6"/>',
  runcircle: '<circle cx="8" cy="8" r="6"/><path d="M6.6 5.4l4 2.6-4 2.6z"/>',
  cube: '<path d="M8 1.9l5.4 3v6.2L8 14.1l-5.4-3V4.9z"/><path d="M8 7.9l5.4-3M8 7.9v6.2M8 7.9L2.6 4.9"/>',
  graph: '<circle cx="4" cy="4" r="1.6"/><circle cx="4" cy="12" r="1.6"/><circle cx="12" cy="8" r="1.6"/><path d="M4 5.6v4.8M5.4 4.8l5.2 2.5M5.4 11.2l5.2-2.5"/>',
  python: '<path d="M8 1.8c-2.4 0-2.9 1-2.9 2.3V6H8v.7H3.6c-1.3 0-2 .9-2 2.8s.7 2.8 2 2.8h1V10c0-1.4.9-2.3 2.3-2.3"/><circle cx="6.3" cy="4" r=".5" class="fill"/>',
  split: '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M8 2.5v11"/>',
  dots: '<circle cx="3" cy="8" r="1.1" class="fill"/><circle cx="8" cy="8" r="1.1" class="fill"/><circle cx="13" cy="8" r="1.1" class="fill"/>',
  account: '<circle cx="8" cy="5.5" r="2.6"/><path d="M3.4 13.2c.6-2.6 2.4-3.9 4.6-3.9s4 1.3 4.6 3.9"/>',
  settings: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/>',
  sparkle: '<path d="M8 1.8l1.4 4L13.4 7l-4 1.2L8 12.2 6.6 8.2 2.6 7l4-1.2z" class="fill"/>',
  /* small ui */
  chev: '<path d="M6 4l4 4-4 4"/>',
  folder: '<path class="fill" d="M1.6 4.3c0-.6.4-1 1-1h3.1a1 1 0 0 1 .7.3l.9.9a1 1 0 0 0 .7.3h5.4c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1h-13c-.6 0-1-.4-1-1z"/>',
  folderOpen: '<path class="fill" d="M1.6 4.3c0-.6.4-1 1-1h3.1a1 1 0 0 1 .7.3l.9.9a1 1 0 0 0 .7.3h5.4c.6 0 1 .4 1 1v.9H4.4a1 1 0 0 0-.95.68L1.6 12.5z"/>',
  file: '<path d="M4 2.3h5.1L12 5.2v8a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.9A.6.6 0 0 1 4 2.3z"/><path d="M9 2.4V5.5h2.9"/>',
  rust: '<path class="fill" d="M8 2.2 9 3.9l1.9-.5-.3 2 1.8.9-1.3 1.5 1 1.7-2 .2-.6 1.9-1.6-1.2-1.6 1.2-.6-1.9-2-.2 1-1.7L2 7.3l1.8-.9-.3-2 1.9.5z"/><circle cx="8" cy="8" r="1.5" style="fill:var(--bg-side)"/>',
  'new-file': '<path d="M4 2.3h4.6L11 4.7v4.1"/><path d="M8.5 2.4V5h2.4"/><path d="M4 2.3A.6.6 0 0 0 3.4 2.9v10.2a.6.6 0 0 0 .6.6h3"/><path d="M11 10.5v4M9 12.5h4"/>',
  'new-folder': '<path d="M1.6 4.3c0-.6.4-1 1-1h2.9a1 1 0 0 1 .7.3l.9.9a1 1 0 0 0 .7.3h5.1"/><path d="M1.6 4.3v7.9c0 .6.4 1 1 1h5.4"/><path d="M12 9.5v4M10 11.5h4"/>',
  refresh: '<path d="M12.5 7a4.6 4.6 0 1 0-.7 3.4"/><path d="M12.6 3.2v2.9H9.7"/>',
  collapse: '<path d="M9 2.5 6.5 5H8.5V8"/><path d="M5 11H3M7 5.5l4-4M11 11.5 9 9.5M11 9.5H9V11.5M2.5 7 5 9.5V11"/>',
  check: '<path d="M3 8.5 6.3 12 13 4.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  trash: '<path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  'layout-side': '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M6 2.5v11"/>',
  'layout-panel': '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M2 10h12"/>',
  history: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.7V8l2.3 1.6"/>',
  'arrow-up': '<path d="M8 13V3M4 7l4-4 4 4"/>',
  shield: '<path d="M8 2 3 4v3.5C3 10.8 5.2 13 8 14c2.8-1 5-3.2 5-6.5V4z"/>',
  rocket: '<path d="M8 2c2.2 1.3 3.3 3.5 3.3 6.5L8 11 4.7 8.5C4.7 5.5 5.8 3.3 8 2z"/><circle cx="8" cy="6.3" r="1.1"/><path d="M5.5 10c-1 .4-1.6 1.4-1.6 2.8 1.4 0 2.4-.6 2.8-1.6M10.5 10c1 .4 1.6 1.4 1.6 2.8-1.4 0-2.4-.6-2.8-1.6"/>',
  'branch-sm': '<circle cx="4.5" cy="4" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5.5v5M11.5 7a3.5 3.5 0 0 1-3.5 3.5H5"/>',
  'remote-arrows': '<path d="M6 3 2 8l4 5M10 3l4 5-4 5"/>',
  sync: '<path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5"/><path d="M11.8 2.2v2.6H9.2M4.2 13.8v-2.6h2.6"/>',
  debug: '<circle cx="8" cy="8.8" r="3.4"/><path d="M8 5.4V3.2M5.2 6.4 3.8 5M10.8 6.4 12.2 5M4.6 8.8H2.6M13.4 8.8h-2M5.4 11.2 4 12.6M10.6 11.2 12 12.6"/>',
  cloud: '<path d="M5 11.5h6.2a2.6 2.6 0 0 0 .2-5.2 3.6 3.6 0 0 0-7-1A2.7 2.7 0 0 0 5 11.5z"/>',
  broadcast: '<circle cx="8" cy="8" r="1.4" class="fill"/><path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.3 3.3a6.6 6.6 0 0 0 0 9.4M12.7 3.3a6.6 6.6 0 0 1 0 9.4"/>',
  drop: '<path d="M8 2.4S4 6.8 4 9.8a4 4 0 0 0 8 0c0-3-4-7.4-4-7.4z"/>',
  bell: '<path d="M8 2.2a3.4 3.4 0 0 0-3.4 3.4c0 4-1.4 4.9-1.4 4.9h9.6s-1.4-.9-1.4-4.9A3.4 3.4 0 0 0 8 2.2z"/><path d="M6.6 13a1.5 1.5 0 0 0 2.8 0"/>',
  volume: '<ellipse cx="8" cy="4" rx="5" ry="1.8"/><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4"/><path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8"/>',
  network: '<circle cx="8" cy="3.5" r="1.6"/><circle cx="3.5" cy="12" r="1.6"/><circle cx="12.5" cy="12" r="1.6"/><path d="M8 5.1v3M8 8l-3.6 2.6M8 8l3.6 2.6"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><circle cx="5.8" cy="6.3" r="1.1"/><path d="M2.5 11l3.2-3 2.3 2 2.4-2.6 3.1 3.6"/>',
  container: '<rect x="2.2" y="5" width="4.4" height="4.4" rx=".4"/><rect x="6.8" y="5" width="4.4" height="4.4" rx=".4"/><path d="M11.4 5h2.4v4.4h-2.4M2.2 9.4h11.6v1.4c0 .6-.4 1-1 1H3.2c-.6 0-1-.4-1-1z"/>',
  book: '<path d="M3 3.2h4.5a1.5 1.5 0 0 1 1.5 1.5v8.1a1.2 1.2 0 0 0-1.2-1.2H3z"/><path d="M13 3.2H8.5A1.5 1.5 0 0 0 7 4.7v8.1a1.2 1.2 0 0 1 1.2-1.2H13z"/>',
  popout: '<path d="M9 2.5h4.5V7"/><path d="M13.5 2.5 8 8"/><path d="M12 9v3.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1H7"/>',
  'dock-right': '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M9.5 2.5v11"/>',
};

/** Constrói o markup SVG de um ícone (classe `ico`, opcionalmente extra). */
export function svg(name: string, cls?: string): string {
  return `<svg class="ico${cls ? " " + cls : ""}" viewBox="0 0 16 16">${P[name] || P.file}</svg>`;
}

/**
 * Preenche todos os `[data-ic]` ainda não hidratados, inserindo o SVG como
 * primeiro filho (preserva badges/labels já presentes). Idempotente via
 * `data-done`. Chamar após injectar HTML novo com `data-ic`.
 */
export function hydrate(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-ic]").forEach((el) => {
    if (el.dataset.done) return;
    el.insertAdjacentHTML("afterbegin", svg(el.dataset.ic || "file"));
    el.dataset.done = "1";
  });
}
