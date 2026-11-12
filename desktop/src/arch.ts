// Architecture Studio — desenhar um System Design orientado a eventos, VALIDAR a arquitectura
// ao vivo (tutor-eval::arch via arch_validate) e gerar o esqueleto do projecto a partir de um
// desenho válido. O desenho é um spec JSON {components, connections}; o diagrama é SVG.

import { invoke } from "@tauri-apps/api/core";
import { workspaceRoot } from "./workspace";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

interface Component { id: string; name: string; kind: string; outbox?: boolean }
interface Connection { from: string; to: string; relation: string; event?: string }
interface Architecture { components: Component[]; connections: Connection[] }
interface Finding { severity: "error" | "warning"; rule: string; message: string; component: string }

// The reference design from the Studio intro: service → outbox → relay → broker → consumer.
const EXAMPLE: Architecture = {
  components: [
    { id: "svc", name: "Backend", kind: "service" },
    { id: "db", name: "Postgres (outbox)", kind: "store", outbox: true },
    { id: "relay", name: "Outbox relay", kind: "relay" },
    { id: "mq", name: "RabbitMQ", kind: "broker" },
    { id: "worker", name: "Delivery worker", kind: "consumer" },
  ],
  connections: [
    { from: "svc", to: "db", relation: "writes" },
    { from: "relay", to: "db", relation: "reads" },
    { from: "relay", to: "mq", relation: "publishes", event: "order.placed" },
    { from: "worker", to: "mq", relation: "consumes", event: "order.placed" },
  ],
};

const KIND_COL: Record<string, number> = { gateway: 0, service: 1, store: 2, relay: 2, broker: 3, consumer: 4 };

let connectFrom: string | null = null; // node selected as the source of a new connection

export function initArch(): void {
  $("#arch-close").addEventListener("click", () => $("#arch-overlay").classList.add("hidden"));
  $("#arch-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) $("#arch-overlay").classList.add("hidden");
  });
  $("#arch-spec").addEventListener("input", () => void validate());
  $("#arch-scaffold").addEventListener("click", () => void scaffold());
  // Palette: add a component of the chosen kind.
  $("#arch-overlay").querySelectorAll<HTMLElement>(".arch-add").forEach((b) =>
    b.addEventListener("click", () => addComponent(b.dataset.kind!)),
  );
  // Click a node, then another, to connect them (relation inferred from the two kinds).
  $("#arch-diagram").addEventListener("click", (e) => {
    const g = (e.target as HTMLElement).closest(".arch-node") as HTMLElement | null;
    if (g?.dataset.id) onNodeClick(g.dataset.id);
  });
  // Double-click a node to remove it (and any connections touching it).
  $("#arch-diagram").addEventListener("dblclick", (e) => {
    const g = (e.target as HTMLElement).closest(".arch-node") as HTMLElement | null;
    if (g?.dataset.id) removeComponent(g.dataset.id);
  });
}

/** Remove a component and every connection that touches it. */
function removeComponent(id: string): void {
  const a = currentArch();
  if (!a) return;
  connectFrom = null;
  a.components = a.components.filter((c) => c.id !== id);
  a.connections = a.connections.filter((c) => c.from !== id && c.to !== id);
  setArch(a);
}

/** Mutate the design in place, write it back to the spec, and re-validate (which re-renders). */
function setArch(a: Architecture): void {
  ($("#arch-spec") as HTMLTextAreaElement).value = JSON.stringify(a, null, 2);
  void validate();
}

function addComponent(kind: string): void {
  const a = currentArch();
  if (!a) return;
  const n = a.components.filter((c) => c.kind === kind).length + 1;
  const id = `${kind}${n}`;
  const name = kind.charAt(0).toUpperCase() + kind.slice(1) + ` ${n}`;
  a.components.push({ id, name, kind, ...(kind === "store" ? { outbox: false } : {}) });
  setArch(a);
}

/** Default relation between two components, so connecting is one click each (no form). */
function inferRelation(from: string, to: string, a: Architecture): { relation: string; event?: string } | null {
  const fk = a.components.find((c) => c.id === from)?.kind;
  const tk = a.components.find((c) => c.id === to)?.kind;
  if (!fk || !tk) return null;
  if (tk === "store") return { relation: fk === "relay" ? "reads" : "writes" };
  if (tk === "broker") {
    const event = (window.prompt("Event name (routing key):", "order.placed") ?? "").trim();
    if (!event) return null;
    return { relation: fk === "consumer" ? "consumes" : "publishes", event };
  }
  if (fk === "broker" && tk === "consumer") return { relation: "routesTo" };
  return { relation: "writes" }; // generic fallback
}

function onNodeClick(id: string): void {
  if (connectFrom === null) {
    connectFrom = id;
    $("#arch-hint").textContent = `Connecting from "${id}" — click the target (or this node to cancel).`;
    $("#arch-diagram").querySelectorAll(".arch-node").forEach((g) =>
      g.classList.toggle("sel", (g as HTMLElement).dataset.id === id),
    );
    return;
  }
  const from = connectFrom;
  connectFrom = null;
  $("#arch-hint").textContent = "Click a node, then another, to connect · double-click to delete.";
  if (from === id) {
    void validate(); // clicked the same node → cancel selection
    return;
  }
  const a = currentArch();
  if (!a) return;
  const rel = inferRelation(from, id, a);
  if (!rel) {
    void validate();
    return;
  }
  a.connections.push({ from, to: id, relation: rel.relation, ...(rel.event ? { event: rel.event } : {}) });
  setArch(a);
}

export function openArch(): void {
  const ta = $("#arch-spec") as HTMLTextAreaElement;
  if (!ta.value.trim()) ta.value = JSON.stringify(EXAMPLE, null, 2);
  $("#arch-overlay").classList.remove("hidden");
  void validate();
}

function currentArch(): Architecture | null {
  try {
    const a = JSON.parse(($("#arch-spec") as HTMLTextAreaElement).value);
    if (Array.isArray(a.components) && Array.isArray(a.connections)) return a;
  } catch {
    /* invalid JSON */
  }
  return null;
}

async function validate(): Promise<void> {
  const arch = currentArch();
  if (!arch) {
    $("#arch-findings").innerHTML = `<div class="arch-f err">⚠ Invalid JSON — fix the design spec.</div>`;
    $("#arch-diagram").innerHTML = "";
    ($("#arch-scaffold") as HTMLButtonElement).disabled = true;
    return;
  }
  let findings: Finding[] = [];
  try {
    findings = await invoke<Finding[]>("arch_validate", { arch });
  } catch {
    findings = [];
  }
  const errors = findings.filter((f) => f.severity === "error");
  ($("#arch-scaffold") as HTMLButtonElement).disabled = errors.length > 0;
  $("#arch-findings").innerHTML = findings.length
    ? findings
        .map(
          (f) =>
            `<div class="arch-f ${f.severity === "error" ? "err" : "warn"}"><b>${esc(f.rule)}</b> — ${esc(f.message)}</div>`,
        )
        .join("")
    : `<div class="arch-f ok">✓ Architecture is valid — no structural errors.</div>`;
  renderDiagram(arch, findings);
}

/** Lay the components out in columns by kind and draw the connections; flag offending nodes. */
function renderDiagram(arch: Architecture, findings: Finding[]): void {
  const bad = new Set(findings.filter((f) => f.component).map((f) => f.component));
  const cols: Record<number, Component[]> = {};
  for (const c of arch.components) {
    const col = KIND_COL[c.kind] ?? 1;
    (cols[col] ??= []).push(c);
  }
  const COLW = 180, ROWH = 70, NW = 140, NH = 42, PAD = 20;
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  for (const [colStr, list] of Object.entries(cols)) {
    const col = Number(colStr);
    list.forEach((c, i) => pos.set(c.id, { x: PAD + col * COLW, y: PAD + i * ROWH }));
    maxRows = Math.max(maxRows, list.length);
  }
  const width = PAD * 2 + 5 * COLW;
  const height = PAD * 2 + Math.max(1, maxRows) * ROWH;

  const edges = arch.connections
    .map((cn) => {
      const a = pos.get(cn.from), b = pos.get(cn.to);
      if (!a || !b) return "";
      const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
      const label = cn.event ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" class="arch-edge-label">${esc(cn.event)}</text>` : "";
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="arch-edge" marker-end="url(#arch-arrow)"/>${label}`;
    })
    .join("");
  const nodes = arch.components
    .map((c) => {
      const p = pos.get(c.id)!;
      const cls = `arch-node ${c.kind}${bad.has(c.id) ? " bad" : ""}${connectFrom === c.id ? " sel" : ""}`;
      return (
        `<g class="${cls}" data-id="${esc(c.id)}"><rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="7"/>` +
        `<text x="${p.x + NW / 2}" y="${p.y + 17}" class="arch-node-name">${esc(c.name)}</text>` +
        `<text x="${p.x + NW / 2}" y="${p.y + 32}" class="arch-node-kind">${esc(c.kind)}${c.outbox ? " · outbox" : ""}</text></g>`
      );
    })
    .join("");
  $("#arch-diagram").innerHTML =
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><marker id="arch-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8z" class="arch-arrowhead"/></marker></defs>` +
    `${edges}${nodes}</svg>`;
}

/** Generate a project scaffold from a VALID design: a folder per service/consumer/relay with
 *  a stub, and an ARCHITECTURE.md describing the event flow. Writes via the backend. */
async function scaffold(): Promise<void> {
  const arch = currentArch();
  const root = workspaceRoot();
  if (!arch || !root) return;
  const btn = $("#arch-scaffold") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const written = await invoke<string[]>("arch_scaffold", { root, arch });
    $("#arch-findings").innerHTML =
      `<div class="arch-f ok">✓ Scaffolded ${written.length} file(s):</div>` +
      written.map((p) => `<div class="arch-f">· <code>${esc(p)}</code></div>`).join("");
  } catch (e) {
    $("#arch-findings").innerHTML = `<div class="arch-f err">⚠ Scaffold failed: ${esc(String(e))}</div>`;
  } finally {
    btn.disabled = false;
  }
}
