// The process-handle half of the Windows liveness check, shared by the
// launcher (checkProcessLiveness) and the daemon's lock (processLiveness), so
// both ask the same question first (#2774): a terminated process can stay
// listed by tasklist while its last handles close, and only its handle tells
// "exiting" from "running". `unknown` leaves the answer to tasklist.

import { readProcessExitState } from '../main/pty/winSnapshotNative';
import { livenessFromExitState, type ProcessLiveness } from './processLiveness';

/** Windows: what `pid`'s process handle says; `unknown` elsewhere. */
export function handleLiveness(pid: number): ProcessLiveness {
  return process.platform === 'win32' ? livenessFromExitState(readProcessExitState(pid)) : 'unknown';
}
