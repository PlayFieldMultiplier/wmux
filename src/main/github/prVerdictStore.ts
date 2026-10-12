// ─── PR verdicts — what verifiers recorded on each PR head ───────────────────
//
// `<wmuxDir>/pr-verdicts.json`: `{version: 2, verdicts: PrVerdictRecord[]}`,
// append-only per (repoKey, prNumber, headSha). A version-1 file, and each v1
// record in it, is read as v2 (a v1 record is a v2 one without a bot or
// evidence); the next write stores it as v2. A FAIL is never erased: a
// later PASS is one more record beside it, a head holding a FAIL is never
// pruned, and a new head needs a verdict of its own anyway. A head with no
// FAIL whose newest record is older than PR_VERDICT_RETENTION_MS is pruned,
// with all its records, on the next write.
//
// Every read goes to disk (the merge lane reads fresh before each try), waits
// for the appends queued before it, and reads the primary file: never a
// fallback to an older generation while the primary exists, which may predate
// the newest FAIL. No file is empty; anything else that does not parse into
// valid records throws. Writes are serialized in-process and go through
// atomicWriteJSON. Nothing is created until the first verdict is recorded.

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { getWmuxDir } from '../../daemon/config';
import { PR_VERDICT_RETENTION_MS, isPrVerdictRecord, type PrVerdictRecord } from '../../shared/prVerdict';

export const PR_VERDICTS_FILENAME = 'pr-verdicts.json';

const headKey = (r: Pick<PrVerdictRecord, 'repoKey' | 'prNumber' | 'headSha'>): string => `${r.repoKey}#${r.prNumber}@${r.headSha}`;

export class PrVerdictStore {
  readonly file: string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(wmuxDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(wmuxDir, PR_VERDICTS_FILENAME);
  }

  /** Every record for one PR, read from disk now. Throws when unreadable. */
  async list(repoKey: string, prNumber: number): Promise<PrVerdictRecord[]> {
    await this.writes;
    return (await this.readAll()).filter((r) => r.repoKey === repoKey && r.prNumber === prNumber);
  }

  /** Append one record (and prune stale heads). Throws when the file is
   *  unreadable or the write fails; nothing is overwritten then. */
  record(rec: PrVerdictRecord): Promise<void> {
    if (!isPrVerdictRecord(rec)) return Promise.reject(new Error('invalid verdict record'));
    const run = this.writes.then(async () => {
      const all = await this.readAll();
      all.push(asV2(rec));
      const newest = new Map<string, number>();
      const failed = new Set<string>();
      for (const r of all) {
        newest.set(headKey(r), Math.max(newest.get(headKey(r)) ?? 0, r.at));
        if (r.verdict === 'fail') failed.add(headKey(r));
      }
      const cutoff = this.now() - PR_VERDICT_RETENTION_MS;
      const kept = all.filter((r) => failed.has(headKey(r)) || (newest.get(headKey(r)) ?? 0) >= cutoff);
      await atomicWriteJSON(this.file, { version: 2, verdicts: kept });
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async readAll(): Promise<PrVerdictRecord[]> {
    // atomicWriteJSON moves the primary to `.bak` before the new file lands:
    // with no primary, `.bak` is the last committed generation (a write under
    // way, or one a crash cut short), never something older than it.
    const raw = await readIfExists(this.file) ?? await readIfExists(`${this.file}.bak`);
    if (raw === null) return [];
    const saved = JSON.parse(raw) as { version?: unknown; verdicts?: unknown };
    if (!saved || (saved.version !== 1 && saved.version !== 2) || !Array.isArray(saved.verdicts)) throw new Error('invalid verdict storage');
    if (!saved.verdicts.every(isPrVerdictRecord)) throw new Error('invalid verdict entry');
    return (saved.verdicts as PrVerdictRecord[]).map(asV2);
  }
}

/** A v1 record read as v2: same fields, no bot, no evidence. */
function asV2(r: PrVerdictRecord): PrVerdictRecord {
  return r.version === 2 ? r : { ...r, version: 2 };
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

let shared: PrVerdictStore | null = null;

/** The app's one store (the pipe handler and the merge lane share it, so one
 *  writer serializes every append). */
export function getPrVerdictStore(wmuxDir: string = getWmuxDir()): PrVerdictStore {
  if (!shared || shared.file !== path.join(wmuxDir, PR_VERDICTS_FILENAME)) shared = new PrVerdictStore(wmuxDir);
  return shared;
}
