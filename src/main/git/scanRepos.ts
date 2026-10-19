// The repositories inside a folder that is not one itself (#2438): a
// workspace root holding a dozen repos in subfolders (frontend, services,
// infra) resolves to no repo, so the Git page found nothing. This lists the
// repos below it, VS Code multi-root style.
//
// Bounded on purpose — it runs on a Git page read, not as an indexer:
//   - at most SCAN_DEPTH levels below the root, and never into a repo found
//     (its own subfolders belong to it: submodules, vendored checkouts);
//   - hidden folders and well-known heavy ones (node_modules, build output)
//     are skipped;
//   - symlinks and junctions are not followed (Dirent.isDirectory() is false
//     for them), so the walk cannot leave the root;
//   - every folder below the root passes the caller's access check before
//     it is read or handed to git; a refused one is skipped;
//   - each folder is read once, and at most SCAN_MAX_DIRS reads are made in
//     all (the root included); at most SCAN_MAX_REPOS repos are kept.
// Each folder with a `.git` entry (a directory, or a file for a linked
// worktree or a submodule) is confirmed with `git rev-parse --show-toplevel`,
// so the answer is the same toplevel diff:resolveRepo would give for it.

import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

export const SCAN_DEPTH = 2;
export const SCAN_MAX_REPOS = 50;
export const SCAN_MAX_DIRS = 400;

const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  '__pycache__', 'venv', 'Pods', 'DerivedData',
]);

/** A folder → its worktree toplevel, or null when git does not see a repo there. */
export type ToplevelOf = (dir: string) => Promise<string | null>;

/** A folder → the path to read it at, or null when it may not be read. */
export type AccessibleDir = (dir: string) => Promise<string | null>;

const isGitEntry = (x: Dirent) => x.name === '.git' && (x.isDirectory() || x.isFile());

/**
 * Repos below `root` (not `root` itself), sorted by path. `root` is expected
 * to be already confined by the caller (resolveAccessiblePath); `accessible`
 * is applied to every folder below it.
 */
export async function scanRepos(
  root: string,
  toplevelOf: ToplevelOf,
  accessible: AccessibleDir = async (dir) => dir,
  depth = SCAN_DEPTH,
): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  let dirsRead = 0;
  const read = async (dir: string): Promise<Dirent[] | null> => {
    dirsRead++;
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return null; // unreadable: skipped, not an error for the whole scan
    }
  };
  const subdirs = (dir: string, entries: Dirent[]) =>
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => join(dir, e.name));

  const rootEntries = await read(root);
  if (!rootEntries) return found;
  // Breadth first, so a shallow repo is never crowded out by a deep tree.
  // Reading a folder once answers both questions: is it a repo (a `.git`
  // entry), and if not, which subfolders go to the next level.
  let level = subdirs(root, rootEntries);
  for (let d = 1; d <= depth && level.length > 0; d++) {
    const next: string[] = [];
    for (const dir of level) {
      if (dirsRead >= SCAN_MAX_DIRS || found.length >= SCAN_MAX_REPOS) break;
      const at = await accessible(dir);
      if (!at) continue;
      const entries = await read(at);
      if (!entries) continue;
      if (!entries.some(isGitEntry)) {
        if (d < depth) next.push(...subdirs(at, entries));
        continue;
      }
      const top = await toplevelOf(at);
      if (top && !seen.has(top)) {
        seen.add(top);
        found.push(top);
      }
      // A repo's subfolders are its own: not descended into either way.
    }
    level = next;
  }
  return found.sort((a, b) => a.localeCompare(b));
}
