import fs from 'node:fs';

/**
 * Disk and PATH checks for remote spawn (the policy's folders, a request's
 * folder and agent), bounded in time and in number.
 *
 * A check that takes longer than `SPAWN_CHECK_TIMEOUT_MS` is given up on with
 * a `CheckTimeout`, but the call underneath (a realpath on a mount that does
 * not answer) keeps running on a worker thread. So it keeps its slot until it
 * really returns, and at most `SPAWN_CHECKS_IN_FLIGHT_MAX` run at once in this
 * process: past that a check is refused with `CheckBusy` at once, and stuck
 * calls cannot take every thread the daemon's own file I/O needs.
 */

/** One disk or PATH check. */
export const SPAWN_CHECK_TIMEOUT_MS = 10_000;
/** Checks running at once in this process (Node has 4 worker threads by default). */
export const SPAWN_CHECKS_IN_FLIGHT_MAX = 2;

export class CheckTimeout extends Error {}
export class CheckBusy extends Error {}

export class SpawnChecks {
  private inFlight = 0;

  constructor(
    private readonly max = SPAWN_CHECKS_IN_FLIGHT_MAX,
    private readonly timeoutMs = SPAWN_CHECK_TIMEOUT_MS,
  ) {}

  /** Checks holding a slot, a timed-out one included until it returns. */
  get running(): number {
    return this.inFlight;
  }

  /** Start `check` when a slot is free; its value, or `CheckTimeout` / `CheckBusy`. */
  run<T>(check: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.max) return Promise.reject(new CheckBusy('too many checks are running'));
    this.inFlight += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
    };
    let p: Promise<T>;
    try {
      p = check();
    } catch (err) {
      release();
      return Promise.reject(err);
    }
    p.then(release, release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CheckTimeout('check timed out')), this.timeoutMs);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}

/** The one gate every spawn check of this process goes through. */
export const spawnChecks = new SpawnChecks();

/**
 * The OS realpath (`fs.realpath.native`). Every spawn path that is compared
 * goes through this one: on Windows it expands 8.3 short names
 * (`C:\Users\RUNNER~1`) and returns the on-disk case, which the JS realpath
 * does not, so a root saved under one spelling still matches a folder
 * resolved under another (#984).
 */
export function realpathNative(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.realpath.native(p, (err, resolved) => (err ? reject(err) : resolve(resolved)));
  });
}

/** The errors that mean "no such folder here" (anything else may pass on a retry). */
export function notThere(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM' || code === 'ELOOP';
}
