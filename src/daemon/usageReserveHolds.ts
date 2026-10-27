// The usage reserve's holds as the daemon keeps them: account key → when its
// 5h window resets (ms), pushed whole by main (main/usage/usageReserve.ts).
// Kept on disk too, so a daemon that restarts before main reconnects does not
// start a held schedule within its grace window; an entry past its reset
// holds nothing.

import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSON } from './util/atomicWrite';

export const USAGE_RESERVE_HOLDS_FILE = 'usage-reserve-holds.json';
const MAX_HOLDS = 256;
const MAX_ACCOUNT_LEN = 128;

/** The pushed holds, or null when malformed. */
export function parseUsageReserveHolds(raw: unknown): Map<string, number> | null {
  if (!Array.isArray(raw) || raw.length > MAX_HOLDS) return null;
  const holds = new Map<string, number>();
  for (const h of raw) {
    if (!h || typeof h !== 'object') return null;
    const { account, untilMs } = h as Record<string, unknown>;
    if (typeof account !== 'string' || !account || account.length > MAX_ACCOUNT_LEN) return null;
    if (typeof untilMs !== 'number' || !Number.isFinite(untilMs)) return null;
    holds.set(account, untilMs);
  }
  return holds;
}

export function loadUsageReserveHolds(wmuxDir: string): Map<string, number> {
  try {
    const file = atomicReadJSONSync<{ holds?: unknown }>(path.join(wmuxDir, USAGE_RESERVE_HOLDS_FILE));
    return parseUsageReserveHolds(file?.holds) ?? new Map();
  } catch {
    return new Map();
  }
}

export function saveUsageReserveHolds(wmuxDir: string, holds: ReadonlyMap<string, number>): Promise<void> {
  const list = [...holds].map(([account, untilMs]) => ({ account, untilMs }));
  return atomicWriteJSON(path.join(wmuxDir, USAGE_RESERVE_HOLDS_FILE), { holds: list });
}

/** The hold on one account at `nowMs`: its reset, or null. */
export function usageReserveHoldAt(holds: ReadonlyMap<string, number>, account: string, nowMs: number): number | null {
  const until = holds.get(account);
  return until !== undefined && until > nowMs ? until : null;
}
