// ─── A phone's agent launch into a bot's fan-out worker pane ───────────────
//
// The daemon types a launch line into an existing pane when a phone starts or
// resumes the pane's agent (nativeChatBridge `launch`). A pane that is a
// bot's fan-out worker merges only through the agent factory's merge lane, so
// a claude line typed there carries the same `--settings` file main's own
// launches carry (shared/botWorkerGuard.ts), or nothing is typed. Which panes
// are a bot's workers comes from main's record, read fresh on every launch:
// main writes it while the daemon runs. A record that exists but cannot be
// read guards every pane. A codex line is refused there (main launches a bot's
// codex worker only as the fan-out's own first launch). A line that starts no
// claude or codex passes unchanged, as main's own resume guard passes it.
//
// A session main recorded with its launch files (the worker's MCP config and
// rules, shared/botWorkerMcp.ts) gets those, with `--strict-mcp-config`, when
// they hold no connection and the folders it may start in have no project
// settings a worker does not start with (shared/botWorkerGuard.ts). A
// WSL session gets the worker settings file alone, as before. Any other
// session (recorded without its files, or a record that cannot be read) gets
// nothing typed.
//
// The worker fence (main/agents/botWorkerFence.ts): the daemon cannot build
// it (the self-tested claude, the folder and git checks), so a claude line
// that would run unattended types nothing: one whose flags, or (with no
// flag) whose settings, name bypassPermissions or auto, or any launch of a
// session main started inside the fence. Such a worker starts again only
// from wmux on the computer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getWmuxDir } from '../config';
import { isFencedMode, linePermissionMode, namesClaude, readBotWorkerSessions, settingsDefaultMode, workerProjectSettingsRefusal } from '../../shared/botWorkerGuard';
import { spliceWorkerLaunch } from '../../shared/botWorkerMcp';
import { namesCodex } from '../../shared/codexWorkerGuard';
import { toWslPath } from '../../shared/imagePaste';

/** The first message as terminalLaunchCommand appends it: ` -- '<text>'`,
 *  each `'` written `'\''`. */
const QUOTED_FIRST_MESSAGE = /^ -- '(?:[^']|'\\'')*'$/;

/**
 * The line to type into pane `sessionId`: `line` itself for a pane that is
 * not a bot's worker; for one that is, the line with the worker settings
 * right after the launcher, or null (type nothing). `head` is `line` up to
 * the first message: the launcher and its flags, which the guard reads; the
 * rest must be exactly the quoted first message, and is kept as it is.
 */
export function guardBotWorkerLaunch(
  sessionId: string,
  line: string,
  head: string,
  dir: string = getWmuxDir(),
  /** The folders the line may start claude in (the pane's, a resume's). */
  folders: readonly string[] = [],
): string | null {
  const read = readBotWorkerSessions(dir);
  if ('sessions' in read && !read.sessions.has(sessionId)) return line;
  // A codex worker starts only as main's fan-out launch (codexWorkerGuard).
  if (namesCodex(line)) return null;
  if (!namesClaude(line)) return line;
  if (!line.startsWith(head)) return null;
  const tail = line.slice(head.length);
  if (tail && !QUOTED_FIRST_MESSAGE.test(tail)) return null;
  const rec = 'sessions' in read ? read.sessions.get(sessionId) : undefined;
  if (runsUnattended(head, rec, dir)) {
    console.warn(`[botWorkerLaunchGuard] ${sessionId}: a bot worker that runs unattended starts again only from wmux on the computer (worker fence)`);
    return null;
  }
  if (rec?.launch && !rec.wsl) {
    if (!rec.cwd || [rec.cwd, ...folders].some((f) => workerProjectSettingsRefusal(f) !== null)) return null;
    if (!fs.existsSync(rec.launch.settingsFile) || !fs.existsSync(rec.launch.mcpConfigFile)) return null;
    // The daemon cannot tell whether a recorded connection is still the
    // bot's: a launch with connections starts only from main.
    if (carriesConnections(rec.launch.mcpConfigFile)) return null;
    const strict = spliceWorkerLaunch(head, rec.launch.settingsFile, rec.launch.mcpConfigFile, rec.launch.settingSources);
    return strict === null ? null : strict + tail;
  }
  // A WSL pane's record names the files main wrote for it (this build's wmux
  // server, run in the Windows runtime): Linux claude opens them through its
  // /mnt mount. A record without them (an older main's, or one that cannot
  // be read) types nothing: the daemon cannot write the worker's MCP config,
  // and the distro's own claude config may name another wmux server.
  if (!rec?.wsl || !rec.launch) return null;
  if (!fs.existsSync(rec.launch.settingsFile) || !fs.existsSync(rec.launch.mcpConfigFile)) return null;
  if (carriesConnections(rec.launch.mcpConfigFile)) return null;
  const inWsl = (p: string): string => toWslPath(p) ?? p;
  const guarded = spliceWorkerLaunch(head, inWsl(rec.launch.settingsFile), inWsl(rec.launch.mcpConfigFile));
  return guarded === null ? null : guarded + tail;
}

/** Would this launch run unattended, or was the session started inside the
 *  fence? The mode comes from the line's flags, else from the folder's and
 *  every user settings folder the pane may use (the default one, the
 *  daemon's CLAUDE_CONFIG_DIR, each account's under `<dir>/accounts`). */
function runsUnattended(head: string, rec: { cwd?: string; launch?: { fence?: { strength: string } } } | undefined, dir: string): boolean {
  if (rec?.launch?.fence && rec.launch.fence.strength !== 'off') return true;
  const home = os.homedir();
  const accounts = (() => {
    try {
      return fs.readdirSync(path.join(dir, 'accounts')).map((n) => path.join(dir, 'accounts', n));
    } catch {
      return [];
    }
  })();
  const env = process.env.CLAUDE_CONFIG_DIR;
  const configDirs = [path.join(home, '.claude'), ...(env && path.isAbsolute(env) ? [env] : []), ...accounts];
  return isFencedMode(linePermissionMode(head) ?? settingsDefaultMode(rec?.cwd, configDirs));
}

/** Does a recorded MCP config name any server but wmux (or not parse)? */
function carriesConnections(file: string): boolean {
  try {
    const servers = (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
    return Object.keys(servers).some((k) => k !== 'wmux');
  } catch {
    return true;
  }
}
