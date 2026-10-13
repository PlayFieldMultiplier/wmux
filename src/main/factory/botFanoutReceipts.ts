// ─── Bot fan-out receipts — `<wmuxDir>/factory/bot-fanout-keys.json` ───────
//
// A bot's fan-out key is `wake:<wakeId>:<n>`, and a wake that is resumed
// after a restart keeps its id, so it re-sends the same keys. Fan-out's own
// poll bookkeeping is per process; this durable set of the keys that were
// accepted lets a key that already ran before a restart answer "already ran"
// instead of starting the same workers a second time. Kept 14 days, at most
// RECEIPTS_MAX keys (oldest dropped first).

import path from 'node:path';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const BOT_FANOUT_RECEIPTS_VERSION = 1 as const;
export const RECEIPT_RETAIN_MS = 14 * 24 * 3_600_000;
export const RECEIPTS_MAX = 5_000;

export function botFanoutReceiptsPath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', 'bot-fanout-keys.json');
}

export class BotFanoutReceipts {
  private keys = new Map<string, number>();
  private readonly persister: FilePersister;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.persister = createFilePersister(file, () => ({
      version: BOT_FANOUT_RECEIPTS_VERSION,
      keys: Object.fromEntries(this.keys),
    }));
  }

  /** Throws on another version; malformed entries are dropped. */
  load(): void {
    const raw = readVersionedFile(this.file, BOT_FANOUT_RECEIPTS_VERSION);
    this.keys.clear();
    const map = raw?.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys) ? (raw.keys as Record<string, unknown>) : {};
    for (const [k, at] of Object.entries(map)) {
      if (k.length > 0 && k.length <= 512 && Number.isSafeInteger(at)) this.keys.set(k, at as number);
    }
    this.prune();
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    if (this.keys.has(key)) return;
    this.keys.set(key, this.now());
    this.prune();
    void this.flush().catch((err) => console.warn(`[factory] bot-fanout-keys.json write failed: ${String(err)}`));
  }

  flush(): Promise<void> {
    return this.persister.schedule();
  }

  private prune(): void {
    const cutoff = this.now() - RECEIPT_RETAIN_MS;
    for (const [k, at] of this.keys) if (at < cutoff) this.keys.delete(k);
    while (this.keys.size > RECEIPTS_MAX) {
      const oldest = this.keys.keys().next();
      if (oldest.done) break;
      this.keys.delete(oldest.value);
    }
  }
}

let current: BotFanoutReceipts | null = null;

export function setBotFanoutReceipts(r: BotFanoutReceipts | null): void {
  current = r;
}

export function getBotFanoutReceipts(): BotFanoutReceipts | null {
  return current;
}
