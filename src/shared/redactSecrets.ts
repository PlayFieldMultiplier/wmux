// Masks credentials inside free text before it is written to a log or shown
// in a report: the inline URL credentials the IPC log already masks
// (main/ipc/wrapHandler.ts), and key-shaped values — OpenAI/Anthropic `sk-…`,
// GitHub `ghp_…`/`github_pat_…`, AWS `AKIA…`/`ASIA…`, Slack `xox?-…`, private
// key headers, a long random string after a key/secret/token/password name,
// and any other long random-looking token. Pure, no Node imports, so main,
// the daemon and the CLI share it.

export const REDACTED = '[redacted]';

/**
 * Credentials that ride INSIDE a string — a query `token=`/`code=` or the
 * computer pairing link's `#wmux-desktop-code=` fragment.
 */
const INLINE_CREDENTIAL = /([?&#](?:token|code|wmux-desktop-code)=)(?!%5Bredacted%5D|\[redacted\])[^&#\s"'\\]+/gi;

export function maskInlineCredentials(s: string): string {
  return s.replace(INLINE_CREDENTIAL, '$1[redacted]');
}

const KEY_SHAPES: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
];

/** `name = value` where the name says secret; the value is masked. */
const ASSIGNED = /((?:key|secret|token|passw(?:or)?d|pwd|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*["'`]?)([^\s"'`]{8,})/gi;

/** A long run of token characters; masked when it looks random. */
const LONG_TOKEN = /[A-Za-z0-9+/_\-=.]{24,}/g;

function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

function looksRandom(s: string): boolean {
  return /[0-9]/.test(s) && /[A-Za-z]/.test(s) && entropy(s) >= 3.5;
}

/** `s` with every credential it carries replaced by [redacted]. */
export function redactSecrets(s: string): string {
  let out = maskInlineCredentials(s);
  for (const re of KEY_SHAPES) out = out.replace(re, REDACTED);
  out = out.replace(ASSIGNED, (m, name: string, value: string) => (value === REDACTED ? m : `${name}${REDACTED}`));
  out = out.replace(LONG_TOKEN, (m) => (m.includes(REDACTED) || !looksRandom(m) ? m : REDACTED));
  return out;
}
