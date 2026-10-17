// ─── Main's network git for a task repository: a main-owned relay ───────────
//
// Main never writes under the task's recorded repository. Its network git for
// a task (push, fetch, ls-remote) runs in a bare "relay" repository main owns,
// under main's data folder, one per task. The relay borrows the recorded
// repository's objects through `objects/info/alternates` (a one-way link: the
// relay reads the recorded objects, the recorded repository never reads the
// relay's). A fetch lands its objects in the relay, not the recorded
// repository; a push reads the commit from the recorded objects through the
// alternate. The worker then updates its own `refs/remotes/origin/*` from the
// relay with the fetch line main returns.
//
// Pure, and shared: the daemon's phone path builds the same argv and env.

/** Transports a relay call may use. */
export const RELAY_GIT_DEFAULT_PROTOCOLS: readonly string[] = ['https', 'ssh'];

/** The lowest git version main runs a task's network git with. */
export const TASK_GIT_VERSION_FLOOR = '2.43.4';

/** `-c` options on every relay call (after `safe`, main's own safe options):
 *  no automatic gc or maintenance, no commit-graph or multi-pack index read
 *  or written, and only the listed transports. */
export function relayGitConfigArgs(safe: readonly string[], protocols: readonly string[] = RELAY_GIT_DEFAULT_PROTOCOLS): string[] {
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

function ownerTransport(entries: readonly RawGitConfigEntry[]): RawGitConfigEntry[] {
  return entries.filter((e) => OWNER_SCOPES.has(e.scope) && TRANSPORT_KEY_RE.test(e.key));
}

function groupInOrder(entries: readonly RawGitConfigEntry[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) out.set(e.key, [...(out.get(e.key) ?? []), e.value]);
  return out;
}

/**
 * The `-c key=value` settings that make the relay's owner transport config
 * match the recorded repository's for every transport key that differs
 * between them (`context`: the config read with the recorded git dir;
 * `relay`: the config read in the relay). Only the owner scopes count (the
 * recorded repository's own config never carries over).
 *
 * A URL rewrite (`url.<base>.insteadOf`, `pushInsteadOf`) is only added, never
 * reset: an empty rewrite base matches every URL. Every other transport key is
 * reset (`key=`) and then replayed in the recorded order, so a value the owner
 * cleared for the repository is cleared in the relay too.
 */
export function transportConfigReplay(context: readonly RawGitConfigEntry[], relay: readonly RawGitConfigEntry[]): string[] {
  const ctx = groupInOrder(ownerTransport(context));
  const rel = groupInOrder(ownerTransport(relay));
  const out: string[] = [];
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (const [key, values] of ctx) {
    const have = rel.get(key) ?? [];
    if (same(values, have)) continue;
    if (/^url\./i.test(key)) {
      // Additive only: the recorded values the relay does not already have.
      const missing = [...values];
      for (const v of have) {
        const i = missing.indexOf(v);
        if (i >= 0) missing.splice(i, 1);
      }
      for (const v of missing) out.push(`${key}=${v}`);
    } else {
      out.push(`${key}=`);
      for (const v of values) out.push(`${key}=${v}`);
    }
  }
  // A key the relay has and the recorded repository does not (not from the
  // recorded owner config): reset it, except a URL rewrite.
  for (const [key] of rel) {
    if (!ctx.has(key) && !/^url\./i.test(key)) out.push(`${key}=`);
  }
  return out;
}

/** Why main will not run a task's git with this version, or null. `stdout` is
 *  `git --version` output. Pure. */
export function gitVersionRefusal(stdout: string, floor: string = TASK_GIT_VERSION_FLOOR): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (!m) return `git's version could not be read (${stdout.trim().slice(0, 80)})`;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  const want = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] > want[i]) return null;
    if (have[i] < want[i]) return `git ${have.join('.')} is older than ${floor}, which a task's network git needs`;
  }
  return null;
}

/** A shell word for the worker's shell: single-quoted on posix (a WSL distro
 *  included), double-quoted on a Windows host. Pure. */
export function shellQuote(word: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `"${word.replace(/(["%])/g, '^$1')}"`;
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/** The `git fetch` line the worker runs in its own shell to bring the fetched
 *  branches into its `refs/remotes/origin/*` from the relay. Pure. */
export function fetchCommandFor(relayPath: string, refspecs: readonly string[], platform: NodeJS.Platform): string {
  const q = (w: string) => shellQuote(w, platform);
  // `--no-write-fetch-head`: the worker only wants its `refs/remotes/origin/*`
  // updated, and a sandboxed worker (codexWorkerGuard) can write the common
  // dir's objects, refs and logs but not a FETCH_HEAD beside them.
  return ['git', 'fetch', '--no-tags', '--no-write-fetch-head', q(relayPath), ...refspecs.map(q)].join(' ');
}
