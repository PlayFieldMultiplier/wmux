import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { renameWithRetry } from '../settingsFile';

/**
 * Writes and removals of the small daemon bookkeeping files (daemon.pid,
 * daemon.lock, daemon-booting, daemon-pipe) that several processes race on:
 * the daemon, the launcher that spawned it, and other starters.
 */

/** Unlink `file` only while it still holds `content`. Returns whether it was
 *  removed. Never throws. A file another process has taken over is kept. */
export function unlinkIfContent(file: string, content: string): boolean {
  try {
    if (fs.readFileSync(file, 'utf-8').trim() !== content) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function tempNameFor(file: string): string {
  return `${file}.${process.pid}.${randomUUID()}.tmp`;
}

type Warn = (msg: string) => void;

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? String(err);
}

/** `warn` that cannot throw into the never-throwing callers below. */
function safeWarn(warn: Warn, msg: string): void {
  try { warn(msg); } catch { /* a broken sink must not change the outcome */ }
}

/**
 * Create `file` holding `content` only if it does not exist. The content is
 * written to a temp file first and hard-linked into place, so no reader ever
 * sees the file empty. Where the temp file or the hard link fails for any
 * reason but EEXIST, it falls back to an O_EXCL write (still exclusive, but a
 * reader can then see the file empty for a moment) and reports both outcomes
 * through `warn` in one line. Returns false when the file already exists or
 * nothing could be written. Never throws.
 */
export function createFileExclusive(file: string, content: string, warn: Warn): boolean {
  let failure = '';
  const tmp = tempNameFor(file);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.linkSync(tmp, file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      failure = `hard link failed (${errorCode(err)})`;
    }
  } catch (err) {
    failure = `temp file failed (${errorCode(err)})`;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
  }
  try {
    fs.writeFileSync(file, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    safeWarn(warn, `[daemon-files] ${file}: ${failure}; created it with a plain exclusive write, which a reader can see empty`);
    return true;
  } catch (err) {
    safeWarn(warn, `[daemon-files] ${file}: ${failure}; the plain exclusive write failed too (${errorCode(err)})`);
    return false;
  }
}

/**
 * Replace `file` with `content` by renaming a temp file over it, so a reader
 * sees the old or the new content, never an empty file. A rename refused
 * because someone holds the file (an antivirus scan, a reader's handle on
 * Windows) is retried briefly (renameWithRetry). If it still fails, the file
 * is written in place, which a reader can see empty. If the temp file cannot
 * be written (disk full, I/O error), `file` is left untouched: an in-place
 * write would likely fail the same way after truncating it. Every fallback
 * or failure is reported through `warn`. Returns whether `file` now holds
 * `content`. Never throws.
 */
export function replaceFileOrWrite(file: string, content: string, warn: Warn): boolean {
  const tmp = tempNameFor(file);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    safeWarn(warn, `[daemon-files] ${file}: temp file failed (${errorCode(err)}); left it untouched`);
    return false;
  }
  let renameErr: unknown;
  try {
    renameWithRetry(tmp, file);
    return true;
  } catch (err) {
    renameErr = err;
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
  try {
    fs.writeFileSync(file, content, { encoding: 'utf-8', mode: 0o600 });
    safeWarn(warn, `[daemon-files] ${file}: atomic replace failed (${errorCode(renameErr)}); wrote it in place, which a reader can see empty`);
    return true;
  } catch (err) {
    safeWarn(warn, `[daemon-files] ${file}: atomic replace failed (${errorCode(renameErr)}); the in-place write failed too (${errorCode(err)})`);
    return false;
  }
}

/**
 * The daemon's teardown: remove daemon.pid, daemon.lock and daemon-booting
 * only while they name `pid`, and daemon-pipe only while it holds the pipe name
 * this daemon wrote (`writtenPipeName`, null when it never wrote one). A
 * daemon that yields (EDAEMON_ALREADY_RUNNING) exits before writing
 * daemon-pipe, while the live daemon owns the pipe and that file; deleting it
 * hid the live daemon's pipe hint. Content is not full ownership: two daemons
 * on the canonical pipe write the same name, so this cannot tell them apart.
 */
export function releaseDaemonFiles(wmuxDir: string, pid: number, writtenPipeName: string | null): void {
  const own = String(pid);
  for (const name of ['daemon.pid', 'daemon.lock', 'daemon-booting']) {
    unlinkIfContent(path.join(wmuxDir, name), own);
  }
  if (writtenPipeName !== null) unlinkIfContent(path.join(wmuxDir, 'daemon-pipe'), writtenPipeName);
}
