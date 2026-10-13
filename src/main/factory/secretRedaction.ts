// ─── Stored bot secrets, kept out of what bots and stores see ──────────────
//
// The secret store (secretStore.ts) hands this module the values it holds;
// every place a stored value could otherwise reach a bot or a wmux store
// runs its text through `redactStoredSecrets`: RPC results to a bot token
// (RpcRouter — terminal reads among them), room cards (RoomWriter), facts
// (FactLog), handoffs (HandoffRouter), task-ledger summaries (TaskLedger),
// a bot's wake prompt (BotRuntime) and main's IPC error log (wrapHandler).
//
// A value is matched exactly, in its common encodings (base64 with and
// without padding, base64url, percent-encoding, JSON string escaping, hex),
// and also when a terminal wrapped it across lines. Each match becomes
// `[secret:NAME]`. With nothing stored this is the identity.

import { BOT_SECRET_LIMITS } from '../../shared/botSecret';

interface Needle { text: string; marker: string }

let needles: Needle[] = [];

/** A value the store may keep: well-formed Unicode (every form can be built). Pure. */
export function isRedactableSecretValue(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

/** The forms of one value that are matched. Pure. */
export function secretForms(value: string): string[] {
  const forms = new Set<string>([value]);
  // A value that is not well-formed Unicode is never stored
  // (isRedactableSecretValue); its raw form is still matched.
  if (!isRedactableSecretValue(value)) return [value];
  const bytes = Buffer.from(value, 'utf8');
  const b64 = bytes.toString('base64');
  forms.add(b64);
  forms.add(b64.replace(/=+$/, ''));
  forms.add(bytes.toString('base64url'));
  forms.add(encodeURIComponent(value));
  forms.add(JSON.stringify(value).slice(1, -1));
  const hex = bytes.toString('hex');
  forms.add(hex);
  forms.add(hex.toUpperCase());
  return [...forms].filter((f) => f.length >= BOT_SECRET_LIMITS.VALUE_MIN);
}

/** Replace the set of values matched (the secret store calls this on load,
 *  set and delete). */
export function setRedactedSecrets(entries: ReadonlyArray<{ name: string; value: string }>): void {
  const next: Needle[] = [];
  for (const e of entries) {
    if (typeof e.value !== 'string' || e.value.length < BOT_SECRET_LIMITS.VALUE_MIN) continue;
    for (const text of secretForms(e.value)) next.push({ text, marker: `[secret:${e.name}]` });
  }
  // Longest first, so a form that contains another is replaced whole.
  next.sort((a, b) => b.text.length - a.text.length);
  needles = next;
}

/** Whether any value is being matched. */
export function hasRedactedSecrets(): boolean {
  return needles.length > 0;
}

/** `text` with every stored value replaced by its marker, including a value
 *  a line break (\r or \n) cut in two. Identity when nothing matches. */
export function redactStoredSecrets(text: string): string {
  if (needles.length === 0 || typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const n of needles) {
    if (out.includes(n.text)) out = out.split(n.text).join(n.marker);
  }
  if (!/[\r\n]/.test(out)) return out;
  // A value wrapped across lines: match on the text without line breaks and
  // cut the matching span out of the original.
  for (const n of needles) {
    let stripped = '';
    const at: number[] = [];
    for (let i = 0; i < out.length; i += 1) {
      const c = out[i];
      if (c === '\r' || c === '\n') continue;
      stripped += c;
      at.push(i);
    }
    let from = stripped.indexOf(n.text);
    if (from < 0) continue;
    const spans: Array<[number, number]> = [];
    while (from >= 0) {
      spans.push([at[from], at[from + n.text.length - 1] + 1]);
      from = stripped.indexOf(n.text, from + n.text.length);
    }
    for (let k = spans.length - 1; k >= 0; k -= 1) {
      const [s, e] = spans[k];
      out = out.slice(0, s) + n.marker + out.slice(e);
    }
  }
  return out;
}

const MAX_DEPTH = 12;

/** A copy of `value` with every string in it (keys included) redacted; the
 *  same reference when nothing changed. Depth-capped: deeper structure is
 *  returned as-is only when nothing is stored. */
export function redactStoredSecretsDeep<T>(value: T): T {
  if (needles.length === 0) return value;
  return walk(value, 0) as T;
}

function walk(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactStoredSecrets(value);
  if (!value || typeof value !== 'object') return value;
  // Past the cap the structure is serialised and redacted as text rather than
  // passed through unseen.
  if (depth >= MAX_DEPTH) {
    try {
      const json = JSON.stringify(value);
      const red = redactStoredSecrets(json);
      return red === json ? value : JSON.parse(red);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = walk(v, depth + 1);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Keys too: a value used as a key is replaced like any other text.
    const key = redactStoredSecrets(k);
    const r = walk(v, depth + 1);
    if (r !== v || key !== k) changed = true;
    out[key] = r;
  }
  return changed ? out : value;
}

/** Test-only. */
export function __resetRedactedSecretsForTesting(): void {
  needles = [];
}
