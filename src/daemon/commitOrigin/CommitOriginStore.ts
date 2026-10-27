// `<wmuxDir>/commit-origins.json`: where commits made in wmux panes came from
// (shared/commitOrigin.ts), keyed by full SHA. Kept COMMIT_ORIGIN_RETENTION_MS
// and at most COMMIT_ORIGIN_MAX records (the oldest go first). Written
// atomically and synchronously (commits are rare; a quit flush can then never
// race an older write), a moment after each change. A file of another shape
// is moved aside and the store starts empty; so does one that does not parse.

import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../util/atomicWrite';
import { COMMIT_ORIGIN_SCHEMA, parseCommitOrigin, type CommitOrigin } from '../../shared/commitOrigin';

export const COMMIT_ORIGINS_FILE = 'commit-origins.json';
export const COMMIT_ORIGIN_MAX = 5000;
export const COMMIT_ORIGIN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 1000;

interface StoreFile {
  version: typeof COMMIT_ORIGIN_SCHEMA;
  origins: unknown[];
}

function isStoreFile(v: unknown): v is StoreFile {
  return !!v && typeof v === 'object' && (v as StoreFile).version === COMMIT_ORIGIN_SCHEMA && Array.isArray((v as StoreFile).origins);
}

export class CommitOriginStore {
  private readonly file: string;
  private readonly origins = new Map<string, CommitOrigin>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(wmuxDir: string, private readonly now: () => number = Date.now, private readonly log: (line: string) => void = () => undefined) {
    this.file = path.join(wmuxDir, COMMIT_ORIGINS_FILE);
    try {
      const file = atomicReadJSONSync(this.file, { validate: isStoreFile });
      for (const raw of file?.origins ?? []) {
        const o = parseCommitOrigin(raw);
        if (o) this.origins.set(o.sha, o);
      }
      this.prune();
    } catch (err) {
      this.log(`[commitOrigin] store unreadable, starting empty: ${String(err)}`);
    }
  }

  get(sha: string): CommitOrigin | null {
    return this.origins.get(sha.toLowerCase()) ?? null;
  }

  /** Record one; a SHA recorded before keeps its first record (the moment it was made). */
  add(origin: CommitOrigin): void {
    if (this.origins.has(origin.sha)) return;
    this.origins.set(origin.sha, origin);
    this.prune();
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flushSync(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Write a pending change now (the timer, and shutdown). */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    try {
      atomicWriteJSONSync(this.file, this.snapshot());
      this.dirty = false;
    } catch (err) {
      this.log(`[commitOrigin] save failed: ${String(err)}`);
    }
  }

  private snapshot(): StoreFile {
    return { version: COMMIT_ORIGIN_SCHEMA, origins: [...this.origins.values()] };
  }

  private prune(): void {
    const cutoff = this.now() - COMMIT_ORIGIN_RETENTION_MS;
    for (const [sha, o] of this.origins) if (o.at < cutoff) this.origins.delete(sha);
    if (this.origins.size <= COMMIT_ORIGIN_MAX) return;
    const oldest = [...this.origins.values()].sort((a, b) => a.at - b.at).slice(0, this.origins.size - COMMIT_ORIGIN_MAX);
    for (const o of oldest) this.origins.delete(o.sha);
  }
}
