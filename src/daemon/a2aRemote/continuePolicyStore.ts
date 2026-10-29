import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import type { HostId } from '../../shared/a2aRemote';
import { coerceContinuePolicy, defaultContinuePolicy, type A2aContinuePolicyV1 } from '../../shared/a2aContinue';
import { loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * This PC's policy for continuing conversations between PCs
 * (`continue-policy.json`): as B, whether it takes them (from the PCs,
 * folders and agents the remote-spawn policy allows); as A, the PCs it may
 * send one to. A missing file is the default: off both ways.
 *
 * Only the app's own human changes it, like the spawn policy.
 */

export const CONTINUE_POLICY_FILE = 'continue-policy.json';

export type ContinuePolicySetResult =
  | { ok: true; policy: A2aContinuePolicyV1 }
  | { ok: false; error: string; conflict?: true };

export interface ContinuePolicyStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seams. */
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

export class ContinuePolicyStore {
  readonly filePath: string;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private policy: A2aContinuePolicyV1;
  private readonly writable: boolean;

  constructor(opts: ContinuePolicyStoreOptions) {
    this.filePath = path.join(opts.dir, CONTINUE_POLICY_FILE);
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: CONTINUE_POLICY_FILE,
      coerce: coerceContinuePolicy,
      now: opts.now ?? Date.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'continuing conversations starts off both ways',
    });
    this.policy = loaded.value ?? defaultContinuePolicy();
    this.writable = loaded.writable;
  }

  get(): A2aContinuePolicyV1 {
    return structuredClone(this.policy);
  }

  /**
   * Replace the policy with `raw`. `raw.version` is the version the caller
   * read; a save whose version is no longer current is a `conflict` and
   * changes nothing. The write lands before the policy in memory changes.
   */
  set(raw: unknown): ContinuePolicySetResult {
    if (!this.writable) return { ok: false, error: storeUnavailable(CONTINUE_POLICY_FILE).message };
    const next = coerceContinuePolicy(raw);
    if (!next) return { ok: false, error: 'the policy is not valid' };
    if (next.version !== this.policy.version) return { ok: false, conflict: true, error: 'the settings changed in the meantime' };
    const saved: A2aContinuePolicyV1 = { ...next, version: this.policy.version + 1 };
    this.write(this.filePath, saved);
    this.scheduleHarden(this.filePath);
    this.policy = saved;
    return { ok: true, policy: structuredClone(saved) };
  }

  /** A paired PC was removed: this PC no longer sends it conversations (a re-pair starts from nothing). */
  forgetHost(hostId: HostId): boolean {
    return this.retainHosts((h) => h !== hostId, `forgetting ${hostId}`);
  }

  /**
   * Keep only the PCs `paired` still knows, e.g. on start. Memory first: the
   * live policy stops allowing a removed PC even when the file cannot be
   * written; that is logged, and the next save writes the whole policy again.
   */
  retainHosts(paired: (hostId: HostId) => boolean, why = 'dropping PCs no longer paired'): boolean {
    const gone = Object.keys(this.policy.out).filter((h) => !paired(h));
    if (gone.length === 0) return false;
    const out = { ...this.policy.out };
    for (const h of gone) delete out[h];
    this.policy = { ...this.policy, out, version: this.policy.version + 1 };
    try {
      if (!this.writable) throw storeUnavailable(CONTINUE_POLICY_FILE);
      this.write(this.filePath, this.policy);
      this.scheduleHarden(this.filePath);
    } catch (err) {
      this.log('error', `[a2a-remote] ${CONTINUE_POLICY_FILE}: not saved after ${why}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }
}
