import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
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
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private policy: A2aContinuePolicyV1;
  private readonly writable: boolean;

  constructor(opts: ContinuePolicyStoreOptions) {
    this.filePath = path.join(opts.dir, CONTINUE_POLICY_FILE);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: CONTINUE_POLICY_FILE,
      coerce: coerceContinuePolicy,
      now: opts.now ?? Date.now,
      log: opts.log ?? ((): void => undefined),
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
}
