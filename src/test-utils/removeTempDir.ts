import fs from 'node:fs';
import path from 'node:path';

// Remove a temp dir a test made, strictly and with a bounded wait.
//
// On Windows a process outside the test's own process tree can hold a file in
// it for seconds after the test is done with it: an antivirus scan, or on the
// GitHub runner provjobd.exe, seen holding a just-run executable 1-14 s. The
// removal waits that out with rm's own retries (EBUSY/EPERM, linear backoff):
// 200 ms × (1 + … + 16) = 27.2 s, about twice the longest hold seen in CI. Past
// that it fails and names each entry that still cannot be removed, which is
// usually a handle the test itself left open (a child, a watcher, a stream).
const RETRIES = 16;
const RETRY_DELAY_MS = 200;

/**
 * Budget for a hook that awaits removeTempDir. A removal that exhausts its
 * retries took about 31 s end to end (the waits plus one walk of the tree per
 * try); 60 s lets it fail with its own message rather than a bare hook timeout.
 */
export const REMOVE_TEMP_DIR_HOOK_TIMEOUT_MS = 60_000;

/** What still cannot be removed under `dir`, each entry tried on its own: `path (CODE)`. */
export function heldEntries(dir: string): string[] {
  const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [`${dir} (${code(e)})`];
  }
  const held: string[] = [];
  for (const name of names) {
    const p = path.join(dir, name);
    let isDir: boolean;
    try {
      isDir = fs.lstatSync(p).isDirectory();
    } catch (e) {
      held.push(`${p} (${code(e)})`);
      continue;
    }
    if (isDir) {
      held.push(...heldEntries(p));
      continue;
    }
    try {
      fs.unlinkSync(p);
    } catch (e) {
      held.push(`${p} (${code(e)})`);
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch (e) {
    if (held.length === 0) held.push(`${dir} (${code(e)})`);
  }
  return held;
}

/** Remove `dir` (absent is fine); reject naming what stays held past the bounded wait. */
export async function removeTempDir(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: RETRIES, retryDelay: RETRY_DELAY_MS });
  } catch (err) {
    throw new Error(
      `could not remove ${dir}: ${(err as Error).message}\nstill held: ${heldEntries(dir).join(', ') || '(nothing; removed on the last look)'}`,
      { cause: err },
    );
  }
}

/** Remove every dir in `dirs` and empty the list; one held dir does not stop the others. */
export async function removeTempDirs(dirs: string[]): Promise<void> {
  const results = await Promise.allSettled(dirs.splice(0).map((dir) => removeTempDir(dir)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length === 1) throw failed[0].reason;
  if (failed.length > 1) throw new AggregateError(failed.map((r) => r.reason), failed.map((r) => (r.reason as Error).message).join('\n'));
}
