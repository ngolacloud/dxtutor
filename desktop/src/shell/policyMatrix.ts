// shell/policyMatrix.ts — Fase 4 (paridade, PARITY #25): matriz de política dos modos do Co-Dev.
//
// SÓ DE LEITURA: lê o `codev_policy` do backend (a autoridade — a política é decidida lá, não
// no webview) para cada modo (Manual/Assistido/Auto) e mostra, numa matriz, o que cada modo
// exige/permite: aprovação de edições, aprovação de comandos, encadeamento de passos e a
// garantia de que acções destrutivas e push PEDEM SEMPRE. Não altera `policy.rs` nem decide
// nada no cliente — apenas torna visível a matriz que já governa o comportamento. Disparada por
// um comando da paleta; o overlay é auto-contido (sem tocar em zonas partilhadas da casca).

import { invoke } from "@tauri-apps/api/core";
import { t, registerStrings } from "../i18n";
import { addCommand, toast } from "./index";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** Espelha `tutor_llm::policy::CoDevPolicy` (serde camelCase). */
interface CoDevPolicy {
  mode: string;
  editsNeedApproval: boolean;
  commandsNeedApproval: boolean;
  chains: boolean;
  destructiveAlwaysAsks: boolean;
}

const MODES = ["manual", "assist", "auto"] as const;

/** Lê a política de cada modo e desenha a matriz num overlay. Honesto: se o backend não
 *  responder, mostra o erro em vez de inventar a matriz. */
async function openMatrix(): Promise<void> {
  let policies: CoDevPolicy[];
  try {
    policies = await Promise.all(MODES.map((m) => invoke<CoDevPolicy>("codev_policy", { mode: m })));
  } catch (e) {
    toast(t("pmx.err", { e: String(e) }));
    return;
  }
  const yes = `<span style="color:var(--red)">${esc(t("pmx.asks"))}</span>`;   // pede aprovação
  const no = `<span style="color:var(--green)">${esc(t("pmx.auto"))}</span>`;  // automático
  const onv = `<span style="color:var(--green)">✓</span>`;
  const offv = `<span style="color:var(--fg-muted)">—</span>`;
  const row = (label: string, cells: string[]): string =>
    `<tr><td style="padding:6px 10px;color:var(--fg-muted)">${esc(label)}</td>${cells.map((c) => `<td style="padding:6px 10px;text-align:center">${c}</td>`).join("")}</tr>`;

  const head = `<tr><th style="padding:6px 10px;text-align:left"></th>${policies.map((p) => `<th style="padding:6px 10px">${esc(t("mode." + p.mode))}</th>`).join("")}</tr>`;
  const body =
    row(t("pmx.edits"), policies.map((p) => (p.editsNeedApproval ? yes : no))) +
    row(t("pmx.commands"), policies.map((p) => (p.commandsNeedApproval ? yes : no))) +
    row(t("pmx.chains"), policies.map((p) => (p.chains ? onv : offv))) +
    row(t("pmx.destructive"), policies.map((p) => (p.destructiveAlwaysAsks ? yes : no)));

  const ov = document.createElement("div");
  ov.id = "pmx-overlay";
  ov.style.cssText = "position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)";
  ov.innerHTML =
    `<div style="background:var(--bg-elev,var(--bg));border:1px solid var(--border);border-radius:8px;max-width:620px;width:92%;padding:16px 18px;box-shadow:0 8px 40px rgba(0,0,0,.4)">
      <div style="display:flex;align-items:center;margin-bottom:6px"><b style="font-size:14px">${esc(t("pmx.title"))}</b><span style="flex:1"></span><button class="btn" id="pmx-close">${esc(t("pmx.close"))}</button></div>
      <div class="sub" style="margin-bottom:10px">${esc(t("pmx.sub"))}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead>${head}</thead><tbody>${body}</tbody></table>
      <div class="pd" style="margin-top:10px">${esc(t("pmx.note"))}</div>
    </div>`;
  const close = (): void => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  document.body.appendChild(ov);
  ov.querySelector<HTMLButtonElement>("#pmx-close")!.onclick = close;
}

/** Regista o comando da paleta e as strings. Chamar antes de `bootShell()`. */
export function initPolicyMatrix(): void {
  registerStrings(PMX_STRINGS);
  addCommand({ id: "codev:policy", label: () => t("pmx.cmd"), run: () => void openMatrix() });
}

const PMX_STRINGS = {
  en: {
    "pmx.cmd": "Co-Dev: mode policy matrix",
    "pmx.title": "Co-Dev mode policy",
    "pmx.sub": "What each collaboration mode requires. The backend decides this (codev_policy); this view only reads it.",
    "pmx.close": "Close",
    "pmx.edits": "Anchored edits",
    "pmx.commands": "Non-destructive commands",
    "pmx.chains": "Chains steps automatically",
    "pmx.destructive": "Destructive actions & push",
    "pmx.asks": "asks",
    "pmx.auto": "automatic",
    "pmx.note": "Destructive filesystem/VCS actions and push ASK in every mode — Auto chains steps, it never removes that guarantee.",
    "pmx.err": "Could not read the policy: {e}",
  },
  ptAO: {
    "pmx.cmd": "Co-Dev: matriz de política dos modos",
    "pmx.title": "Política dos modos do Co-Dev",
    "pmx.sub": "O que cada modo de colaboração exige. O backend decide isto (codev_policy); esta vista só o lê.",
    "pmx.close": "Fechar",
    "pmx.edits": "Edições ancoradas",
    "pmx.commands": "Comandos não-destrutivos",
    "pmx.chains": "Encadeia passos automaticamente",
    "pmx.destructive": "Acções destrutivas & push",
    "pmx.asks": "pede",
    "pmx.auto": "automático",
    "pmx.note": "Acções destrutivas de ficheiros/VCS e push PEDEM em todos os modos — o Auto encadeia passos, nunca remove essa garantia.",
    "pmx.err": "Não foi possível ler a política: {e}",
  },
};
