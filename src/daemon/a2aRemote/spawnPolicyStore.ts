import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { getExecEnv } from '../../shared/execEnv';
import { coerceSpawnPolicy, defaultSpawnPolicy, type A2aSpawnPolicySetResult, type A2aSpawnPolicyV1 } from '../../shared/a2aSpawn';
import type { HostId } from '../../shared/a2aRemote';
import { loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Remote spawn policy (`spawn-policy.json`): who may ask this PC to start a
 * new agent, where, and which agents. A missing file is the default: off,
 * nobody allowed.
 *
 * Only the app's own human changes it (`wmux.internal` RPCs). That is not a
 * boundary against code running as the same user on this PC; the boundary is
 * this PC's per-PC opt-in and its approval of each request.
 *
 * Roots: every save resolves each root to its realpath and requires it to be
 * a git repository's top level (an agent only ever works in a fresh worktree
 * of one). The resolved path is what is stored, and what a request's folder
 * is checked against.
 */

export const SPAWN_POLICY_FILE = 'spawn-policy.json';

/** The repository top level of `dir` (realpath), or null when it is not inside one. */
export type RepoToplevel = (dir: string) => Promise<string | null>;

export interface SpawnPolicyStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seams. */
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
  repoToplevel?: RepoToplevel;
  realpath?: (p: string) => Promise<string>;
}

export class SpawnPolicyStore {
  readonly filePath: string;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly repoToplevel: RepoToplevel;
  private readonly realpath: (p: string) => Promise<string>;
  private policy: A2aSpawnPolicyV1;
  private writable: boolean;

  constructor(opts: SpawnPolicyStoreOptions) {
    this.filePath = path.join(opts.dir, SPAWN_POLICY_FILE);
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    this.repoToplevel = opts.repoToplevel ?? gitToplevel;
    this.realpath = opts.realpath ?? ((p) => fs.promises.realpath(p));
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: SPAWN_POLICY_FILE,
      coerce: coerceSpawnPolicy,
      now: opts.now ?? Date.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'remote spawn starts off, with nobody allowed',
    });
    this.policy = loaded.value ?? defaultSpawnPolicy();
    this.writable = loaded.writable;
  }

  get(): A2aSpawnPolicyV1 {
    return structuredClone(this.policy);
  }

  /**
   * Replace the policy with `raw`, after checking it whole: each root must
   * resolve to a git repository's top level, and is stored as that realpath.
   * `version` is this store's, never the caller's.
   */
  async set(raw: unknown): Promise<A2aSpawnPolicySetResult> {
    if (!this.writable) return { ok: false, error: storeUnavailable(SPAWN_POLICY_FILE).message };
    const next = coerceSpawnPolicy(raw);
    if (!next) return { ok: false, error: 'the policy is not valid' };
    const roots: A2aSpawnPolicyV1['roots'] = [];
    for (const root of next.roots) {
      if (!path.isAbsolute(root.path)) return { ok: false, error: `${root.label}: the folder must be an absolute path` };
      let real: string;
      try {
        real = await this.realpath(root.path);
      } catch {
        return { ok: false, error: `${root.label}: the folder does not exist` };
      }
      const top = await this.repoToplevel(real);
      if (top === null || !samePath(top, real)) return { ok: false, error: `${root.label}: the folder must be the top level of a git repository` };
      roots.push({ ...root, path: real });
    }
    const saved: A2aSpawnPolicyV1 = { ...next, roots, version: this.policy.version + 1 };
    this.write(this.filePath, saved);
    this.scheduleHarden(this.filePath);
    this.policy = saved;
    return { ok: true, policy: structuredClone(saved) };
  }

  /** A paired PC was removed: it is no longer allowed and its rules go (a re-pair starts from nothing). */
  forgetHost(hostId: HostId): boolean {
    const had = hostId in this.policy.hosts || this.policy.rules.some((r) => r.hostId === hostId);
    if (!had) return false;
    if (!this.writable) throw storeUnavailable(SPAWN_POLICY_FILE);
    const hosts = { ...this.policy.hosts };
    delete hosts[hostId];
    const saved: A2aSpawnPolicyV1 = {
      ...this.policy,
      hosts,
      rules: this.policy.rules.filter((r) => r.hostId !== hostId),
      version: this.policy.version + 1,
    };
    this.write(this.filePath, saved);
    this.scheduleHarden(this.filePath);
    this.policy = saved;
    return true;
  }
}

/** Case-insensitive on the platforms whose default file systems are. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => path.resolve(p);
  return platform === 'win32' || platform === 'darwin' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * `git rev-parse --show-toplevel` in `dir`, realpath'd. Read-only: no hooks
 * run for rev-parse, and fsmonitor is off for this call.
 */
const gitToplevel: RepoToplevel = (dir) => new Promise((resolve) => {
  execFile('git', ['-c', 'core.fsmonitor=false', '-C', dir, 'rev-parse', '--show-toplevel'], {
    env: getExecEnv(), timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024,
  }, (err, stdout) => {
    if (err) return resolve(null);
    const top = String(stdout).trim();
    if (!top) return resolve(null);
    fs.promises.realpath(top).then(resolve, () => resolve(null));
  });
});
