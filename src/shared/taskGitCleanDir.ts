// ─── Main's network git for a task repository, and its ref writes ───────────
//
// Main's push, fetch and ls-remote for a task do not run in the task's
// repository. Each runs in a fresh, empty bare git dir main creates for that
// one call (under main's data folder) and deletes afterwards: GIT_DIR is that
// clean dir and GIT_OBJECT_DIRECTORY is the objects folder of the repository
// main recorded for the task. Git then reads the system and the owner's
// global config, the clean dir's own config (origin's URL, written by main)
// and the `-c` options below — never the task repository's config.
//
// Main's own writes into the task repository (a remote-tracking ref) name
// that repository by the path main recorded (`--git-dir`), and the path the
// ref is written at is checked first (guardedRefPathRefusal).
//
// Pure, and shared: the daemon's phone push builds the same argv and env.

/** Transports a clean-dir call may use. */
export const CLEAN_GIT_DEFAULT_PROTOCOLS: readonly string[] = ['https', 'ssh'];

/** `-c` options on every clean-dir call (after `safe`, main's own safe
 *  options): no automatic gc or maintenance, no commit-graph or multi-pack
 *  index read or written, and only the listed transports. */
export function cleanGitConfigArgs(safe: readonly string[], protocols: readonly string[] = CLEAN_GIT_DEFAULT_PROTOCOLS): string[] {
  const forced = [
    'gc.auto=0',
    'maintenance.auto=false',
    'core.commitGraph=false',
    'core.multiPackIndex=false',
    'protocol.allow=never',
    ...protocols.map((p) => `protocol.${p}.allow=always`),
  ];
  return [...safe, ...forced.flatMap((kv) => ['-c', kv])];
}

/** The env a clean-dir call adds: the clean dir, the recorded repository's
 *  objects, and `config` as GIT_CONFIG_COUNT entries. GIT_CONFIG_NOSYSTEM is
 *  never set: the system config holds the platform's credential helper. */
export function cleanGitEnv(cleanDir: string, objectDir: string, config: ReadonlyArray<readonly [string, string]> = []): Record<string, string> {
  const env: Record<string, string> = { GIT_DIR: cleanDir, GIT_OBJECT_DIRECTORY: objectDir };
  if (config.length > 0) {
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = v;
    });
  }
  return env;
}

export interface RawGitConfigEntry { scope: string; key: string; value: string }

/** `git config -z --list --show-scope` output → entries, keys as git printed
 *  them (a subsection keeps its case). */
export function parseRawGitConfigList(stdout: string): RawGitConfigEntry[] {
  const parts = stdout.split('\0');
  const out: RawGitConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const nl = parts[i + 1].indexOf('\n');
    out.push({ scope: parts[i], key: nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl), value: nl < 0 ? '' : parts[i + 1].slice(nl + 1) });
  }
  return out;
}

/** Keys of how git connects and authenticates. */
const TRANSPORT_KEY_RE = /^(?:credential\.|url\.|http\.|ssh\.)|^core\.sshcommand$/i;
/** Scopes that are the owner's, not the repository's. */
const OWNER_SCOPES = new Set(['system', 'global', 'unknown']);

/**
 * The owner's transport settings that apply to the recorded repository but
 * not to a clean dir — the ones a conditional include (`includeIf "gitdir:…"`)
 * adds for that repository's path — as `[key, value]` pairs in the order git
 * read them. `context` is the config list read with the recorded repository
 * as the git dir, `clean` the one read in a clean dir; only the system and
 * global scopes count. A value the clean dir already has, in the same order,
 * is not repeated.
 */
export function transportConfigDiff(context: readonly RawGitConfigEntry[], clean: readonly RawGitConfigEntry[]): Array<[string, string]> {
  const owner = (e: RawGitConfigEntry) => OWNER_SCOPES.has(e.scope) && TRANSPORT_KEY_RE.test(e.key);
  const have = new Map<string, string[]>();
  for (const e of clean.filter(owner)) {
    const k = e.key.toLowerCase();
    have.set(k, [...(have.get(k) ?? []), e.value]);
  }
  const at = new Map<string, number>();
  const out: Array<[string, string]> = [];
  for (const e of context.filter(owner)) {
    const k = e.key.toLowerCase();
    const values = have.get(k) ?? [];
    const j = at.get(k) ?? 0;
    if (j < values.length && values[j] === e.value) {
      at.set(k, j + 1);
      continue;
    }
    out.push([e.key, e.value]);
  }
  return out;
}

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Up to this many of the recorded repository's commits are seeded into a
 *  clean dir before a fetch, so the fetch negotiates and checks connectivity
 *  against them instead of the whole history. */
export const CLEAN_GIT_SEED_MAX = 32;

/** A `packed-refs` file that holds each commit as `refs/seed/<i>`. */
export function cleanGitSeedPackedRefs(tips: readonly string[]): string {
  return tips.filter((t) => SHA_RE.test(t)).slice(0, CLEAN_GIT_SEED_MAX).map((t, i) => `${t} refs/seed/${i}\n`).join('');
}

/** `for-each-ref --format='%(objectname) %(objecttype)'` output → the
 *  commits it lists. */
export function parseSeedTips(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.replace(/\r/g, '').split('\n')) {
    const [sha, type] = line.trim().split(' ');
    if (type === 'commit' && SHA_RE.test(sha ?? '') && !out.includes(sha)) out.push(sha);
  }
  return out;
}

export type PathKind = 'dir' | 'file' | 'symlink' | 'other' | 'missing';

/** How the guarded-path check reads the filesystem the repository is on. */
export interface RefPathPorts {
  join: (...parts: string[]) => string;
  /** Each path's own kind, not following a symlink (a Windows junction is a
   *  symlink). */
  kinds: (paths: readonly string[]) => Promise<PathKind[]>;
  /** The path with every link resolved, or null. */
  realpath: (p: string) => Promise<string | null>;
  /** Windows paths compare case-insensitively. */
  caseInsensitive: boolean;
}

/**
 * Why main will not write `refname` (a `refs/remotes/origin/…` ref) in the
 * repository at `commonDir` (the path main recorded, already resolved), or
 * null. Every folder on the way to the loose ref and to its reflog must be a
 * real folder or not exist yet: a symlink or junction anywhere on the way, a
 * file where a folder is needed, a folder (or anything but a file) at the ref
 * itself, a `packed-refs` that is not a plain file, or a recorded path that
 * no longer resolves to itself, is refused.
 */
export async function guardedRefPathRefusal(commonDir: string, refname: string, ports: RefPathPorts): Promise<string | null> {
  const segs = refname.split('/');
  if (segs.length < 4 || segs[0] !== 'refs' || segs[1] !== 'remotes' || segs[2] !== 'origin' || segs.some((s) => !s || s === '.' || s === '..')) {
    return `${refname} is not a remote-tracking ref of origin`;
  }
  const same = (a: string, b: string) => (ports.caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  const real = await ports.realpath(commonDir);
  if (!real || !same(real, commonDir)) return `the repository folder ${commonDir} no longer resolves to itself`;
  const [packed] = await ports.kinds([ports.join(commonDir, 'packed-refs')]);
  if (packed !== 'missing' && packed !== 'file') return 'the repository\'s packed-refs is not a plain file';
  for (const chain of [segs, ['logs', ...segs]]) {
    const paths = chain.map((_, i) => ports.join(commonDir, ...chain.slice(0, i + 1)));
    const kinds = await ports.kinds(paths);
    let deepest = commonDir;
    for (let i = 0; i < paths.length; i++) {
      const kind = kinds[i];
      if (kind === 'missing') break;
      if (kind === 'symlink') return `${chain.slice(0, i + 1).join('/')} is a link`;
      const leaf = i === paths.length - 1;
      if (!leaf && kind !== 'dir') return `${chain.slice(0, i + 1).join('/')} is not a folder`;
      if (leaf && kind !== 'file') return `${chain.join('/')} is not a plain file`;
      if (!leaf) deepest = paths[i];
    }
    const resolved = await ports.realpath(deepest);
    if (!resolved || !same(resolved, deepest)) return `${deepest} does not resolve to itself`;
  }
  return null;
}
