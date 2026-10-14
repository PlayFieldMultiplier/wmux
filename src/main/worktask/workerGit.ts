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
  /^push\.recursesubmodules$/,
];

/** Why main will not run git with this repository and worktree config, or
 *  null. Only the repository's own scopes count (`local`, `worktree`): the
 *  system and the owner's global config are the owner's. Pure. */
export function workerGitConfigRefusal(entries: readonly GitConfigEntry[]): string | null {
  const own = entries.filter((e) => e.scope === 'local' || e.scope === 'worktree');
  const hit = own.find((e) => PROGRAM_KEYS.some((re) => re.test(e.key)));
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
 *  (lowercased), or null for any other form (a path, file://, ext::, a
 *  port, a query). Pure. */
export function originUrlRepoKey(url: string): string | null {
  const seg = '[A-Za-z0-9_.-]+';
  const forms = [
    new RegExp(`^https://(?:${seg}@)?(${seg})/(${seg})/(${seg})$`),
    new RegExp(`^ssh://${seg}@(${seg})/(${seg})/(${seg})$`),
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

/** Read the worktree's config and refuse what main does not run git with. */
export async function workerGitPreflight(run: WorkerGitRun): Promise<{ ok: true; entries: GitConfigEntry[] } | { ok: false; error: string }> {
  const r = await run(['config', '-z', '--list', '--show-scope']);
  if (r.code !== 0) return { ok: false, error: `git config --list failed: ${r.stderr.trim().slice(0, 300)}` };
  const entries = parseGitConfigList(r.stdout);
  const refusal = workerGitConfigRefusal(entries);
  return refusal ? { ok: false, error: refusal } : { ok: true, entries };
}
