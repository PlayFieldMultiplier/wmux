// ─── The morning schedule — the factory's one timer ────────────────────────
//
// Once per local day, on the weekdays and from the hour in the factory
// settings (`morning`), the morning report fires (morningReport.ts
// fireMorningReport): the HQ workspace's `schedule.fired` fact, which wakes
// Moa. Checked every minute while the factory is on. The local day it last
// fired is kept in `factory/morning-schedule.json`, so a restart later the
// same day does not fire it again; a day the app was closed through the
// hour fires when the app is next open that day. A fire that finds no HQ bot
// or no fact log is retried on the next check.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { FactorySettings } from '../../shared/factorySettings';
import type { MorningFireResult } from './morningReport';

export const MORNING_SCHEDULE_ID = 'morning';
export const MORNING_SCHEDULE_FILENAME = 'morning-schedule.json';
const CHECK_MS = 60_000;

/** The local day of `t` as YYYY-MM-DD. */
export function localDay(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local day to fire for now, or null when nothing is due. Pure. */
export function morningDue(settings: Pick<FactorySettings, 'enabled' | 'morning'>, now: number, lastDay: string | null): string | null {
  if (!settings.enabled) return null;
  const d = new Date(now);
  if (!settings.morning.weekdays.includes(d.getDay()) || d.getHours() < settings.morning.hour) return null;
  const day = localDay(now);
  return day === lastDay ? null : day;
}

export interface MorningScheduleOptions {
  /** `<wmuxDir>/factory/morning-schedule.json` */
  file: string;
  settings: () => FactorySettings;
  fire: (scheduleId: string) => Promise<MorningFireResult>;
  /** Whether the log holds this local day's report: a `duplicate` answer
   *  counts as fired only when it does (a write that failed reads the same). */
  reportedOn?: (day: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export class MorningSchedule {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly opts: MorningScheduleOptions) {
    this.now = opts.now ?? Date.now;
  }

  private lastDay(): string | null {
    try {
      if (!fs.existsSync(this.opts.file)) return null;
      const raw = atomicReadJSONSync<{ version?: unknown; lastDay?: unknown }>(this.opts.file);
      return raw?.version === 1 && typeof raw.lastDay === 'string' ? raw.lastDay : null;
    } catch {
      return null;
    }
  }

  /** One check; resolves with what happened (tests). */
  async tick(): Promise<'idle' | 'fired' | 'retry'> {
    if (this.busy) return 'idle';
    const day = morningDue(this.opts.settings(), this.now(), this.lastDay());
    if (!day) return 'idle';
    this.busy = true;
    try {
      const r = await this.opts.fire(MORNING_SCHEDULE_ID);
      if (!r.ok && (r.code !== 'duplicate' || this.opts.reportedOn?.(day) === false)) return 'retry';
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
      atomicWriteJSONSync(this.opts.file, { version: 1, lastDay: day });
      return 'fired';
    } catch (err) {
      (this.opts.log ?? console.warn)(`[factory] morning report failed: ${String(err)}`);
      return 'retry';
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHECK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
