// Pure helpers for scripts/control-wmux.mjs (the verify-wmux driver).
//
// Kept apart from the driver so the rules that keep an agent off the owner's
// real wmux (suffix validation, CDP port ownership, env scrubbing) can be unit
// tested without launching anything. See scripts/__tests__/controlWmux.test.mjs.
import fs from 'node:fs';
import path from 'node:path';

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
