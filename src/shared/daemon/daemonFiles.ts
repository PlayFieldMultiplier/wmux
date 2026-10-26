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

/**
 * Create `file` holding `content` only if it does not exist. The content is
 * written to a temp file first and hard-linked into place, so no reader ever
 * sees the file empty. Where hard links are unavailable it falls back to an
 * O_EXCL write. Returns false when the file already exists or nothing could be
 * written. Never throws.
 */
export function createFileExclusive(file: string, content: string): boolean {
  const tmp = tempNameFor(file);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.linkSync(tmp, file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    }
  } catch { /* temp file not writable: try the direct write below */ } finally {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
  }
  try {
    fs.writeFileSync(file, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/** Replace `file` with `content` by renaming a temp file over it, so a reader
 *  sees the old or the new content, never an empty file. Never throws. */
export function replaceFileAtomic(file: string, content: string): boolean {
  const tmp = tempNameFor(file);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* renamed or never created */ }
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
