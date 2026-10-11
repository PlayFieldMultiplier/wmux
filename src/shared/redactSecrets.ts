// The ONE place wmux knows what a credential looks like. Two uses:
//
//   - redactSecrets(): mask credentials inside free text before it is logged
//     or shown (IPC log via main/ipc/wrapHandler.ts, the detection agreement
//     log and `wmux doctor detect`).
//   - secretValueKind(): say whether one added line carries a key, for the
//     outbound guard (shared/secretGuard.ts: commit / push / PR / adopt / Moa
//     delivery, and the pre-commit hook).
//
// Both read the same KEY_RULES, so a key shape added here is masked in logs
// AND blocked from leaving the machine. Pure, no Node imports.

export const REDACTED = '[redacted]';

/** What kind of credential a value is (never the value itself). */
export type SecretValueKind =
  | 'private-key'
  | 'anthropic'
  | 'openai'
  | 'github'
  | 'gitlab'
  | 'aws'
  | 'google'
  | 'stripe'
  | 'slack'
  | 'npm'
  | 'twilio'
  | 'jwt'
  | 'random';

/** Key shapes, most specific first (sk-ant- before sk-). Not global: callers
 *  that replace build a global copy. */
export const KEY_RULES: readonly (readonly [SecretValueKind, RegExp])[] = [
  ['private-key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['gitlab', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['aws', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['google', /\bAIza[0-9A-Za-z_-]{35}/],
  ['stripe', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ['slack', /\b(?:xox[abposr]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})/],
  ['npm', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['twilio', /\bSK[0-9a-fA-F]{32}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

/** `name = value` where the name says secret. */
const ASSIGNED_SRC = '((?:key|secret|token|passw(?:or)?d|pwd|credential)[A-Za-z0-9_-]*["\']?\\s*[:=]\\s*["\'`]?)';

/** A long run of token characters. */
const LONG_TOKEN = /[A-Za-z0-9+/_\-=.]{24,}/g;

function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

/** Mixes letters and digits and is not a placeholder, with at least `bits`
 *  of entropy per character. */
export function looksRandom(s: string, bits = 3.5): boolean {
  return /[0-9]/.test(s) && /[A-Za-z]/.test(s) && !/^(x+|\*+|your[_-]|changeme|example)/i.test(s) && entropy(s) >= bits;
}

// ── Detection: one line of added text ──────────────────────────────────────

const ASSIGNED_DETECT = new RegExp(`${ASSIGNED_SRC}([A-Za-z0-9+/_\\-.=]{24,})`, 'i');

/** The kind of credential on one line, or null. Stricter than redaction on
 *  the `name = value` form (long and random), because a false block is
 *  worse than a false mask. */
export function secretValueKind(line: string): SecretValueKind | null {
  for (const [kind, re] of KEY_RULES) if (re.test(line)) return kind;
  const m = ASSIGNED_DETECT.exec(line);
  return m && looksRandom(m[2], 4) ? 'random' : null;
}

// ── Redaction: free text ───────────────────────────────────────────────────

/**
 * Credentials that ride INSIDE a string — a query `token=`/`code=` or the
 * computer pairing link's `#wmux-desktop-code=` fragment.
 */
const INLINE_CREDENTIAL = /([?&#](?:token|code|wmux-desktop-code)=)(?!%5Bredacted%5D|\[redacted\])[^&#\s"'\\]+/gi;

export function maskInlineCredentials(s: string): string {
  return s.replace(INLINE_CREDENTIAL, '$1[redacted]');
}

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g;
const KEY_RULES_GLOBAL = KEY_RULES.filter(([k]) => k !== 'private-key').map(([, re]) => new RegExp(re.source, `${re.flags}g`));
const ASSIGNED_REDACT = new RegExp(`${ASSIGNED_SRC}([^\\s"'\`]{8,})`, 'gi');

/** `s` with every credential it carries replaced by [redacted]. */
export function redactSecrets(s: string): string {
  let out = maskInlineCredentials(s).replace(PRIVATE_KEY_BLOCK, REDACTED);
  for (const re of KEY_RULES_GLOBAL) out = out.replace(re, REDACTED);
  out = out.replace(ASSIGNED_REDACT, (m, name: string, value: string) => (value === REDACTED ? m : `${name}${REDACTED}`));
  out = out.replace(LONG_TOKEN, (m) => (m.includes(REDACTED) || !looksRandom(m) ? m : REDACTED));
  return out;
}
