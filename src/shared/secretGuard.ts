// Secret guard: what must never leave this computer in a commit, a push or a
// pull request — secret files (.env, private keys, credential stores) and
// key-shaped values (sk-…, ghp_…, AKIA…, xox…-, private key blocks, long random
// strings assigned to a key/secret/token/password).
//
// One rule set, shared by Moa's read gate (main/deck/moaReadGate.ts, which
// keeps a brain from READING these files) and every outbound path: the Git
// page's commit / push / PR (main/git/shipActions.ts), adopting a task into
// its parent (main/worktask/TaskAdoptService.ts) and Moa's own delivery
// (main/deck/moaGoalDelivery.ts). A finding never carries the value itself.

/** Folder names whose whole contents are secret. */
export const SECRET_DIR_SEGMENTS: readonly string[] = ['.git', '.ssh', '.gnupg', '.aws'];

/** File names that hold secrets. */
export const SECRET_FILE_NAMES: readonly RegExp[] = [
  /^\.env(\..*)?$/i, /\.(pem|key|p12|pfx|kdbx|keystore|jks|gpg|asc)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i, /^\.git-credentials$/i, /^\.pgpass$/i, /^\.npmrc$/i, /^\.netrc$/i, /^credentials/i,
];

/** A file whose name is only secret under one folder. */
export const SECRET_FILE_PAIRS: readonly (readonly [string, string])[] = [['.docker', 'config.json'], ['gh', 'hosts.yml']];

/** Committed on purpose, with no secret in them: templates, public keys, and
 *  files that are only secret when they carry a token (checked by content). */
const COMMITTABLE = [/\.(example|sample|template|dist|defaults?)$/i, /\.pub$/i, /^\.npmrc$/i, /^credentials.*\.(md|txt|ts|tsx|js|py|go|rs)$/i];

export type SecretKind = 'env' | 'private-key' | 'credentials' | 'openai' | 'github' | 'aws' | 'slack' | 'random';

export interface SecretFinding {
  /** Repository-relative path. */
  readonly path: string;
  /** 'file': the file itself is secret; 'value': a key-shaped value was added. */
  readonly what: 'file' | 'value';
  readonly kind: SecretKind;
  /** 1-based line in the new file, for a value. */
  readonly line?: number;
}

function baseAndParent(p: string): [string, string] {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return [parts[parts.length - 1] ?? '', (parts[parts.length - 2] ?? '').toLowerCase()];
}

/** The kind of secret a path is, or null — for a committed file. */
export function secretFileKind(p: string): SecretKind | null {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  const [base, parent] = baseAndParent(p);
  if (!base || COMMITTABLE.some((re) => re.test(base))) return null;
  if (parts.slice(0, -1).some((s) => SECRET_DIR_SEGMENTS.includes(s.toLowerCase()))) return 'credentials';
  if (/^\.env(\..*)?$/i.test(base)) return 'env';
  if (/\.(pem|key|p12|pfx|keystore|jks|gpg|asc)$/i.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)/i.test(base)) return 'private-key';
  if (SECRET_FILE_NAMES.some((re) => re.test(base))) return 'credentials';
  if (SECRET_FILE_PAIRS.some(([dir, file]) => parent === dir && base.toLowerCase() === file)) return 'credentials';
  return null;
}

const VALUE_RULES: readonly [SecretKind, RegExp][] = [
  ['private-key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['openai', /\bsk-(?:proj-|ant-[a-z0-9]{2,6}-)?[A-Za-z0-9_-]{20,}/],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['aws', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['slack', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
];

/** A long random-looking string assigned to something named like a secret. */
const ASSIGNED = /(?:key|secret|token|passw(?:or)?d|pwd|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*["'`]?([A-Za-z0-9+/_\-.=]{24,})/i;

function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

/** The kind of key-shaped value on one line of added text, or null. */
export function secretValueKind(line: string): SecretKind | null {
  for (const [kind, re] of VALUE_RULES) if (re.test(line)) return kind;
  const m = ASSIGNED.exec(line);
  if (m) {
    const v = m[1];
    // A random string mixes letters and digits and is not a placeholder.
    if (/[0-9]/.test(v) && /[A-Za-z]/.test(v) && !/^(x+|\*+|your[_-]|changeme|example)/i.test(v) && entropy(v) >= 4) return 'random';
  }
  return null;
}

/**
 * Secrets a unified diff ADDS (`git diff -U0`, a patch). Deleting a secret
 * file is fine; a binary secret file is caught by its name. At most `max`
 * findings, one per file and kind.
 */
export function scanUnifiedDiff(diff: string, max = 20): SecretFinding[] {
  const out: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (f: SecretFinding) => {
    const k = `${f.path}\0${f.what}\0${f.kind}`;
    if (seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(f);
  };
  let file: string | null = null;
  let deleted = false;
  let line = 0;
  const startFile = (p: string) => {
    file = p;
    const kind = deleted ? null : secretFileKind(p);
    if (kind) add({ path: p, what: 'file', kind });
  };
  for (const raw of diff.split('\n')) {
    const l = raw.replace(/\r$/, '');
    if (l.startsWith('diff --git ')) {
      file = null;
      deleted = false;
      const m = / b\/(.+)$/.exec(l);
      // Named by the +++ line when there is one; a binary file has none.
      if (m) file = `\0${m[1]}`;
      continue;
    }
    if (l.startsWith('deleted file mode')) { deleted = true; continue; }
    if (l.startsWith('Binary files ') && file?.startsWith('\0')) { startFile(file.slice(1)); continue; }
    if (l.startsWith('+++ ')) {
      if (l === '+++ /dev/null') { file = null; continue; }
      startFile(l.slice(4).replace(/^b\//, '').replace(/\t.*$/, ''));
      continue;
    }
    if (l.startsWith('--- ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (!file || file.startsWith('\0')) continue;
    if (l.startsWith('+')) {
      const kind = secretValueKind(l.slice(1));
      if (kind) add({ path: file, what: 'value', kind, line });
      line++;
    } else if (l.startsWith(' ')) {
      line++;
    }
  }
  return out;
}

const KIND_WORDS: Record<SecretKind, string> = {
  env: 'passwords and keys',
  'private-key': 'a private key',
  credentials: 'login credentials',
  openai: 'an AI service API key',
  github: 'a GitHub token',
  aws: 'an AWS access key',
  slack: 'a Slack token',
  random: 'what looks like a password or key',
};

/** One plain-English sentence for logs and Moa's record (the UI localizes
 *  from the findings instead). Never includes the value. */
export function describeSecretFindings(findings: readonly SecretFinding[], action = 'sent'): string {
  const f = findings[0];
  const head = f.what === 'file'
    ? `${f.path} holds ${KIND_WORDS[f.kind]}, so it was not ${action}`
    : `${f.path}${f.line ? ` line ${f.line}` : ''} contains ${KIND_WORDS[f.kind]}, so it was not ${action}`;
  const more = findings.length > 1 ? ` (and ${findings.length - 1} more)` : '';
  return `${head}${more}. Remove it from the change (or add it to .gitignore) and try again.`;
}
