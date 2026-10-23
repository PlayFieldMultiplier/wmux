// Whether the pane's foreground process is blocked reading the terminal: the
// kernel's wait channel for it. Linux only (measured on kernel 7.0: a foreground
// `cat` waits in `wait_woken`, a `sleep` in `hrtimer_nanosleep`). macOS reports no wait channel to
// `ps -o wchan` (`-` for a process blocked in a tty read, measured 2026-10-23),
// and Windows has none, so they answer `unknown` and the gate is not used there.

import fs from 'node:fs';

/**
 * - `reads`: blocked in a tty read;
 * - `other`: blocked on something that is not input (a child, a timer, a lock);
 * - `unknown`: not readable here, or a wait (poll, select) that may or may not be the terminal.
 */
export type TtyWait = 'reads' | 'other' | 'unknown';

const READS = new Set(['n_tty_read', 'wait_woken', 'tty_read']);
// A poll or select may be waiting on the terminal among other things.
const MAYBE = new Set(['do_select', 'core_sys_select', 'do_sys_poll', 'poll_schedule_timeout', 'ep_poll', 'do_epoll_wait']);

/** The tty's foreground process group from `/proc/<pid>/stat` (field 8), or null. */
export function foregroundGroupFromStat(stat: string): number | null {
  // `comm` may hold spaces and parentheses: the fields start after the last ')'.
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // state ppid pgrp session tty_nr tpgid
  const tpgid = Number(fields[5]);
  return Number.isSafeInteger(tpgid) && tpgid > 0 ? tpgid : null;
}

/** What a `/proc/<pid>/wchan` value says. */
export function classifyWaitChannel(raw: string | null): TtyWait {
  const name = (raw ?? '').trim();
  if (!name || name === '0') return 'unknown';
  if (READS.has(name)) return 'reads';
  if (MAYBE.has(name)) return 'unknown';
  return 'other';
}

/** Reads a /proc file, or null when it cannot be read. */
export type ProcRead = (file: string) => string | null;

const readProc: ProcRead = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * The wait of the foreground process group leader of `shellPid`'s terminal.
 * `unknown` off Linux and whenever anything cannot be read: only a known
 * non-input wait ever vetoes.
 */
export function foregroundTtyWait(shellPid: number, platform: NodeJS.Platform = process.platform, read: ProcRead = readProc): TtyWait {
  if (platform !== 'linux' || !Number.isSafeInteger(shellPid) || shellPid <= 0) return 'unknown';
  const stat = read(`/proc/${shellPid}/stat`);
  const group = stat ? foregroundGroupFromStat(stat) : null;
  // The shell itself in the foreground is no command waiting.
  if (group === null || group === shellPid) return 'unknown';
  return classifyWaitChannel(read(`/proc/${group}/wchan`));
}
