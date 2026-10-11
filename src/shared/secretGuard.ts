// Secret guard: what must never leave this computer in a commit, a push or a
// pull request — secret files (.env, private keys, credential stores) and
// key-shaped values (sk-…, ghp_…, AKIA…, xox…-, private key blocks, long random
// strings assigned to a key/secret/token/password).
//
// The outbound paths — the Git page's commit / push / PR
// (main/git/shipActions.ts), adopting a task into its parent
// (main/worktask/TaskAdoptService.ts) and Moa's own delivery
// (main/deck/moaGoalDelivery.ts) — feed `git diff` / `git log -p` output
// through scanPatch(). Moa's read gate (main/deck/moaReadGate.ts, which keeps a
// brain from READING secret files) inlines the three name lists below. A
// finding never carries the value itself.

/** Folder names whose whole contents are secret (read gate). */
export const SECRET_DIR_SEGMENTS: readonly string[] = ['.git', '.ssh', '.gnupg', '.aws'];

/** File names that hold secrets (read gate). */
export const SECRET_FILE_NAMES: readonly RegExp[] = [
  /^\.env(\..*)?$/i, /\.(pem|key|p12|pfx|kdbx|keystore|jks|gpg|asc)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i, /^\.git-credentials$/i, /^\.pgpass$/i, /^\.npmrc$/i, /^\.netrc$/i, /^credentials/i,
];

/** A file whose name is only secret under one folder (read gate). */
export const SECRET_FILE_PAIRS: readonly (readonly [string, string])[] = [['.docker', 'config.json'], ['gh', 'hosts.yml']];

/** What kind of credential a value is (never the value itself). */
export type SecretValueKind =
  | 'private-key'
  | 'anthropic'
  | 'openai'
  | 'github'
  | 'gitlab'
  | 'aws'
  | 'stripe'
  | 'slack'
  | 'npm'
  | 'twilio'
  | 'random';

/** Key shapes that block, most specific first (sk-ant- before sk-). Also
 *  masked in logs (shared/redactSecrets.ts). Not global. */
export const KEY_RULES: readonly (readonly [SecretValueKind, RegExp])[] = [
  ['private-key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['gitlab', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['aws', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['stripe', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ['slack', /\b(?:xox[abposr]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})/],
  ['npm', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['twilio', /\bSK[0-9a-fA-F]{32}\b/],
];

/** `<name> = <value>` whose name ENDS in a secret word (apiKey, DB_PASSWORD,
 *  "token":) and whose value is one whole run of base64 characters. Dotted,
 *  slashed-with-dots, underscored or dashed values (storage keys, module ids,
 *  paths) are not this rule's business. */
const ASSIGNED = /([A-Za-z0-9_-]{0,64}?(?:key|secret|token|passw(?:or)?d|pwd|credentials?))["']?\s*[:=]\s*["'`]?([A-Za-z0-9+/=]{24,})(?![A-Za-z0-9+/=._-])/i;
/** Names that are public by design (browser / client keys). */
const PUBLIC_NAME = /public|publishable|anon|client_?id|vapid/i;

function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

/** Upper, lower and digits, high entropy. */
function generated(v: string): boolean {
  return /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v) && entropy(v) >= 4;
}

/** The kind of credential on one line of added text, or null. */
export function secretValueKind(line: string): SecretValueKind | null {
  for (const [kind, re] of KEY_RULES) if (re.test(line)) return kind;
  const m = ASSIGNED.exec(line);
  return m && !PUBLIC_NAME.test(m[1]) && generated(m[2]) ? 'random' : null;
}

/** A file's kind (env file, credential store, private key) — or a key's. */
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

/** How a file name is judged when the change adds it. */
type NameRule =
  /** Secret by name: refused when added. */
  | { by: 'name'; kind: SecretKind }
  /** An env / credential file: its added lines are read for assigned secrets. */
  | { by: 'content'; kind: 'env' | 'credentials' }
  | null;

/** Committed on purpose: templates (`.env.example`, `credentials.sample.json`). */
const TEMPLATE = /\.(example|sample|template|dist|defaults?)(\.|$)/i;

/** The rule for a path, by its name. */
function nameRule(p: string): NameRule {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  const lower = base.toLowerCase();
  const parent = (parts[parts.length - 2] ?? '').toLowerCase();
  if (!base || TEMPLATE.test(base)) return null;
  if (/^\.env(\.local|\..*\.local)?$/i.test(base)) return { by: 'name', kind: 'env' };
  if (/^\.env\./i.test(base)) return { by: 'content', kind: 'env' };
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(base)) return { by: 'name', kind: 'private-key' };
  if (/\.(p12|pfx|jks)$/i.test(base) || (/\.keystore$/i.test(base) && lower !== 'debug.keystore')) return { by: 'name', kind: 'private-key' };
  if (/\.kdbx$/i.test(base) || /^\.(git-credentials|pgpass|netrc)$/i.test(base)) return { by: 'name', kind: 'credentials' };
  const dirs = parts.slice(0, -1).map((s) => s.toLowerCase());
  if (dirs.includes('.ssh') && !/\.pub$|^(known_hosts|authorized_keys|config)$/i.test(base)) return { by: 'name', kind: 'private-key' };
  if (dirs.includes('.gnupg') && !/\.(conf|pub)$/i.test(base)) return { by: 'name', kind: 'private-key' };
  if (dirs.includes('.aws') && lower === 'credentials') return { by: 'name', kind: 'credentials' };
  if (/^credentials(\.(json|ya?ml|xml|ini|toml|cfg|conf))?$/i.test(base)) return { by: 'content', kind: 'credentials' };
  if (SECRET_FILE_PAIRS.some(([dir, file]) => parent === dir && lower === file)) return { by: 'content', kind: 'credentials' };
  return null;
}

/** The kind a file is refused as when a change ADDS it, or null. */
export function secretFileKind(p: string): SecretKind | null {
  const r = nameRule(p);
  return r?.by === 'name' ? r.kind : null;
}

const PLACEHOLDER = /^(x{3,}|\*{3,}|<.*>|\$\{?\w+\}?|your[_-].*|changeme|change[_-]me|example.*|placeholder.*|dummy.*|test.*|none|null|true|false)$/i;
/** `NAME=value` in an env file, NAME saying secret and not public by design. */
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^"'\s#]*)/;
const ENV_SECRET_NAME = /key|secret|token|passw(?:or)?d|pwd|credential|private|dsn|database_url/i;
const ENV_PUBLIC_NAME = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)|public|publishable/i;
/** A credential field in a credentials file (JSON, YAML, INI). */
const CREDENTIAL_FIELD = /["']?(private_key|client_secret|refresh_token|access_token|oauth_token|secret_access_key|aws_secret_access_key|password|secret|auth)["']?\s*[:=]\s*["']?([^"'\s,]+)/i;

/** An assigned secret on one line of an env or credentials file. */
function assignedSecret(kind: 'env' | 'credentials', line: string): boolean {
  const m = kind === 'env' ? ENV_LINE.exec(line) : CREDENTIAL_FIELD.exec(line);
  if (!m) return false;
  if (kind === 'env' && (!ENV_SECRET_NAME.test(m[1]) || ENV_PUBLIC_NAME.test(m[1]))) return false;
  return m[2].length >= 8 && !PLACEHOLDER.test(m[2]);
}

/** One path a diff touches, from `--name-status -z --no-renames`. */
export interface ChangedPath {
  /** A(dded), M(odified) or T(ype changed). */
  readonly status: string;
  readonly path: string;
}

/** `git diff|log -z --name-status --no-renames` output → its paths in order
 *  (a `git log` commit line is a token starting with \x01). */
export function parseNameStatusZ(out: string): ChangedPath[] {
  const tok = out.split('\0');
  const files: ChangedPath[] = [];
  for (let i = 0; i < tok.length; i++) {
    const status = tok[i].replace(/^\n+/, '');
    if (!status || status.startsWith('\x01')) continue;
    files.push({ status: status[0], path: tok[++i] ?? '' });
  }
  return files;
}

/**
 * Reads a `-U0 --text --no-renames` patch line by line, file N of the patch
 * being path N of the name list (same diff, same order): a path is never read
 * from the patch text. Hunk line counts say where content ends, so a content
 * line can never be taken for a header. finish() is null when the patch did
 * not line up with the names (the caller refuses: nothing was checked).
 */
export class PatchScanner {
  private readonly out: SecretFinding[] = [];
  private readonly seen = new Set<string>();
  private idx = -1;
  private oldLeft = 0;
  private newLeft = 0;
  private line = 0;
  private header = false;
  /** The deletion half of a T(ype change), which git prints as two entries. */
  private typeDelete = false;
  private binary = false;
  private rule: NameRule = null;

  constructor(private readonly files: readonly ChangedPath[], private readonly max = 20) {}

  private add(f: SecretFinding): void {
    const k = `${f.path}\0${f.what}\0${f.kind}`;
    if (this.seen.has(k) || this.out.length >= this.max) return;
    this.seen.add(k);
    this.out.push(f);
  }

  private endFile(): void {
    const f = this.files[this.idx];
    if (f && this.rule?.by === 'name' && f.status !== 'M') this.add({ path: f.path, what: 'file', kind: this.rule.kind });
  }

  feed(raw: string): void {
    if (this.oldLeft > 0 || this.newLeft > 0) {
      const c = raw[0];
      if (c === '-') this.oldLeft--;
      else if (c === '+') { this.newLeft--; this.added(raw.slice(1).replace(/\r$/, '')); this.line++; }
      else if (c === ' ') { this.oldLeft--; this.newLeft--; this.line++; }
      return;
    }
    if (raw.startsWith('diff --git ')) {
      if (this.typeDelete) { this.typeDelete = false; this.header = true; return; }
      this.endFile();
      this.idx++;
      this.header = true;
      this.binary = false;
      this.rule = this.files[this.idx] ? nameRule(this.files[this.idx].path) : null;
      return;
    }
    if (this.header && raw.startsWith('deleted file mode') && this.files[this.idx]?.status === 'T') {
      this.typeDelete = true;
      return;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h) {
      this.header = false;
      this.oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      this.newLeft = h[3] === undefined ? 1 : Number(h[3]);
      this.line = Number(h[2]);
    }
  }

  private added(text: string): void {
    const f = this.files[this.idx];
    if (!f || this.typeDelete || this.binary) return;
    if (text.includes('\0')) { this.binary = true; return; }
    const kind = secretValueKind(text);
    if (kind) { this.add({ path: f.path, what: 'value', kind, line: this.line }); return; }
    if (this.rule?.by === 'content' && assignedSecret(this.rule.kind, text)) this.add({ path: f.path, what: 'value', kind: this.rule.kind, line: this.line });
  }

  finish(): SecretFinding[] | null {
    this.endFile();
    return this.idx + 1 === this.files.length && !this.typeDelete ? this.out : null;
  }
}

/** Secrets a patch adds, given its name list (see PatchScanner). */
export function scanPatch(files: readonly ChangedPath[], patch: string, max = 20): SecretFinding[] | null {
  const s = new PatchScanner(files, max);
  for (const l of patch.split('\n')) s.feed(l);
  return s.finish();
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
  stripe: 'a Stripe secret key',
  slack: 'a Slack token',
  npm: 'an npm token',
  twilio: 'a Twilio key',
  random: 'what looks like a password or key',
};

/** Plain-English reason when the check itself could not run: the action is
 *  refused. */
export function describeScanFailure(action = 'sent'): string {
  return `wmux could not read this change to check it for passwords and keys, so it was not ${action}. Try again; if it keeps failing, the check can be turned off in Settings › General.`;
}

/** One plain-English sentence for logs and Moa's record (the UI localizes
 *  from the findings instead). Never includes the value. */
export function describeSecretFindings(findings: readonly SecretFinding[], action = 'sent'): string {
  const f = findings[0];
  const head = f.what === 'file'
    ? `${f.path} holds ${KIND_WORDS[f.kind]}, so it was not ${action}. Remove it from the change (or add it to .gitignore) and try again.`
    : `${f.path}${f.line ? ` line ${f.line}` : ''} contains ${KIND_WORDS[f.kind]}, so it was not ${action}. Move it out of the file and try again.`;
  return findings.length > 1 ? `${head} (and ${findings.length - 1} more)` : head;
}
