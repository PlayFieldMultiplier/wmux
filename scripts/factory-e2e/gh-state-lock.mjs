// The fake gh's state file lock, shared by fake-gh.mjs and the smoke runner
// (scripts/factory-smoke.mjs): every read-modify-write of the state holds it,
// so neither loses the other's change.
//
// The lock file names its holder's pid: it is taken over only when that
// process is gone, and a holder removes only its own lock.

import fs from 'node:fs';

/** Take the lock on `statePath`, waiting up to `timeoutMs`. Returns the
 *  release (idempotent), or null when the lock was not freed in time. */
export function lockGhState(statePath, timeoutMs = 30_000) {
  const lock = `${statePath}.lock`;
  const mine = String(process.pid);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (const until = Date.now() + timeoutMs; Date.now() < until;) {
    try {
      fs.writeFileSync(lock, mine, { flag: 'wx' });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (fs.readFileSync(lock, 'utf8') === mine) fs.unlinkSync(lock);
        } catch { /* already gone */ }
      };
    } catch {
      try {
        const holder = Number(fs.readFileSync(lock, 'utf8'));
        let alive = true;
        if (Number.isSafeInteger(holder) && holder > 0) {
          try { process.kill(holder, 0); } catch (err) { alive = err?.code === 'EPERM'; }
        }
        if (!alive) fs.unlinkSync(lock);
      } catch { /* released meanwhile */ }
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  return null;
}

/** Replace the state file whole (a reader never sees half of it). */
export function writeGhStateFile(statePath, state) {
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, statePath);
}
