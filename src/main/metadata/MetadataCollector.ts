import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';

const execFileAsync = promisify(execFile);

/** How long a resolved branch is reused before `git` is asked again. */
export const GIT_BRANCH_HIT_TTL_MS = 15_000;
/**
 * How long "not a repo" is remembered. A pane sitting in `~` or `C:\` has no
 * watcher branch to short-circuit the fallback, so without this the 5 s poll
 * spawned `git rev-parse` for it every tick, forever, in the Electron main
 * process — one spawn per such pane per 5 s, competing with PTY forwarding.
 * A directory that becomes a repo (`git init`, `git clone .`) is picked up at
 * the next expiry; the watcher path still reports a branch the moment the
 * shell integration or GitContextWatcher sees one.
 */
export const GIT_BRANCH_MISS_TTL_MS = 60_000;
/** Bound on remembered directories. */
export const GIT_BRANCH_CACHE_MAX = 256;

interface BranchEntry {
  branch: string | undefined;
  expiresAt: number;
  inflight?: Promise<string | undefined>;
}

// X1: the old machine-global getListeningPorts()/collect() pair is gone —
// ports are now PID-tree-scoped via PortWatcher (src/main/pty/portWatch.ts)
// and the metadata poll assembles payloads from watcher-fed caches
// (metadata.handler.buildMetadataPayload). Only the git-branch exec
// fallback remains, for sessions the fs.watch GitContextWatcher missed.
export class MetadataCollector {
  private readonly branches = new Map<string, BranchEntry>();
  private readonly now: () => number;
  private readonly exec: (cwd: string) => Promise<string | undefined>;

  constructor(deps: {
    now?: () => number;
    /** Injected for tests; the default spawns `git rev-parse --abbrev-ref HEAD`. */
    exec?: (cwd: string) => Promise<string | undefined>;
  } = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.exec = deps.exec ?? MetadataCollector.execGitBranch;
  }

  /**
   * The branch at `cwd`, or undefined when it is not inside a repo. Cached per
   * directory: a hit for GIT_BRANCH_HIT_TTL_MS, a miss for
   * GIT_BRANCH_MISS_TTL_MS. Concurrent callers for one directory share a
   * single spawn.
   */
  async getGitBranch(cwd: string): Promise<string | undefined> {
    const now = this.now();
    const cached = this.branches.get(cwd);
    if (cached) {
      if (cached.inflight) return cached.inflight;
      if (cached.expiresAt > now) return cached.branch;
    }
    const inflight = this.exec(cwd).then((branch) => {
      const settledAt = this.now();
      this.remember(cwd, {
        branch,
        expiresAt: settledAt + (branch ? GIT_BRANCH_HIT_TTL_MS : GIT_BRANCH_MISS_TTL_MS),
      });
      return branch;
    });
    this.remember(cwd, { branch: cached?.branch, expiresAt: 0, inflight });
    return inflight;
  }

  /** Drop what is remembered for a directory (or everything). */
  forget(cwd?: string): void {
    if (cwd === undefined) this.branches.clear();
    else this.branches.delete(cwd);
  }

  private remember(cwd: string, entry: BranchEntry): void {
    // Re-insert so the map's iteration order is recency; evict the oldest.
    this.branches.delete(cwd);
    this.branches.set(cwd, entry);
    while (this.branches.size > GIT_BRANCH_CACHE_MAX) {
      const oldest = this.branches.keys().next().value;
      if (oldest === undefined) break;
      this.branches.delete(oldest);
    }
  }

  private static async execGitBranch(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        timeout: 3000,
        env: getExecEnv(),
      });
      const branch = stdout.trim();
      return branch || undefined;
    } catch {
      return undefined;
    }
  }
}
