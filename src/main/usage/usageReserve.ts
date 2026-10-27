// Usage reserve: when the owner turns it on, unattended work keeps the last
// RESERVE_PCT of a Claude account's 5-hour window for the person. Scheduled
// runs, fan-out workers and bot workers do not START while the account's 5h
// usage is at or above the threshold; they wait for the window to reset.
// Nothing a person types is gated.
//
// Main decides, because the usage readings live here (the statusline push and
// the usage services, the same feed as the usage trail). The daemon only gets
// the resulting holds (account key → until when) for the scheduled runs it
// launches. Usage that is not known never holds anything.

import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import type { UsageSnapshot } from '../claude/UsageApi';
import { formatResetDuration } from '../../shared/usageLimit';

/** Share of the 5h window kept for the person. Fixed in v1. */
export const RESERVE_PCT = 15;
/** 5h usage at or above this holds unattended starts. */
export const RESERVE_THRESHOLD_PCT = 100 - RESERVE_PCT;

export const USAGE_RESERVE_FILENAME = 'usage-reserve.json';

/** One account's hold: its usage key ('default' or an account id) and when its 5h window resets (ms). */
export interface UsageReserveHold {
  account: string;
  untilMs: number;
}

/** When unattended starts on this reading may resume (the 5h reset, ms), or
 *  null when the reading does not hold them: no reading, an unknown or passed
 *  reset, or usage under the threshold. */
export function reserveUntilMs(snapshot: UsageSnapshot | null, nowMs: number): number | null {
  if (!snapshot || snapshot.sessionResetEpochSec <= 0) return null;
  const resetMs = snapshot.sessionResetEpochSec * 1000;
  if (resetMs <= nowMs) return null;
  return snapshot.sessionPct >= RESERVE_THRESHOLD_PCT ? resetMs : null;
}

export interface UsageReserveDeps {
  wmuxDir: string;
  /** Every usage reading main holds, keyed 'default' or by account id. */
  snapshots: () => Array<[string, UsageSnapshot | null]>;
  /** The usage key a workspace's Claude launches run on. */
  accountOfWorkspace: (workspaceId: string) => string;
  /** Hand the current holds to the daemon (its scheduled runs). */
  push?: (holds: UsageReserveHold[]) => void;
  /** Tell the owner once per hold. */
  notify?: (account: string, untilMs: number) => void;
  /** The setting changed (on or off). */
  onSettingChange?: (on: boolean) => void;
  now?: () => number;
  log?: (line: string) => void;
}

export class UsageReserve {
  private readonly filePath: string;
  private readonly now: () => number;
  private on: boolean | null = null;
  /** The holds last pushed, as JSON: none until a connect pushes them. */
  private lastPushed = '[]';
  /** `account:untilMs` of holds the owner was told about. */
  private readonly told = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: UsageReserveDeps) {
    this.filePath = path.join(deps.wmuxDir, USAGE_RESERVE_FILENAME);
    this.now = deps.now ?? Date.now;
  }

  enabled(): boolean {
    if (this.on === null) {
      try {
        this.on = atomicReadJSONSync<{ enabled?: unknown }>(this.filePath)?.enabled === true;
      } catch {
        this.on = false;
      }
    }
    return this.on;
  }

  setEnabled(on: boolean): Promise<void> {
    const write = this.writes.then(async () => {
      await atomicWriteJSON(this.filePath, { enabled: on });
      this.on = on;
      this.deps.onSettingChange?.(on);
      this.refresh();
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  /** The hold on one usage key, or null. */
  holdFor(account: string): UsageReserveHold | null {
    if (!this.enabled()) return null;
    const entry = this.deps.snapshots().find(([key]) => key === account);
    const untilMs = reserveUntilMs(entry?.[1] ?? null, this.now());
    return untilMs === null ? null : { account, untilMs };
  }

  /** The hold on the account a workspace's launches run on, or null. */
  holdForWorkspace(workspaceId: string): UsageReserveHold | null {
    return this.holdFor(this.deps.accountOfWorkspace(workspaceId));
  }

  holds(): UsageReserveHold[] {
    if (!this.enabled()) return [];
    const now = this.now();
    const out: UsageReserveHold[] = [];
    for (const [account, snapshot] of this.deps.snapshots()) {
      const untilMs = reserveUntilMs(snapshot, now);
      if (untilMs !== null) out.push({ account, untilMs });
    }
    return out.sort((a, b) => a.account.localeCompare(b.account));
  }

  /** Re-read the holds after a usage or setting change; push them when they changed. */
  refresh(): void {
    const holds = this.holds();
    const key = JSON.stringify(holds);
    if (key === this.lastPushed) return;
    this.lastPushed = key;
    this.deps.push?.(holds);
  }

  /** Push the holds whatever was pushed before (the daemon (re)connected). */
  pushNow(): void {
    this.lastPushed = '';
    this.refresh();
  }

  /** Something unattended was held: tell the owner, once per hold. */
  noteHeld(account: string, untilMs: number): void {
    const now = this.now();
    for (const key of this.told) {
      if (Number(key.slice(key.lastIndexOf(':') + 1)) <= now) this.told.delete(key);
    }
    const key = `${account}:${untilMs}`;
    if (this.told.has(key)) return;
    this.told.add(key);
    try {
      this.deps.notify?.(account, untilMs);
    } catch (err) {
      this.deps.log?.(`[usageReserve] notice failed: ${String(err)}`);
    }
  }
}

let instance: UsageReserve | null = null;

export function setUsageReserve(next: UsageReserve | null): void {
  instance = next;
}

/** The running reserve's hold for a workspace's launches, or null (no reserve, or not held). */
export function usageReserveHoldForWorkspace(workspaceId: string): UsageReserveHold | null {
  try {
    return instance?.holdForWorkspace(workspaceId) ?? null;
  } catch {
    return null;
  }
}

export function noteUsageReserveHeld(hold: UsageReserveHold): void {
  instance?.noteHeld(hold.account, hold.untilMs);
}

/** Why a fan-out did not start, for the calling agent to relay. `held`: a
 *  bot's request kept for after the reset. */
export function usageReserveRefusalText(untilMs: number, nowMs: number, held: boolean): string {
  const resets = `${new Date(untilMs).toISOString()} (in ${formatResetDuration(untilMs - nowMs)})`;
  const outcome = held
    ? `the request is held and this bot is woken with it after the window resets at ${resets}`
    : `start them after the window resets at ${resets}`;
  return `usage reserve: this account's 5-hour usage is in its last ${RESERVE_PCT}%, which the person keeps for their own work, `
    + `and fan-out workers run unattended, so none were started; ${outcome}. `
    + 'The person can turn the reserve off in Settings > Claude integration > Usage reserve.';
}
