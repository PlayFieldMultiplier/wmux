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

import { secretValueKind, type SecretValueKind } from './redactSecrets';

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

/** A secret file's kind, or a key's kind (shared/redactSecrets.ts). */
export type SecretKind = 'env' | 'credentials' | SecretValueKind;

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

/** The kind of key-shaped value on one line of added text, or null. The key
 *  shapes live in shared/redactSecrets.ts, shared with log redaction. */
export { secretValueKind };

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
  anthropic: 'an AI service API key',
  openai: 'an AI service API key',
  github: 'a GitHub token',
  gitlab: 'a GitLab token',
  aws: 'an AWS access key',
  google: 'a Google API key',
  stripe: 'a Stripe secret key',
  slack: 'a Slack token',
  npm: 'an npm token',
  twilio: 'a Twilio key',
  jwt: 'a login token (JWT)',
  random: 'what looks like a password or key',
};

/** Plain-English reason when the check itself could not run: the action is
 *  refused rather than let through unchecked. */
export function describeScanFailure(action = 'sent'): string {
  return `wmux could not check this change for passwords and keys, so it was not ${action}. Try again; if it keeps failing, commit fewer files at a time.`;
}

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
