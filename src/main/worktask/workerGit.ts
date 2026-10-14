// ─── Main's git in a worker's worktree ──────────────────────────────────────
//
// A worker can write its worktree's git config (the worktree's own and the
// repository's common one). Git runs programs that config names — an fsmonitor
// on a status read, an ssh command or a proxy on a push, a credential helper,
// a remote-helper — and main's git would run them outside the worker's
// sandbox. So before main runs git in a worker's worktree it reads the
// repository and worktree config (includes resolved) and refuses to go on
// when any such key is set there, and every call carries
// WORKER_GIT_SAFE_ARGS (no fsmonitor, hooks from an empty folder).
//
// The same read pins a push: `origin` may hold only its URL and fetch
// refspec, no URL rewrite may exist, and the URL must be a plain https or ssh
// address of the repository main expects.

import { git, type GitResult } from '../git/git';

/** Runs git with `args` in the worktree; never throws. */
export type WorkerGitRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `-c` options on every main-side git call in a worker's worktree. */
export function workerGitSafeArgs(noHooksDir: string): string[] {
  return ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooksDir}`];
}

export interface GitConfigEntry { scope: string; key: string; value: string }

/** `git config -z --list --show-scope` output → entries. Pure. */
export function parseGitConfigList(stdout: string): GitConfigEntry[] {
  const parts = stdout.split('\0');
  const out: GitConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const nl = parts[i + 1].indexOf('\n');
    const key = nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl);
    out.push({ scope: parts[i], key: key.toLowerCase(), value: nl < 0 ? '' : parts[i + 1].slice(nl + 1) });
  }
  return out;
}

/** Keys that make git run a program, read another file, or rewrite where
 *  git connects. */
const PROGRAM_KEYS: readonly RegExp[] = [
  /^core\.(?:fsmonitor|sshcommand|gitproxy|askpass|alternaterefscommand)$/,
  /^credential\./,
  /^include\.|^includeif\./,
  /^protocol\./,
  /^url\./,
  /^remote\..+\.(?:receivepack|uploadpack|vcs)$/,
  /^push\.(?:recursesubmodules|gpgsign)$/,
  // Where and how git's HTTP and ssh transports connect.
  /^http\./,
  /^ssh\./,
  // Signing programs and content filters (clean/smudge/process).
  /^gpg\./,
  /^filter\./,
];

/** What a read (status, rev-parse, hash-object, show) can run: a content
 *  filter. The fsmonitor is off on every main git call (git/git.ts). */
const READ_PROGRAM_KEYS: readonly RegExp[] = [/^filter\./];

/** Why main will not run git with this repository and worktree config, or
 *  null. Only the repository's own scopes count (`local`, `worktree`): the
 *  system and the owner's global config are the owner's. `read` checks only
 *  what a read can run. Pure. */
export function workerGitConfigRefusal(entries: readonly GitConfigEntry[], mode: 'all' | 'read' = 'all'): string | null {
  const own = entries.filter((e) => e.scope === 'local' || e.scope === 'worktree');
  const keys = mode === 'read' ? READ_PROGRAM_KEYS : PROGRAM_KEYS;
  const hit = own.find((e) => keys.some((re) => re.test(e.key)));
  return hit ? `the repository's git config sets ${hit.key}, which main does not run git with` : null;
}

/** Why main will not push to this repository's origin, or null; `url` is
 *  the one origin URL it pushes to. Pure. */
export function workerOriginRefusal(entries: readonly GitConfigEntry[]): { error: string } | { url: string } {
  const own = entries.filter((e) => e.scope === 'local' || e.scope === 'worktree');
  const origin = own.filter((e) => e.key.startsWith('remote.origin.'));
  const other = origin.find((e) => e.key !== 'remote.origin.url' && e.key !== 'remote.origin.fetch');
  if (other) return { error: `origin sets ${other.key}; main pushes only to origin's URL` };
  const urls = origin.filter((e) => e.key === 'remote.origin.url');
  if (urls.length === 0) return { error: 'the repository has no origin remote' };
  if (urls.length > 1) return { error: 'origin has more than one URL' };
  return { url: urls[0].value };
}

/** A plain https or ssh GitHub-style address → `host/owner/repo`
 *  (lowercased; a port is allowed and not part of the key), or null for any
 *  other form (a path, file://, ext::, a query, more path parts). Pure. */
export function originUrlRepoKey(url: string): string | null {
  const seg = '[A-Za-z0-9_.-]+';
  const forms = [
    new RegExp(`^https://(?:${seg}@)?(${seg})(?::\\d{1,5})?/(${seg})/(${seg})$`),
    new RegExp(`^ssh://${seg}@(${seg})(?::\\d{1,5})?/(${seg})/(${seg})$`),
    new RegExp(`^${seg}@(${seg}):(${seg})/(${seg})$`),
  ];
  const trimmed = url.trim().replace(/\/$/, '');
  for (const re of forms) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const repo = m[3].replace(/\.git$/i, '');
    if (!repo || [m[1], m[2], repo].some((p) => p === '.' || p === '..' || p.startsWith('-'))) return null;
    return `${m[1]}/${m[2]}/${repo}`.toLowerCase();
  }
  return null;
}

/** Main's git in a worker's worktree for a read (status, rev-parse,
 *  hash-object): the config check first; a refusal comes back as a failed
 *  call with the reason. */
export async function runWorkerGitRead(args: string[], cwd: string): Promise<GitResult> {
  const run = (a: string[]) => git(a, cwd);
  const pre = await workerGitPreflight(run, 'read');
  if (!pre.ok) return { stdout: '', stderr: pre.error, code: 1 };
  return run(args);
}

/** Read the worktree's config and refuse what main does not run git with. */
export async function workerGitPreflight(run: WorkerGitRun, mode: 'all' | 'read' = 'all'): Promise<{ ok: true; entries: GitConfigEntry[] } | { ok: false; error: string }> {
  const r = await run(['config', '-z', '--list', '--show-scope']);
  if (r.code !== 0) return { ok: false, error: `git config --list failed: ${r.stderr.trim().slice(0, 300)}` };
  const entries = parseGitConfigList(r.stdout);
  const refusal = workerGitConfigRefusal(entries, mode);
  return refusal ? { ok: false, error: refusal } : { ok: true, entries };
}
