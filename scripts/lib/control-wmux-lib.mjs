// Pure helpers for scripts/control-wmux.mjs (the verify-wmux driver).
//
// Kept apart from the driver so the rules that keep an agent off the owner's
// real wmux (suffix validation, CDP port ownership, env scrubbing) can be unit
// tested without launching anything. See scripts/__tests__/controlWmux.test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { parseCimDate } from '../perf-process-tree.mjs';

/**
 * Suffixes the driver must never launch or attach to:
 *   ''          the owner's real (production) instance
 *   '-dev'      the default suffix every unpackaged dev build forces on itself
 *   '-portable' the shared suffix of any packaged copy outside /Applications
 * Any of these may already be running a session somebody cares about.
 */
export const RESERVED_SUFFIXES = new Set(['', '-dev', '-portable']);

/**
 * Validate a WMUX_DATA_SUFFIX for a verification instance.
 * Returns null when acceptable, otherwise a human-readable refusal.
 */
export function suffixRefusal(suffix) {
  if (typeof suffix !== 'string') return 'suffix must be a string';
  if (RESERVED_SUFFIXES.has(suffix)) {
    return suffix === ''
      ? 'refusing to drive the main wmux instance (empty WMUX_DATA_SUFFIX)'
      : `refusing reserved suffix "${suffix}" (shared with the owner's own builds)`;
  }
  // The suffix is pasted into file names (~/.wmux<suffix>, sockets, userData),
  // so keep it to a conservative, path-safe alphabet.
  if (!/^-[a-z0-9][a-z0-9-]{0,39}$/.test(suffix)) {
    return `suffix "${suffix}" must look like -verify-abc123 (leading dash, [a-z0-9-], max 40 chars)`;
  }
  return null;
}

/**
 * Parse the CDP lines wmux writes to stdout during boot (src/main/index.ts).
 * `requested` is the port Chromium was asked to bind; `listening` is set only
 * once wmux has proven it owns the endpoint; `unverified` means the probe has
 * not succeeded (yet); `disabled` means CDP is off for this instance.
 */
export function parseCdpLog(text) {
  const out = { requested: null, listening: null, unverified: false, disabled: false };
  const s = String(text ?? '');
  const req = /\[WinMux\] CDP requested on port (\d+)/.exec(s);
  if (req) out.requested = Number(req[1]);
  const lis = /\[WinMux\] CDP listening on port (\d+)/.exec(s);
  if (lis) out.listening = Number(lis[1]);
  if (/\[WinMux\] CDP port \d+ is unverified/.test(s)) out.unverified = true;
  if (/\[WinMux\] CDP disabled/.test(s)) out.disabled = true;
  return out;
}

/**
 * Find the CDP port claimed by `pid` in wmux's claim directory
 * (~/.cache/wmux-cdp/wmux-cdp-<port>.lock, content = owner pid; see
 * src/main/browser-session/cdpPort.ts). Returns null when no claim matches.
 * Ownership by pid is what lets the driver attach to ITS instance and never to
 * another wmux that happens to sit in the same 18800-18899 range.
 */
export function findClaimedPort(dir, pid) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = /^wmux-cdp-(\d+)\.lock$/.exec(name);
    if (!m) continue;
    let holder;
    try {
      holder = Number.parseInt(fs.readFileSync(path.join(dir, name), 'utf8').trim(), 10);
    } catch {
      continue;
    }
    if (holder === pid) return Number(m[1]);
  }
  return null;
}

/** Does the claim file for `port` still name `pid` as its owner? */
export function claimOwnedBy(dir, port, pid) {
  try {
    const holder = Number.parseInt(fs.readFileSync(path.join(dir, `wmux-cdp-${port}.lock`), 'utf8').trim(), 10);
    return holder === pid;
  } catch {
    return false;
  }
}

/**
 * Environment for the launched instance. An agent usually runs INSIDE the
 * owner's wmux, so its env carries that instance's pane identity (WMUX_*) and
 * the parent Claude Code session (CLAUDE*). Inheriting either would make the
 * isolated instance, or agents inside it, talk to / impersonate the real one.
 */
export function scrubEnv(env, suffix) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^WMUX_/.test(k) || /^CLAUDE/.test(k)) continue;
    out[k] = v;
  }
  out.WMUX_DATA_SUFFIX = suffix;
  return out;
}

/**
 * `launch --env-file`: variables a harness sets on purpose (for example
 * WMUX_NO_PATH_REFRESH, or a sandbox HOME), applied AFTER the scrub so a
 * WMUX_* knob survives it. The suffix is only ever the one `--suffix` chose.
 * Returns { env } or { refusal }.
 */
export function launchEnv(baseEnv, suffix, extra = {}) {
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
    return { refusal: '--env-file must hold a JSON object of string values' };
  }
  const env = scrubEnv(baseEnv, suffix);
  for (const [key, value] of Object.entries(extra)) {
    if (key.toUpperCase() === 'WMUX_DATA_SUFFIX') {
      return { refusal: '--env-file may not set WMUX_DATA_SUFFIX; pass --suffix' };
    }
    // MCP registration writes the agents' real configs under Electron's own
    // home, which a sandboxed HOME does not move: an isolated instance must
    // never opt into it.
    if (key.toUpperCase() === 'WMUX_MCP_REGISTER_EXTERNAL') {
      return { refusal: '--env-file may not set WMUX_MCP_REGISTER_EXTERNAL (it writes the real ~/.claude.json and agent configs)' };
    }
    if (typeof value !== 'string') return { refusal: `--env-file value for ${key} must be a string` };
    // One spelling per name: Windows env names are case-insensitive, and a
    // second `Path` next to `PATH` would be picked nondeterministically.
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    }
    env[key] = value;
  }
  return { env };
}

/**
 * Where a packaged build keeps the wmux CLI bundle (forge extraResource
 * `./dist/cli-bundle`): Contents/Resources on macOS, resources/ next to the
 * executable on Windows and Linux.
 */
export function packagedCliBundle(app, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const mac = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(app);
  if (mac) return p.join(mac[1], 'Contents', 'Resources', 'cli-bundle', 'index.js');
  return p.join(p.dirname(app), 'resources', 'cli-bundle', 'index.js');
}

/** Paths a suffixed instance writes under the user's home (src/shared/constants.ts). */
export function suffixedPaths(home, suffix, platform = process.platform) {
  const paths = [
    path.join(home, `.wmux${suffix}`),
    path.join(home, `.wmux${suffix}.sock`),
    path.join(home, `.wmux-mcpb${suffix}.sock`),
    path.join(home, `.wmux-daemon${suffix}.sock`),
    path.join(home, `.wmux${suffix}-auth-token`),
    path.join(home, `.wmux${suffix}-tcp-port`),
  ];
  if (platform === 'darwin') paths.push(path.join(home, 'Library', 'Application Support', `wmux${suffix}`));
  return paths;
}

/** An env value by name, in whatever case this environment spells it. */
function envValue(env, name) {
  const key = Object.keys(env ?? {}).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * Where a suffixed instance's Electron userData lands: appInit in
 * src/main/index.ts does `app.setPath('userData', app.getPath('userData') +
 * suffix)`, and getPath('userData') is `<appData>/<productName "wmux">`, or
 * the `--user-data-dir` switch when the app was given one. appData mirrors
 * src/cli/commands/role.ts defaultSessionPath: %APPDATA% on Windows,
 * ~/Library/Application Support on macOS, $XDG_CONFIG_HOME or ~/.config on
 * Linux. A prediction: `launch` checks it against the line the app logs.
 */
export function electronUserDataDir({ suffix, env = {}, home, platform = process.platform, userDataDirArg = null }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (userDataDirArg) return `${userDataDirArg}${suffix}`;
  if (platform === 'win32') {
    return p.join(envValue(env, 'APPDATA') || p.join(home, 'AppData', 'Roaming'), `wmux${suffix}`);
  }
  const posixHome = envValue(env, 'HOME') || home;
  if (platform === 'darwin') return p.join(posixHome, 'Library', 'Application Support', `wmux${suffix}`);
  return p.join(envValue(env, 'XDG_CONFIG_HOME') || p.join(posixHome, '.config'), `wmux${suffix}`);
}

/**
 * The `--user-data-dir` a launch gives the app: the caller's own (`launch
 * --user-data-dir`, which a harness points into its sandbox), else what the
 * first launch used (`restart`), else, on macOS, a dir inside the run's
 * ~/.wmux<suffix>, which the purge snapshot already covers. Elsewhere none:
 * userData stays where the wmux CLI looks for it (role.ts, doctor.ts), and
 * `stop --purge` removes it from there.
 */
export function launchUserDataDirArg({ explicit = null, previous, home, suffix, platform = process.platform }) {
  if (explicit) return explicit;
  if (previous !== undefined) return previous;
  if (platform !== 'darwin') return null;
  return path.posix.join(home, `.wmux${suffix}`, 'electron-user-data');
}

/**
 * The app's arguments. macOS: `--use-mock-keychain`, so the first safeStorage
 * call cannot open a login-keychain dialog on the owner's desktop (and block
 * the main thread on a locked screen); e2e/lib.mjs passes the same.
 */
export function launchAppArgs({ userDataDirArg = null, platform = process.platform }) {
  const args = [];
  if (platform === 'darwin') args.push('--use-mock-keychain');
  if (userDataDirArg) args.push(`--user-data-dir=${userDataDirArg}`);
  return args;
}

/** The userData path the app itself logged at boot (src/main/index.ts appInit), or null. */
export function parseUserDataLog(text) {
  const m = /\[Main\] WMUX_DATA_SUFFIX="([^"]*)" .{1,8}? userData="([^"]+)"/.exec(String(text ?? ''));
  return m ? { suffix: m[1], userData: m[2] } : null;
}

/** The same path? Case-insensitive and separator-blind on Windows. */
export function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  if (platform !== 'win32') return path.posix.normalize(a) === path.posix.normalize(b);
  const norm = (s) => path.win32.normalize(s).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Does anything (a file, a dir, a link, even a dangling one) sit at `p`? */
export function pathPresent(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first symlink or junction at or under `p`, or null. lstat never
 * follows one, and Node reports a Windows junction as a symbolic link, so a
 * tree that holds either is found without ever entering the link's target.
 */
export function linkInTree(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return p;
  if (!st.isDirectory()) return null;
  let names;
  try {
    names = fs.readdirSync(p);
  } catch {
    // Unreadable: nobody can say what it holds.
    return p;
  }
  for (const name of names) {
    const hit = linkInTree(path.join(p, name));
    if (hit) return hit;
  }
  return null;
}

/**
 * `stop --purge`: delete the suffixed data this run created, nothing else.
 *   - `paths` (suffixedPaths) go only when they are absent from `preExisting`,
 *     the existence snapshot `launch` took before starting the app;
 *   - `userData` is launch's record `{ path, existedBeforeLaunch }`: it goes
 *     only when `existedBeforeLaunch === false`. No record (a state written
 *     before the record existed) or an unknown pre-launch state is skipped and
 *     reported: never delete what nobody saw absent before launch;
 *   - a path whose name does not carry the suffix is never touched;
 *   - a symlink or junction, at the path or anywhere under it, leaves the
 *     whole path in place: it is never followed, so its target cannot be hit.
 * Returns { removed, skipped: [{ path, reason }] }.
 */
export function purgeSuffixedData({ suffix, paths, preExisting = [], userData, legacyUserDataPath = null, platform = process.platform }) {
  const removed = [];
  const skipped = [];
  const pre = new Set(preExisting);
  const candidates = [];
  for (const p of paths) {
    if (!pathPresent(p)) continue;
    if (pre.has(p)) skipped.push({ path: p, reason: 'existed before launch' });
    else candidates.push(p);
  }
  if (!userData) {
    if (legacyUserDataPath && pathPresent(legacyUserDataPath) && !paths.some((p) => samePath(p, legacyUserDataPath, platform))) {
      skipped.push({ path: legacyUserDataPath, reason: 'userData: the run state has no pre-launch record (written by an older control-wmux); left in place' });
    }
  } else if (userData.path && !paths.some((p) => samePath(p, userData.path, platform)) && pathPresent(userData.path)) {
    if (userData.existedBeforeLaunch === false) candidates.push(userData.path);
    else if (userData.existedBeforeLaunch === true) skipped.push({ path: userData.path, reason: 'userData existed before launch' });
    else skipped.push({ path: userData.path, reason: 'userData: pre-launch state unknown (the app logged another path than predicted); left in place' });
  }
  for (const p of candidates) {
    // userData inside an already removed ~/.wmux<suffix> is gone with it.
    if (!pathPresent(p)) continue;
    if (!path.basename(p).includes(suffix)) {
      skipped.push({ path: p, reason: `name does not carry the suffix ${suffix}` });
      continue;
    }
    const link = linkInTree(p);
    if (link) {
      skipped.push({ path: p, reason: `holds a symlink, junction or unreadable dir (${link}); never followed, left in place` });
      continue;
    }
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch (err) {
      // A file still held open: report it, never abort the rest of `stop`.
      skipped.push({ path: p, reason: `could not remove (${err.code || err.message}); part of it may be gone` });
    }
  }
  return { removed, skipped };
}

/**
 * One renderer console line as Chromium logs it with ELECTRON_ENABLE_LOGGING=1:
 *   [pid:mmdd/hhmmss.us:INFO:CONSOLE:26] "message", source: file:///…/main_window-x.js (26)
 * Older Chromium writes `CONSOLE(26)`; both shapes are accepted.
 */
export function parseConsoleLine(line) {
  const m = /:(INFO|WARNING|ERROR|VERBOSE\d*):CONSOLE(?::\d+|\(\d+\))\] "(.*)", source: (.*)$/.exec(String(line));
  if (!m) return null;
  const level = m[1] === 'WARNING' ? 'warning' : m[1] === 'ERROR' ? 'error' : 'info';
  return { level, text: m[2].slice(0, 500), source: m[3].replace(/^file:\/\/.*\/(?=[^/]+$)/, '') };
}

/**
 * Does a process environment dump (`/proc/<pid>/environ` NUL-separated, or
 * `ps -E` space-separated) set WMUX_DATA_SUFFIX to exactly `suffix`?
 */
export function envHasSuffix(envText, suffix) {
  if (!suffix) return false;
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s\\0])WMUX_DATA_SUFFIX=${escaped}($|[\\s\\0])`).test(String(envText ?? ''));
}

/**
 * `ps -o lstart=` text (LC_ALL=C, e.g. `Thu Oct 22 10:00:05 2026`) as epoch
 * ms, or null. One parser for every caller, so a creation time recorded by one
 * script compares equal to the same process read by another.
 */
export function parseLstart(text) {
  const t = Date.parse(String(text ?? '').trim().replace(/\s+/g, ' '));
  return Number.isFinite(t) ? t : null;
}

/**
 * The command that reads one process's creation time. Its output goes through
 * parseProcessStart.
 *   - Windows: Win32_Process.CreationDate through `ConvertTo-Json`, the same
 *     shape (and the same parseCimDate) as a whole-table listing, so the two
 *     agree to the millisecond.
 *   - POSIX: `ps -o lstart=` (second precision), run with LC_ALL=C.
 */
export function processStartQuery(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress`],
    };
  }
  return { file: 'ps', args: ['-o', 'lstart=', '-p', String(pid)] };
}

/** A processStartQuery result as epoch ms; null when the process is gone or the output is unusable. */
export function parseProcessStart(stdout, pid, platform = process.platform) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  if (platform === 'win32') {
    let row;
    try { row = JSON.parse(text); } catch { return null; }
    if (Array.isArray(row)) row = row[0];
    if (!row || Number(row.ProcessId) !== pid) return null;
    return parseCimDate(row.CreationDate);
  }
  return parseLstart(text.split('\n')[0]);
}

/**
 * The command that lists every process with its parent and creation time, for
 * the e2e-first-run-lib normalizeProcessRows shape: CIM through
 * `ConvertTo-Json` on Windows (the same CreationDate pipeline as
 * processStartQuery), `ps` with lstart elsewhere (run it with LC_ALL=C).
 */
export function processListQuery(platform = process.platform) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress'],
    };
  }
  return { file: 'ps', args: ['-A', '-o', 'pid=,ppid=,lstart=,args='] };
}

/**
 * Is the recorded process (pid + creation time captured right after spawn)
 * the one holding that pid now? A missing creation time never matches:
 * without it the driver cannot tell its own process from a reused pid.
 */
export function sameProcess(recorded, current) {
  if (!recorded || !current) return false;
  if (!Number.isInteger(recorded.pid) || recorded.pid <= 0) return false;
  if (recorded.createdAt == null || current.createdAt == null) return false;
  return recorded.pid === current.pid && recorded.createdAt === current.createdAt;
}
