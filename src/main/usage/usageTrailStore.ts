// Persistence for UsageTrail: one JSON file in wmux's data dir, written
// atomically and at most once per SAVE_DEBOUNCE_MS, plus a synchronous flush
// for quit. A missing, corrupt or unknown-version file starts an empty trail.

import { atomicReadJSONSync, atomicWriteJSON, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { UsageSnapshot } from '../claude/UsageApi';
import { UsageTrail, isUsageTrailFile, type UsageTrailSample } from './usageTrail';

export const SAVE_DEBOUNCE_MS = 30 * 1000;

export interface UsageTrailStoreDeps {
  now?: () => number;
  log?: (line: string) => void;
}

export class UsageTrailStore {
  private readonly trail: UsageTrail;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(private readonly filePath: string, deps: UsageTrailStoreDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.warn(line));
    this.trail = this.load();
  }

  record(key: string, snapshot: UsageSnapshot | null): void {
    if (!this.trail.record(key, snapshot, this.now())) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  read(key: string, sinceMs?: number, untilMs?: number): UsageTrailSample[] {
    return this.trail.read(key, sinceMs, untilMs);
  }

  /** Write any pending change now, synchronously (quit path). */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      atomicWriteJSONSync(this.filePath, this.trail.toFile());
    } catch (err) {
      this.log(`[usageTrail] flush failed: ${String(err)}`);
    }
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await atomicWriteJSON(this.filePath, this.trail.toFile());
    } catch (err) {
      this.dirty = true; // the next change or the quit flush retries
      this.log(`[usageTrail] save failed: ${String(err)}`);
    }
  }

  private load(): UsageTrail {
    try {
      const file = atomicReadJSONSync(this.filePath, { validate: isUsageTrailFile });
      if (file) return UsageTrail.fromFile(file, this.now());
    } catch (err) {
      this.log(`[usageTrail] load failed, starting empty: ${String(err)}`);
    }
    return new UsageTrail();
  }
}
