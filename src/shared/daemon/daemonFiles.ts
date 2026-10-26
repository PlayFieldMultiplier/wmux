import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

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

/**
 * Create `file` holding `content` only if it does not exist. The content is
 * written to a temp file first and hard-linked into place, so no reader ever
 * sees the file empty. Where the temp file or the hard link fails for any
 * reason but EEXIST, it reports that through `warn` and falls back to an O_EXCL
 * write: still exclusive, but a reader can then see the file empty for a
 * moment. Returns false when the file already exists or nothing could be
 * written. Never throws.
 */
export function createFileExclusive(file: string, content: string, warn: Warn = console.warn): boolean {
  const fallback = (what: string, err: unknown): void =>
    warn(`[daemon-files] ${what} for ${file} failed (${errorCode(err)}); creating it with a plain exclusive write, which a reader can see empty`);
  const tmp = tempNameFor(file);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.linkSync(tmp, file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      fallback('hard link', err);
    }
  } catch (err) {
    fallback('temp file', err);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
  }
  try {
    fs.writeFileSync(file, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/** Rename a temp file holding `content` over `file`. Returns the error that
 *  stopped it, or null once it is in place. Never throws. */
function renameIntoPlace(file: string, content: string): unknown {
  const tmp = tempNameFor(file);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return null;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* renamed or never created */ }
    return err;
  }
}

/** Replace `file` with `content` by renaming a temp file over it, so a reader
 *  sees the old or the new content, never an empty file. Never throws. */
export function replaceFileAtomic(file: string, content: string): boolean {
  return renameIntoPlace(file, content) === null;
}

/** replaceFileAtomic, else a plain in-place write, reported through `warn`
 *  because a reader can then see the file empty. Throws only when that write
 *  fails too. */
export function replaceFileOrWrite(file: string, content: string, warn: Warn): void {
  const err = renameIntoPlace(file, content);
  if (err === null) return;
  warn(`[daemon-files] atomic replace of ${file} failed (${errorCode(err)}); writing it in place, which a reader can see empty`);
  fs.writeFileSync(file, content, { encoding: 'utf-8', mode: 0o600 });
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
