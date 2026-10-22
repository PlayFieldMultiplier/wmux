/**
 * Settings › General "Keep the computer awake": whether wmux holds off system
 * sleep, and when. Main owns the blocker (main/power/sleepPrevention.ts); the
 * renderer owns the choice and the "agents are working" verdict, read from the
 * same status model as Fleet's Running section.
 */
export type SleepPreventionMode = 'off' | 'working' | 'always';

export const SLEEP_PREVENTION_MODES: readonly SleepPreventionMode[] = ['off', 'working', 'always'];

export const DEFAULT_SLEEP_PREVENTION_MODE: SleepPreventionMode = 'working';

export function isSleepPreventionMode(value: unknown): value is SleepPreventionMode {
  return typeof value === 'string' && (SLEEP_PREVENTION_MODES as readonly string[]).includes(value);
}

/** The stretch the system was asleep for, main → renderer after a resume. */
export interface SleepWindow {
  suspendedAt: number;
  resumedAt: number;
}
