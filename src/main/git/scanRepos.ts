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
//   - at most SCAN_MAX_DIRS folders are read and SCAN_MAX_REPOS repos kept.
// Each folder with a `.git` entry (a directory, or a file for a linked
// worktree or a submodule) is confirmed with `git rev-parse --show-toplevel`,
// so the answer is the same toplevel diff:resolveRepo would give for it.

import { readdir } from 'node:fs/promises';
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

/**
 * Repos below `root` (not `root` itself), sorted by path. `root` is expected
 * to be already confined by the caller (resolveAccessiblePath).
 */
export async function scanRepos(root: string, toplevelOf: ToplevelOf, depth = SCAN_DEPTH): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  let dirsRead = 0;
  // Breadth first, so a shallow repo is never crowded out by a deep tree.
  let level: string[] = [root];
  for (let d = 0; d < depth && level.length > 0 && found.length < SCAN_MAX_REPOS; d++) {
    const next: string[] = [];
    for (const dir of level) {
      if (dirsRead >= SCAN_MAX_DIRS || found.length >= SCAN_MAX_REPOS) break;
      dirsRead++;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable: skipped, not an error for the whole scan
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        const child = join(dir, e.name);
        let isRepo = false;
        try {
          const inner = await readdir(child, { withFileTypes: true });
          isRepo = inner.some((x) => x.name === '.git' && (x.isDirectory() || x.isFile()));
        } catch {
          continue;
        }
        if (!isRepo) {
          next.push(child);
          continue;
        }
        const top = await toplevelOf(child);
        if (top && !seen.has(top)) {
          seen.add(top);
          found.push(top);
          if (found.length >= SCAN_MAX_REPOS) break;
        }
        // A repo's subfolders are its own: not descended into either way.
      }
    }
    level = next;
  }
  return found.sort((a, b) => a.localeCompare(b));
}
