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

export function initArch(): void {
  $("#arch-close").addEventListener("click", () => $("#arch-overlay").classList.add("hidden"));
  $("#arch-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) $("#arch-overlay").classList.add("hidden");
  });
  $("#arch-spec").addEventListener("input", () => void validate());
  $("#arch-scaffold").addEventListener("click", () => void scaffold());
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
      const cls = `arch-node ${c.kind}${bad.has(c.id) ? " bad" : ""}`;
      return (
        `<g class="${cls}"><rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="7"/>` +
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
