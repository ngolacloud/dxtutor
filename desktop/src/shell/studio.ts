// shell/studio.ts — Fase 7: Architecture Studio (desenho + validação).
//
// Porta a secção «Studio» de docs/prototype/index.html para um módulo real: um
// canvas SVG com nós arrastáveis e ligações (modo «Connect»), um catálogo de
// tecnologias por cloud (APP/OSS/AWS/AZURE/GCP) e um inspector lateral.
//
// Regra de honestidade (ver docs/ui-rewrite/PLAN.md): o MODELO (nós/arestas) é
// estado do cliente, persistido em localStorage — mas a VALIDAÇÃO é REAL, feita
// pelo backend `arch_validate` (crate tutor-eval::arch). O que ainda não liga ao
// backend — «Generate backlog & delegate» e «▶ RUN» (Fase 8) — aparece VISÍVEL
// mas DESACTIVADO, com «not implemented yet». Nada é simulado em silêncio.

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { VIEW, openTab, addCommand, toast, type Tab } from "./index";
import { workspaceRoot } from "./workspace";

// ───────────────────────────── modelo do cliente ──────────────────────────────
// `tech` é a chave no catálogo TECH; `st` é um rótulo puramente visual (não entra
// na Architecture enviada ao backend).
type NodeState = "plan" | "wip" | "ok";
interface SNode { id: string; tech: string; name: string; x: number; y: number; st: NodeState }
type SEdge = [string, string];
interface Design { nodes: SNode[]; edges: SEdge[] }

// ───────────────────────────── catálogo (portado do protótipo) ──────────────────────────────
interface Cloud { l: string; col: string; t: string }
const CLOUD: Record<string, Cloud> = {
  app: { l: "APP", col: "#dea584", t: "Application runtimes" },
  oss: { l: "OSS", col: "#5cc9a7", t: "Open source" },
  aws: { l: "AWS", col: "#ff9900", t: "Amazon Web Services" },
  azure: { l: "AZURE", col: "#3a96dd", t: "Microsoft Azure" },
  gcp: { l: "GCP", col: "#ea4335", t: "Google Cloud" },
};

interface Tech { n: string; cloud: string; kind: string; img?: string; port: number; local?: string }
const PG = "postgres:16-alpine", RD = "redis:7-alpine", TF = "traefik:v3.1";
const KC = "quay.io/keycloak/keycloak:25.0", RMQ = "rabbitmq:3.13-management-alpine";
const GCE = "gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators";
// Ajudante compacto (nome, cloud, kind, imagem, porta, equivalente local).
const mkT = (n: string, cloud: string, kind: string, img: string, port: number, local?: string): Tech =>
  ({ n, cloud, kind, img, port, local });

const TECH: Record<string, Tech> = {
  // Runtimes de aplicação (constroem-se de um Dockerfile gerado).
  "rust-axum": { n: "Rust · Axum", cloud: "app", kind: "app", port: 8080 },
  "go-http": { n: "Go · net/http", cloud: "app", kind: "app", port: 8080 },
  "node-express": { n: "Node.js · Express", cloud: "app", kind: "app", port: 3000 },
  "py-fastapi": { n: "Python · FastAPI", cloud: "app", kind: "app", port: 8000 },
  "react-vite": { n: "React · Vite", cloud: "app", kind: "web", port: 8080 },
  // Código aberto.
  postgres: mkT("PostgreSQL", "oss", "sql", PG, 5432),
  redis: mkT("Redis", "oss", "cache", RD, 6379),
  rabbitmq: mkT("RabbitMQ", "oss", "amqp", RMQ, 5672),
  kafka: mkT("Apache Kafka", "oss", "kafka", "apache/kafka:3.8.0", 9092),
  nats: mkT("NATS", "oss", "nats", "nats:2.10-alpine", 4222),
  minio: mkT("MinIO", "oss", "s3", "minio/minio", 9000),
  traefik: mkT("Traefik", "oss", "gateway", TF, 80),
  keycloak: mkT("Keycloak", "oss", "oidc", KC, 8080),
  prometheus: mkT("Prometheus", "oss", "obs", "prom/prometheus:v2.54.1", 9090),
  grafana: mkT("Grafana", "oss", "obs", "grafana/grafana:11.2.0", 3000),
  otel: mkT("OpenTelemetry Collector", "oss", "otel", "otel/opentelemetry-collector:0.108.0", 4317),
  // AWS.
  "aws-alb": mkT("Application Load Balancer", "aws", "gateway", TF, 80, "Traefik"),
  "aws-s3": mkT("Amazon S3", "aws", "s3", "minio/minio", 9000, "MinIO"),
  "aws-rds": mkT("Amazon RDS · PostgreSQL", "aws", "sql", PG, 5432, "PostgreSQL"),
  "aws-dynamodb": mkT("Amazon DynamoDB", "aws", "dynamo", "amazon/dynamodb-local", 8000, "DynamoDB Local"),
  "aws-sqs": mkT("Amazon SQS", "aws", "sqs", "softwaremill/elasticmq-native", 9324, "ElasticMQ"),
  "aws-elasticache": mkT("Amazon ElastiCache · Redis", "aws", "cache", RD, 6379, "Redis"),
  "aws-cognito": mkT("Amazon Cognito", "aws", "oidc", KC, 8080, "Keycloak (stand-in)"),
  // Azure.
  "az-frontdoor": mkT("Azure Front Door", "azure", "gateway", TF, 80, "Traefik"),
  "az-blob": mkT("Azure Blob Storage", "azure", "blob", "mcr.microsoft.com/azure-storage/azurite", 10000, "Azurite"),
  "az-sql": mkT("Azure SQL Database", "azure", "mssql", "mcr.microsoft.com/mssql/server:2022-latest", 1433, "SQL Server 2022"),
  "az-servicebus": mkT("Azure Service Bus", "azure", "amqp", RMQ, 5672, "RabbitMQ (stand-in)"),
  "az-redis": mkT("Azure Cache for Redis", "azure", "cache", RD, 6379, "Redis"),
  "az-entra": mkT("Microsoft Entra ID", "azure", "oidc", KC, 8080, "Keycloak (stand-in)"),
  // GCP.
  "gcp-lb": mkT("Cloud Load Balancing", "gcp", "gateway", TF, 80, "Traefik"),
  "gcp-gcs": mkT("Cloud Storage", "gcp", "gcs", "fsouza/fake-gcs-server", 4443, "fake-gcs-server"),
  "gcp-sql": mkT("Cloud SQL · PostgreSQL", "gcp", "sql", PG, 5432, "PostgreSQL"),
  "gcp-pubsub": mkT("Pub/Sub", "gcp", "pubsub", GCE, 8085, "Pub/Sub emulator"),
  "gcp-memorystore": mkT("Memorystore · Redis", "gcp", "cache", RD, 6379, "Redis"),
  "gcp-firestore": mkT("Firestore", "gcp", "firestore", GCE, 8080, "Firestore emulator"),
};

// ───────────────────────────── formas do backend (tutor-eval::arch) ──────────────────────────────
// Espelham EXACTAMENTE os structs de crates/tutor-eval/src/arch.rs (serde kebab-case
// para Kind/Relation/Severity; Finding em camelCase). Ver pressupostos no fim do ficheiro.
type BackendKind = "service" | "store" | "broker" | "consumer" | "relay" | "gateway";
type Relation = "writes" | "reads" | "publishes" | "consumes" | "routes-to";
interface Component { id: string; name: string; kind: BackendKind; outbox: boolean }
interface Connection { from: string; to: string; relation: Relation; event: string }
interface Architecture { components: Component[]; connections: Connection[] }
interface Finding { severity: "error" | "warning"; rule: string; message: string; component: string }

// O catálogo do estúdio fala em tecnologias concretas; o validador fala no modelo
// abstracto orientado a eventos. Esta tabela faz a ponte do `kind` do catálogo para
// o `Kind` do backend. Tecnologias de apoio (identidade/observabilidade) contam como
// serviços; filas/tópicos como brokers; bases de dados e armazenamento como stores.
const KIND_MAP: Record<string, BackendKind> = {
  app: "service", web: "service",
  gateway: "gateway",
  sql: "store", mssql: "store", cache: "store",
  s3: "store", dynamo: "store", blob: "store", gcs: "store", firestore: "store",
  amqp: "broker", kafka: "broker", nats: "broker", sqs: "broker", pubsub: "broker",
  oidc: "service", obs: "service", otel: "service",
};

// ───────────────────────────── estado do módulo ──────────────────────────────
const LS_KEY = "dxtutor.studio";
const NW = 152, NH = 58; // dimensões do nó no viewBox 760×440
const VBW = 760, VBH = 440;

function seed(): Design {
  return {
    nodes: [
      { id: "gw", tech: "aws-alb", name: "Gateway", x: 20, y: 155, st: "plan" },
      { id: "web", tech: "react-vite", name: "Web", x: 205, y: 30, st: "plan" },
      { id: "api", tech: "rust-axum", name: "Orders API", x: 205, y: 155, st: "plan" },
      { id: "q", tech: "aws-sqs", name: "Order Events", x: 205, y: 290, st: "plan" },
      { id: "pg", tech: "aws-rds", name: "Orders DB", x: 390, y: 30, st: "plan" },
      { id: "cache", tech: "aws-elasticache", name: "Session Cache", x: 390, y: 155, st: "plan" },
      { id: "worker", tech: "go-http", name: "Billing Worker", x: 390, y: 290, st: "plan" },
      { id: "s3", tech: "aws-s3", name: "Invoices Bucket", x: 575, y: 290, st: "plan" },
    ],
    edges: [
      ["gw", "web"], ["gw", "api"], ["web", "api"], ["api", "pg"],
      ["api", "cache"], ["api", "q"], ["worker", "q"], ["worker", "pg"], ["worker", "s3"],
    ],
  };
}

function loadSD(): Design {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const d = JSON.parse(raw) as Partial<Design>;
      if (d && Array.isArray(d.nodes) && Array.isArray(d.edges)) {
        return { nodes: d.nodes as SNode[], edges: d.edges as SEdge[] };
      }
    }
  } catch { /* localStorage indisponível ou corrompido — cai no seed */ }
  return seed();
}

let SD: Design = loadSD();
let SSEL: string | null = null;           // nó seleccionado
let SLINK: string | null = null;          // null=sem ligar; ""=à espera da origem; id=à espera do destino
let SCLICK: { id: string | null; t: number } = { id: null, t: 0 }; // detecção de duplo-clique
let SCAT = "aws";                          // separador de cloud activo no catálogo
let findings: Finding[] = [];              // último resultado REAL de arch_validate
let validating = false;
let validateError = "";
let scaffolding = false;                   // geração em curso?
let scaffoldResult: { written: string[] } | null = null; // caminhos escritos por arch_scaffold
let scaffoldError = "";

function saveSD(): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(SD)); } catch { /* ignora */ }
}

// ───────────────────────────── ajudantes ──────────────────────────────
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const el = <T extends Element = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const byId = (id: string): SNode | undefined => SD.nodes.find((n) => n.id === id);
const rid = (): string => Math.random().toString(36).slice(2, 8);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const isApp = (tech: string): boolean => { const T = TECH[tech]; return !!T && (T.kind === "app" || T.kind === "web"); };
const appDir = (n: SNode): string => (TECH[n.tech]?.kind === "web" ? "web/" : "apps/") + slug(n.name);

// ───────────────────────────── conversão modelo → Architecture ──────────────────────────────
function kindOf(tech: string): BackendKind {
  const T = TECH[tech];
  return (T && KIND_MAP[T.kind]) || "service";
}

// Infere a relação da aresta a partir dos tipos das pontas. O desenho só tem arestas
// não-tipadas (origem → destino); o backend precisa de uma Relation. Escolhe a mais
// plausível: escrever/ler numa store, publicar/consumir num broker, encaminhar de um
// broker. As restantes caem em `writes` (inócuo para as regras, que só reagem a
// stores, brokers e eventos nomeados).
function relationFor(fromKind: BackendKind, toKind: BackendKind): Relation {
  if (toKind === "store") return fromKind === "relay" ? "reads" : "writes";
  if (toKind === "broker") return fromKind === "consumer" ? "consumes" : "publishes";
  if (fromKind === "broker" && toKind === "consumer") return "routes-to";
  return "writes";
}

function toArchitecture(d: Design): Architecture {
  const components: Component[] = d.nodes.map((n) => ({
    id: n.id, name: n.name, kind: kindOf(n.tech), outbox: false,
  }));
  const connections: Connection[] = [];
  for (const [from, to] of d.edges) {
    const a = byId(from), b = byId(to);
    if (!a || !b) continue; // aresta pendurada no estado local — ignora (defensivo)
    connections.push({ from, to, relation: relationFor(kindOf(a.tech), kindOf(b.tech)), event: "" });
  }
  return { components, connections };
}

// Corre a validação REAL e repinta o inspector quando responde.
async function revalidate(): Promise<void> {
  validating = true; validateError = "";
  scaffoldResult = null; scaffoldError = ""; // o desenho mudou: resultado anterior fica obsoleto
  paintInspector();
  const arch = toArchitecture(SD);
  try {
    findings = await invoke<Finding[]>("arch_validate", { arch });
  } catch (e) {
    findings = []; validateError = String(e);
  }
  validating = false;
  paintInspector();
}

// ───────────────────────────── acções do modelo ──────────────────────────────
function sdAdd(tech: string): void {
  const T = TECH[tech]; if (!T) return;
  const k = SD.nodes.length;
  const name = T.n.split(" · ")[0].replace(/^(Amazon|Azure|Cloud|Microsoft|Apache) /, "") + " " + (k + 1);
  const id = "n" + rid();
  SD.nodes.push({ id, tech, name, x: 575 - (k % 3) * 14, y: 30 + (k % 3) * 128, st: "plan" });
  SSEL = id; saveSD(); render(); void revalidate();
}

function sdDel(id: string): void {
  SD.nodes = SD.nodes.filter((n) => n.id !== id);
  SD.edges = SD.edges.filter((e) => e[0] !== id && e[1] !== id);
  if (SSEL === id) SSEL = null;
  saveSD(); render(); void revalidate();
}

function resetDesign(): void {
  SD = seed(); SSEL = null; SLINK = null;
  saveSD(); render(); void revalidate();
  toast(t("studio.resetDone"));
}

function toggleConnect(): void {
  SLINK = SLINK === null ? "" : null;
  render();
}

// Gera o scaffold REAL do desenho via `arch_scaffold` (backend escreve na pasta aberta,
// nunca sobrepõe ficheiros existentes, e devolve os caminhos novos). Estado honesto quando
// não há pasta aberta ou o desenho tem erros.
async function genScaffold(): Promise<void> {
  const root = workspaceRoot();
  if (!root) { toast(t("studio.noFolder")); return; }
  if (findings.some((f) => f.severity === "error")) { toast(t("studio.scaffoldInvalid")); return; }
  scaffolding = true; scaffoldError = ""; scaffoldResult = null; paintInspector();
  try {
    const written = await invoke<string[]>("arch_scaffold", { root, arch: toArchitecture(SD) });
    scaffoldResult = { written };
    toast(t("studio.scaffoldDone", { n: written.length }));
  } catch (e) {
    scaffoldError = String(e);
    toast(t("studio.scaffoldFailed", { err: scaffoldError }));
  }
  scaffolding = false; paintInspector();
}

// Bloco de resultado da geração, mostrado na visão geral do inspector.
function scaffoldBlock(): string {
  if (scaffolding) return `<div class="st-kv" style="margin-top:12px"><span>…</span><code>${esc(t("studio.scaffolding"))}</code></div>`;
  if (scaffoldError) return `<div class="st-f e" style="margin-top:12px"><span>✖</span><div>${esc(scaffoldError)}</div></div>`;
  if (scaffoldResult) {
    const list = scaffoldResult.written.length
      ? scaffoldResult.written.map((p) => `<div class="st-f ok"><span>✓</span><div><code>${esc(p)}</code></div></div>`).join("")
      : `<div class="st-f"><span>·</span><div>${esc(t("studio.scaffoldNothing"))}</div></div>`;
    return `<h3 style="margin-top:14px">${esc(t("studio.scaffoldResult", { n: scaffoldResult.written.length }))}</h3>${list}`;
  }
  return "";
}

// ───────────────────────────── canvas (SVG) ──────────────────────────────
function paintCanvas(): void {
  const s = el<SVGSVGElement>("st-svg"); if (!s) return;
  const edge = ([a, b]: SEdge): string => {
    const A = byId(a), B = byId(b); if (!A || !B) return "";
    const ax = A.x + NW / 2, ay = A.y + NH / 2, bx = B.x + NW / 2, by2 = B.y + NH / 2, dx = bx - ax, dy = by2 - ay;
    const k = Math.min(Math.abs(dx) ? (NW / 2 + 6) / Math.abs(dx) : 9, Math.abs(dy) ? (NH / 2 + 6) / Math.abs(dy) : 9);
    const pl = A.st !== "ok" || B.st !== "ok";
    return `<line x1="${ax + dx * k}" y1="${ay + dy * k}" x2="${bx - dx * k}" y2="${by2 - dy * k}" stroke="${pl ? "var(--accent)" : "var(--fg-muted)"}" stroke-width="1.6" ${pl ? 'stroke-dasharray="5 4"' : ""} marker-end="url(#ar${pl ? "p" : ""})"/>`;
  };
  const cut = (x: string, m: number): string => (x.length > m ? x.slice(0, m - 1) + "…" : x);
  const node = (n: SNode): string => {
    const T = TECH[n.tech]; if (!T) return "";
    const C = CLOUD[T.cloud], pl = n.st === "plan", wip = n.st === "wip", on = SSEL === n.id || SLINK === n.id;
    const badge = pl ? t("studio.badgePlan") : wip ? t("studio.badgeWip") : t("studio.badgeOk");
    return `<g data-n="${n.id}" transform="translate(${n.x} ${n.y})" style="cursor:${SLINK !== null ? "crosshair" : "grab"}"><rect width="${NW}" height="${NH}" rx="10" fill="var(--bg-elevated)" stroke="${on ? "var(--accent)" : pl ? C.col : "var(--border-strong)"}" stroke-width="${on ? 2 : 1.3}" ${pl ? 'stroke-dasharray="6 4"' : ""}/><rect width="5" height="${NH - 16}" y="8" rx="2.5" fill="${C.col}"/><text x="14" y="17" fill="${C.col}" font-size="8.5" font-weight="700" font-family="var(--font-mono)" letter-spacing=".6">${C.l}</text><text x="${NW - 10}" y="17" text-anchor="end" fill="${pl ? "var(--accent-hover)" : wip ? "var(--yellow)" : "var(--green)"}" font-size="8.5" font-family="var(--font-mono)">${esc(badge)}</text><text x="14" y="34" fill="var(--fg)" font-size="12.5" font-weight="600" font-family="var(--font-ui)">${esc(cut(n.name, 19))}</text><text x="14" y="49" fill="var(--fg-muted)" font-size="10" font-family="var(--font-ui)">${esc(cut(T.n, 24))}</text></g>`;
  };
  s.innerHTML = `<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--fg-muted)"/></marker><marker id="arp" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--accent)"/></marker><pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--guide)"/></pattern></defs><rect width="${VBW}" height="${VBH}" fill="url(#grid)"/>` +
    SD.edges.map(edge).join("") + SD.nodes.map(node).join("");
}

// ───────────────────────────── catálogo ──────────────────────────────
function paintCatalogue(): void {
  const cat = el("st-cat"); if (!cat) return;
  const tabs = Object.entries(CLOUD).map(([k, c]) =>
    `<button data-cloud="${k}" class="${SCAT === k ? "on" : ""}" style="--c:${c.col}" title="${esc(c.t)}">${esc(c.l)}</button>`).join("");
  const techs = Object.entries(TECH).filter(([, T]) => T.cloud === SCAT).map(([k, T]) => {
    const tip = T.local ? "Runs locally as " + T.local : (T.img || "Built from a generated Dockerfile");
    return `<button class="st-tech" data-tech="${k}" title="${esc(tip)}"><span class="pdot" style="background:${CLOUD[T.cloud].col}"></span>${esc(T.n)}<i>＋</i></button>`;
  }).join("");
  cat.innerHTML = `<div class="st-tabs">${tabs}</div><div class="st-ct">${esc(CLOUD[SCAT].t)}</div>${techs}`;
  cat.querySelectorAll<HTMLElement>("[data-cloud]").forEach((b) => (b.onclick = () => { SCAT = b.dataset.cloud!; paintCatalogue(); }));
  cat.querySelectorAll<HTMLElement>("[data-tech]").forEach((b) => (b.onclick = () => sdAdd(b.dataset.tech!)));
}

// ───────────────────────────── inspector ──────────────────────────────
function validationBlock(): string {
  if (validating) return `<div class="st-f"><span>…</span><div>${esc(t("studio.validating"))}</div></div>`;
  if (validateError) return `<div class="st-f e"><span>✖</span><div>${esc(t("studio.validateFailed", { err: validateError }))}</div></div>`;
  if (!findings.length) return `<div class="st-f ok"><span>✓</span><div>${esc(t("studio.consistent"))}</div></div>`;
  return findings.map((f) => {
    const cls = f.severity === "error" ? "e" : "w";
    const ico = f.severity === "error" ? "✖" : "⚠";
    return `<div class="st-f ${cls}"><span>${ico}</span><div>${esc(f.message)}<span style="display:block;color:var(--fg-muted);font-family:var(--font-mono);font-size:10px;margin-top:1px">${esc(f.rule)}</span></div></div>`;
  }).join("");
}

function paintInspector(): void {
  const ins = el("st-insp"); if (!ins) return;

  // Modo «Connect»: instruções passo-a-passo.
  if (SLINK !== null) {
    ins.innerHTML = `<h3>${esc(t("studio.connectTitle"))}</h3><p>${esc(SLINK === "" ? t("studio.connectFrom") : t("studio.connectTo"))}</p>`;
    return;
  }

  const n = SSEL ? byId(SSEL) : undefined;

  // Nó seleccionado: editor de nome/tecnologia/estado/ligações.
  if (n) {
    const T = TECH[n.tech];
    const techOpts = Object.entries(CLOUD).map(([c, C]) =>
      `<optgroup label="${esc(C.t)}">${Object.entries(TECH).filter(([, x]) => x.cloud === c).map(([k, x]) =>
        `<option value="${k}"${n.tech === k ? " selected" : ""}>${esc(x.n)}</option>`).join("")}</optgroup>`).join("");
    const buildRow = T
      ? `<div class="st-kv"><span>${esc(isApp(n.tech) ? t("studio.build") : t("studio.image"))}</span><code>${esc(isApp(n.tech) ? "./" + appDir(n) : (T.img || "—"))}</code></div><div class="st-kv"><span>${esc(t("studio.port"))}</span><code>${T.port}</code></div>${T.local ? `<div class="st-kv"><span>${esc(t("studio.local"))}</span><code>${esc(T.local)}</code></div>` : ""}`
      : "";
    const conns = SD.edges.map((e, i) => (e[0] === n.id || e[1] === n.id)
      ? `<div class="st-e">${esc(byId(e[0])?.name ?? e[0])} → ${esc(byId(e[1])?.name ?? e[1])}<button data-ei="${i}">×</button></div>`
      : "").join("") || `<p>${esc(t("studio.noConnections"))}</p>`;
    const statusOpt = (v: NodeState, label: string): string => `<option value="${v}"${n.st === v ? " selected" : ""}>${esc(label)}</option>`;
    ins.innerHTML = `<h3>${esc(t("studio.component"))}</h3>` +
      `<label>${esc(t("studio.name"))}</label><input class="inp" id="st-name" style="margin:0 0 8px;width:100%" value="${esc(n.name)}" />` +
      `<label>${esc(t("studio.technology"))}</label><select id="st-tech-sel">${techOpts}</select>` +
      buildRow +
      `<label>${esc(t("studio.status"))}</label><select id="st-st-sel">${statusOpt("plan", t("studio.stPlan"))}${statusOpt("wip", t("studio.stWip"))}${statusOpt("ok", t("studio.stOk"))}</select>` +
      `<label>${esc(t("studio.connections"))}</label>${conns}` +
      `<button class="mini" id="st-del" style="margin-top:10px">${esc(t("studio.delete"))}</button>`;

    const name = el<HTMLInputElement>("st-name");
    if (name) name.onchange = () => { const node = byId(n.id); if (node) { node.name = name.value; saveSD(); render(); void revalidate(); } };
    const techSel = el<HTMLSelectElement>("st-tech-sel");
    if (techSel) techSel.onchange = () => { const node = byId(n.id); if (node) { node.tech = techSel.value; saveSD(); render(); void revalidate(); } };
    const stSel = el<HTMLSelectElement>("st-st-sel");
    if (stSel) stSel.onchange = () => { const node = byId(n.id); if (node) { node.st = stSel.value as NodeState; saveSD(); render(); } };
    ins.querySelectorAll<HTMLElement>("[data-ei]").forEach((b) => (b.onclick = () => {
      SD.edges.splice(Number(b.dataset.ei), 1); saveSD(); render(); void revalidate();
    }));
    const del = el("st-del"); if (del) del.onclick = () => sdDel(n.id);
    return;
  }

  // Sem selecção: visão geral + validação REAL + contagens.
  const root = workspaceRoot();
  const planned = SD.nodes.filter((x) => x.st === "plan").length;
  ins.innerHTML = `<h3>${esc(t("studio.design"))}</h3><p>${esc(t("studio.designHelp"))}</p>` +
    `<h3 style="margin-top:14px">${esc(t("studio.validation"))}</h3>${validationBlock()}` +
    `<div class="st-kv" style="margin-top:12px"><span>${esc(t("studio.components"))}</span><code>${SD.nodes.length}</code></div>` +
    `<div class="st-kv"><span>${esc(t("studio.planned"))}</span><code>${planned}</code></div>` +
    `<div class="st-kv"><span>${esc(t("studio.scaffoldTarget"))}</span><code>${esc(root ?? t("studio.noFolder"))}</code></div>` +
    scaffoldBlock();
}

// ───────────────────────────── render ──────────────────────────────
function render(): void {
  paintCatalogue();
  paintCanvas();
  paintInspector();
  const lb = el("st-link"); if (lb) lb.classList.toggle("pri", SLINK !== null);
}

// ───────────────────────────── interacção do canvas ──────────────────────────────
function onCanvasDown(e: MouseEvent): void {
  const s = el<SVGSVGElement>("st-svg"); if (!s) return;
  const g = (e.target as Element).closest("[data-n]") as HTMLElement | null;
  // Clicar no vazio: desselecciona (e, em modo ligar, volta a pedir a origem).
  if (!g) { SSEL = null; if (SLINK !== null) SLINK = ""; render(); return; }
  const id = g.dataset.n!; const n = byId(id); if (!n) return;
  const r = s.getBoundingClientRect(); const k = VBW / r.width;

  // Modo «Connect»: 1.º clique = origem, 2.º = destino (cria a aresta).
  if (SLINK !== null) {
    if (SLINK === "") SLINK = id;
    else if (SLINK !== id) {
      if (!SD.edges.some((x) => x[0] === SLINK && x[1] === id)) SD.edges.push([SLINK, id]);
      SLINK = null; saveSD(); void revalidate();
    }
    render(); return;
  }

  // Duplo-clique rápido no mesmo nó: apaga-o.
  const now = Date.now();
  if (SCLICK.id === id && now - SCLICK.t < 380) { SCLICK = { id: null, t: 0 }; sdDel(id); return; }
  SCLICK = { id, t: now }; SSEL = id;

  // Arrastar: mantém o nó dentro do viewBox; só grava se houve movimento.
  const ox = (e.clientX - r.left) * k - n.x, oy = (e.clientY - r.top) * k - n.y;
  let moved = false;
  const mv = (ev: MouseEvent): void => {
    moved = true;
    n.x = Math.max(4, Math.min(VBW - NW - 4, (ev.clientX - r.left) * k - ox));
    n.y = Math.max(4, Math.min(VBH - NH - 4, (ev.clientY - r.top) * k - oy));
    paintCanvas();
  };
  const up = (): void => {
    removeEventListener("mousemove", mv); removeEventListener("mouseup", up);
    if (moved) saveSD();
  };
  addEventListener("mousemove", mv); addEventListener("mouseup", up);
  render(); e.preventDefault();
}

// ───────────────────────────── vista ──────────────────────────────
const studioView = (_tab: Tab, host: HTMLElement): void => {
  const nyi = esc(t("studio.nyi"));
  host.innerHTML = `<div class="studio">
    <div class="st-bar">
      <b style="font-size:14px">${esc(t("studio.title"))}</b>
      <button class="mini" id="st-link">⤳ ${esc(t("studio.connect"))}</button>
      <button class="mini" id="st-reset">${esc(t("studio.reset"))}</button>
      <span class="sp"></span>
      <button class="mini pri" id="st-scaffold" title="${esc(t("studio.genScaffoldTip"))}">${esc(t("studio.genScaffold"))}</button>
      <button class="mini run" id="st-run" disabled title="${nyi}" style="opacity:.5;cursor:not-allowed">${esc(t("studio.run"))}</button>
    </div>
    <div class="st-main">
      <div class="st-cat" id="st-cat"></div>
      <div class="st-canvas"><svg id="st-svg" viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="xMinYMin meet"></svg></div>
      <div class="st-insp" id="st-insp"></div>
    </div>
  </div>`;

  const link = el("st-link"); if (link) link.onclick = toggleConnect;
  const reset = el("st-reset"); if (reset) reset.onclick = resetDesign;
  const scaffoldBtn = el("st-scaffold"); if (scaffoldBtn) scaffoldBtn.onclick = () => void genScaffold();
  // «▶ RUN» (stack real) fica desactivado até ao próximo corte da Fase 8.
  const svgEl = el<SVGSVGElement>("st-svg");
  if (svgEl) (svgEl as unknown as HTMLElement).onmousedown = onCanvasDown;

  render();
  void revalidate();
};

// ───────────────────────────── arranque ──────────────────────────────
export function initStudio(): void {
  registerStrings(STUDIO_STRINGS);
  VIEW.studio = studioView;
  addCommand({ id: "studio:open", label: () => t("studio.cmdOpen"), run: () => openTab({ id: "studio", title: t("studio.title"), kind: "studio" }) });
}

const STUDIO_STRINGS = {
  en: {
    "studio.title": "Architecture Studio",
    "studio.cmdOpen": "Architecture Studio: open",
    "studio.connect": "Connect",
    "studio.reset": "Reset design",
    "studio.resetDone": "Design reset to the starting layout.",
    "studio.genBacklog": "Generate backlog & delegate →",
    "studio.genScaffold": "Generate scaffold →",
    "studio.genScaffoldTip": "Write the project skeleton (Dockerfile, compose, Makefile, k8s…) into the open folder, never overwriting.",
    "studio.scaffolding": "Generating scaffold…",
    "studio.scaffoldResult": "Scaffold — {n} file(s) written",
    "studio.scaffoldDone": "Scaffold generated: {n} file(s) written.",
    "studio.scaffoldNothing": "Nothing new to write (files already exist).",
    "studio.scaffoldFailed": "Scaffold failed: {err}",
    "studio.scaffoldInvalid": "Fix the design errors before generating the scaffold.",
    "studio.run": "▶ RUN",
    "studio.nyi": "not implemented yet (Phase 8)",
    "studio.connectTitle": "Connect",
    "studio.connectFrom": "Click the component that depends on another.",
    "studio.connectTo": "Now click what it depends on.",
    "studio.component": "Component",
    "studio.name": "Name",
    "studio.technology": "Technology",
    "studio.status": "Status",
    "studio.connections": "Connections",
    "studio.noConnections": "No connections.",
    "studio.delete": "Delete component",
    "studio.stPlan": "Planned",
    "studio.stWip": "In progress",
    "studio.stOk": "Built",
    "studio.badgePlan": "planned",
    "studio.badgeWip": "in progress",
    "studio.badgeOk": "built",
    "studio.design": "Design",
    "studio.designHelp": "Each component is a technology. Pick one from the catalogue, drag it, and use Connect to draw dependencies. Double-click deletes.",
    "studio.validation": "Validation",
    "studio.validating": "Validating…",
    "studio.validateFailed": "Validation failed: {err}",
    "studio.consistent": "The design is consistent.",
    "studio.components": "components",
    "studio.planned": "planned",
    "studio.build": "build",
    "studio.image": "image",
    "studio.port": "port",
    "studio.local": "local",
    "studio.scaffoldTarget": "Phase 8 target",
    "studio.noFolder": "open a folder first",
  },
  ptAO: {
    "studio.title": "Estúdio de Arquitectura",
    "studio.cmdOpen": "Estúdio de Arquitectura: abrir",
    "studio.connect": "Ligar",
    "studio.reset": "Repor desenho",
    "studio.resetDone": "Desenho reposto ao estado inicial.",
    "studio.genBacklog": "Gerar backlog e delegar →",
    "studio.genScaffold": "Gerar scaffold →",
    "studio.genScaffoldTip": "Escreve o esqueleto do projecto (Dockerfile, compose, Makefile, k8s…) na pasta aberta, sem sobrepor.",
    "studio.scaffolding": "A gerar o scaffold…",
    "studio.scaffoldResult": "Scaffold — {n} ficheiro(s) escrito(s)",
    "studio.scaffoldDone": "Scaffold gerado: {n} ficheiro(s) escrito(s).",
    "studio.scaffoldNothing": "Nada de novo a escrever (os ficheiros já existem).",
    "studio.scaffoldFailed": "Falha ao gerar o scaffold: {err}",
    "studio.scaffoldInvalid": "Corrige os erros do desenho antes de gerar o scaffold.",
    "studio.run": "▶ EXECUTAR",
    "studio.nyi": "ainda não implementado (Fase 8)",
    "studio.connectTitle": "Ligar",
    "studio.connectFrom": "Clica no componente que depende de outro.",
    "studio.connectTo": "Agora clica naquilo de que depende.",
    "studio.component": "Componente",
    "studio.name": "Nome",
    "studio.technology": "Tecnologia",
    "studio.status": "Estado",
    "studio.connections": "Ligações",
    "studio.noConnections": "Sem ligações.",
    "studio.delete": "Apagar componente",
    "studio.stPlan": "Planeado",
    "studio.stWip": "Em curso",
    "studio.stOk": "Implementado",
    "studio.badgePlan": "planeado",
    "studio.badgeWip": "em curso",
    "studio.badgeOk": "implementado",
    "studio.design": "Desenho",
    "studio.designHelp": "Cada componente é uma tecnologia. Escolhe uma do catálogo, arrasta-a e usa Ligar para desenhar dependências. Duplo-clique apaga.",
    "studio.validation": "Validação",
    "studio.validating": "A validar…",
    "studio.validateFailed": "A validação falhou: {err}",
    "studio.consistent": "O desenho é consistente.",
    "studio.components": "componentes",
    "studio.planned": "planeados",
    "studio.build": "construção",
    "studio.image": "imagem",
    "studio.port": "porta",
    "studio.local": "local",
    "studio.scaffoldTarget": "Destino da Fase 8",
    "studio.noFolder": "abre primeiro uma pasta",
  },
};
