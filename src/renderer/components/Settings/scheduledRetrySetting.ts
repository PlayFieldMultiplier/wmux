// The scheduled-run retry setting as the Settings row sees it. The daemon
// owns the value; the row only shows what the daemon last said, or nothing
// (null) while that is not known.

import type { AutomationSettings, AutomationSettingsResult } from '../../../shared/automation';

export interface ScheduledRetryApi {
  /** Null when the daemon is not reachable or has no such setting. */
  read: () => Promise<AutomationSettings | null>;
  write: (value: boolean) => Promise<AutomationSettingsResult>;
}

export interface ScheduledRetrySync {
  /** Ask the daemon again (at mount, and whenever it (re)connects). */
  read: () => void;
  change: (next: boolean) => void;
  dispose: () => void;
}

/**
 * Only the newest request's answer is shown, so a late reply cannot flip the
 * switch back. A change shows its value at once; a write that fails or
 * throws (it may have been saved before a timeout) leaves the value unknown
 * and reads it again rather than guessing the old one.
 */
export function scheduledRetrySync(api: ScheduledRetryApi, show: (value: boolean | null) => void): ScheduledRetrySync {
  let seq = 0;
  let alive = true;
  const current = (id: number): boolean => alive && id === seq;
  const read = (): void => {
    const id = ++seq;
    let pending: Promise<AutomationSettings | null>;
    try {
      pending = api.read();
    } catch {
      pending = Promise.resolve(null);
    }
    pending.then(
      (settings) => { if (current(id)) show(settings ? settings.retryTransientErrors : null); },
      () => { if (current(id)) show(null); },
    );
  };
  const unclear = (id: number): void => {
    if (!current(id)) return;
    show(null);
    read();
  };
  const change = (next: boolean): void => {
    const id = ++seq;
    show(next);
    let pending: Promise<AutomationSettingsResult>;
    try {
      pending = api.write(next);
    } catch {
      unclear(id);
      return;
    }
    pending.then(
      (result) => {
        if (!result.ok) unclear(id);
        else if (current(id)) show(result.settings.retryTransientErrors);
      },
      () => unclear(id),
    );
  };
  return { read, change, dispose: () => { alive = false; } };
}
