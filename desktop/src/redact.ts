// Secret redaction (OWASP LLM06 — Sensitive Information Disclosure).
//
// The workspace assistant sends the active file's content (and selection) to the chosen
// provider — which may be a THIRD PARTY (Anthropic / OpenAI / Gemini). If that file is a
// `.env`, a key file, or just has a token pasted in it, the secret would leave the machine.
// We mask the obvious secret shapes BEFORE the text is put in the prompt. This is a safety
// net, not a vault: it is deliberately conservative (mask on doubt) and pure/testable.

interface Rule {
  re: RegExp;
  // Replace the whole match, or keep capture group 1 (the key name) and mask the rest.
  group1?: boolean;
}

const MASK = "***REDACTED***";

// Order matters: block rules (PEM) first, then assignments, then standalone tokens.
const RULES: Rule[] = [
  // PEM private-key blocks (any type).
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // KEY=... / SECRET: ... / password = "..." style assignments (env, YAML, TOML, code).
  // Group 1 is the key name + separator, kept so the shape stays readable; value masked.
  {
    re: /((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth)\s*[:=]\s*)["']?[^\s"'#,]{6,}["']?/gi,
    group1: true,
  },
  // Provider-shaped standalone tokens.
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g }, // OpenAI / Anthropic
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g }, // GitHub PAT
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g }, // Slack
  { re: /\bAKIA[0-9A-Z]{16}\b/g }, // AWS access key id
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g }, // Google API key
  { re: /\bwrkspc_[A-Za-z0-9]{10,}\b/g }, // Anthropic workspace id
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g }, // JWT
  { re: /(Bearer\s+)[A-Za-z0-9._-]{12,}/g, group1: true }, // Authorization: Bearer <...>
];

/** Mask secret-looking substrings in `text`. Returns the redacted text and how many masks
 *  were applied (so the caller can tell the developer their secrets were stripped). */
export function redactSecrets(text: string): { text: string; count: number } {
  if (!text) return { text, count: 0 };
  let out = text;
  let count = 0;
  for (const rule of RULES) {
    out = out.replace(rule.re, (_m, g1?: string) => {
      count++;
      if (rule.group1 && g1 !== undefined) return g1 + MASK;
      return MASK;
    });
  }
  return { text: out, count };
}
