import { wslPathToHost } from '../mcp/wslPaths';
import type { WslTarget } from '../shared/wslTarget';
import type { GitDirMapper } from '../main/pty/gitContextWatch';

/**
 * #2407 — a session's cwd as the daemon's git watcher must read it.
 *
 * A WSL shell reports a Linux cwd (`/home/me/repo`, `/mnt/d/repo`), and the
 * watcher runs in this Windows process: handed that path as-is, `/home/me/repo`
 * resolves against the current drive, never exists, and the branch stays
 * unknown. So, for a WSL session only:
 *  - under the drive mount: `/mnt/d/repo` → `D:\repo`;
 *  - anywhere else: `\\wsl$\<distro>\home\me\repo`. The distro is the one the
 *    session runs in, recorded at spawn (`wslTarget`, the probe's
 *    $WSL_DISTRO_NAME), so a default-distro pane has its name too.
 * Only the watcher's input changes; the session keeps its Linux cwd for
 * display and recovery. A cwd wslPathToHost refuses (`~`, relative, a name
 * Windows reads as another file) is passed through unchanged, which is the
 * old behaviour: unknown, never a wrong branch.
 */
export function gitWatchPath(cwd: string, wslTarget: WslTarget | undefined): string {
  if (!wslTarget) return cwd;
  const mapped = wslPathToHost(cwd, wslTarget.distribution);
  return 'path' in mapped ? mapped.path : cwd;
}

/** The (sessionId, cwd, mapGitDir) arguments for GitContextWatcher.update. */
export function gitWatchArgs(
  sessionId: string,
  session: { cwd: string; wslTarget?: WslTarget },
): [string, string, GitDirMapper?] {
  const target = session.wslTarget;
  if (!target) return [sessionId, session.cwd];
  // A worktree made by git inside the distro names its gitdir as a Linux path.
  return [sessionId, gitWatchPath(session.cwd, target), (gitdir) => gitWatchPath(gitdir, target)];
}
