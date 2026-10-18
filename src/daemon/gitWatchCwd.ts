import { isWslShellPath } from '../shared/wslDistro';
import { wslPathToHost } from '../mcp/wslPaths';

/**
 * A session's cwd as the daemon's git watcher must open it (#2407).
 *
 * A WSL pane reports its directory as a Linux path (`/home/me/repo`,
 * `/mnt/d/repo`). The watcher runs in the Windows daemon process and reads
 * `.git` with Windows `fs`, where such a path resolves against the current
 * drive and names nothing, so the pane never showed a branch. The watcher is
 * given the Windows name of the same directory instead:
 *  - under the drive mount: `/mnt/d/repo` → `D:\repo`;
 *  - inside the distro: `/home/me/repo` → `\\wsl$\<distro>\home\me\repo`,
 *    which `fs.stat`, `readFile` and `fs.watch` all serve.
 * The session keeps its Linux cwd for everything else (display, recovery).
 *
 * Only a WSL session on win32 is translated; a path that cannot be (the
 * distro unknown, a character Windows reads as a separator) is passed as
 * given, which is the old behaviour: unknown, never a wrong repository.
 */
export function gitWatchCwdFor(
  session: { cwd: string; cmd?: string; wslTarget?: { distribution?: unknown } },
  platform: NodeJS.Platform = process.platform,
): string {
  const { cwd } = session;
  if (platform !== 'win32' || !cwd.startsWith('/') || cwd.startsWith('//')) return cwd;
  const distro = typeof session.wslTarget?.distribution === 'string' ? session.wslTarget.distribution : undefined;
  if (distro === undefined && !isWslShellPath(session.cmd)) return cwd;
  const host = wslPathToHost(cwd, distro);
  return 'path' in host ? host.path : cwd;
}
