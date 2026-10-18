import { isWslShellPath } from '../shared/wslDistro';
import { wslPathToHost } from '../mcp/wslPaths';

/**
 * A session's cwd as the daemon's git watcher must open it (#2407).
 *
 * A WSL pane reports its directory as a Linux path (`/mnt/d/repo`,
 * `/home/me/repo`). The watcher runs in the Windows daemon process and reads
 * `.git` with Windows `fs`, where such a path resolves against the current
 * drive and names nothing, so the pane never showed a branch.
 *
 * A path under the drive mount is the Windows folder it names (`/mnt/d/repo`
 * → `D:\repo`): a local path, so the walk and the HEAD watch work as for any
 * Windows shell. A path inside the distro (`/home/me/repo`) is passed as
 * given, which keeps the old "unknown", never a wrong repository: reaching it
 * would mean synchronous reads over the `\\wsl$` share on the daemon's event
 * loop and a HEAD watch that share may not serve, neither of which is proven
 * on Windows yet.
 *
 * Only a WSL session on win32 is translated; a path that cannot be (a
 * character Windows reads as a separator) is passed as given too.
 */
export function gitWatchCwdFor(
  session: { cwd: string; cmd?: string; wslTarget?: { distribution?: unknown } },
  platform: NodeJS.Platform = process.platform,
): string {
  const { cwd } = session;
  if (platform !== 'win32' || !cwd.startsWith('/') || cwd.startsWith('//')) return cwd;
  if (session.wslTarget === undefined && !isWslShellPath(session.cmd)) return cwd;
  // No distro on purpose: with none, only the drive mount translates.
  const host = wslPathToHost(cwd, undefined);
  return 'path' in host ? host.path : cwd;
}
