// ─── My Hermes — the owner's own Hermes profile, checked read-only ─────────
//
// A bot on "My Hermes" (BotEngine `mode: 'own'`) is bound to one of the
// owner's own Hermes profiles: `~/.hermes` (profile `default`) or
// `~/.hermes/profiles/<name>`. This version stores that choice and shows
// whether the profile could serve a bot; it never starts Hermes for one
// (botEngines.ts refuses the spawn).
//
// Everything here is read-only, and separate from wmux's managed Hermes
// (hermesEngine.ts `hermesReadiness` writes wmux's own home and starts a
// probe session; nothing of it is used here):
// - the profile folder is listed and checked with fs reads only;
// - `hermes --version` (Hermes's fast path, which skips its update check)
//   and `hermes acp --check` (imports only) run with the allowlisted
//   environment, then `hermes -p <profile> config get --json <key>` for the
//   few keys that decide readiness. No `config set`, no MCP probe, no gateway
//   start, no `hermes update`, no `hermes doctor` (it loads the profile's
//   keys into its own process and can call providers);
// - the profile's `.env` is read for its variable NAMES only (the messaging
//   tokens that turn a platform on); a value never leaves `envNames`;
// - `gateway_state.json` is read as wmux reads its own gateway's.
// `auth.json` and every other credential file are never opened.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HERMES_PROFILE_RE, MY_HERMES_DEFAULT_PROFILE } from '../../shared/bot';
import {
  HERMES_MESSENGER_TOKEN_ENV,
  HERMES_UPDATE_COMMAND,
  HERMES_VERSION_BELOW,
  HERMES_VERSION_MIN,
  hermesVersionStatus,
  parseHermesVersion,
  type MyHermesNotice,
  type MyHermesNotReadyReason,
  type MyHermesReadiness,
} from '../../shared/hermesEngine';
import { hermesEnv, hermesHasModel, readHermesGatewayState, resolveHermesExecutable, runHermes, type HermesRun } from './hermesEngine';

/** The Hermes root of `home` (the default profile's folder). Pure. */
export function myHermesRoot(home: string): string {
  return path.join(home, '.hermes');
}

/** The folder of `profile` (a checked name: HERMES_PROFILE_RE). Pure. */
export function myHermesProfileDir(home: string, profile: string): string {
  if (!HERMES_PROFILE_RE.test(profile)) throw new Error('not a Hermes profile name');
  const root = myHermesRoot(home);
  return profile === MY_HERMES_DEFAULT_PROFILE ? root : path.join(root, 'profiles', profile);
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The owner's Hermes profiles: `default` when `~/.hermes` exists, then
 *  each folder of `~/.hermes/profiles` whose name Hermes accepts. */
export function listMyHermesProfiles(home: string, deps: { isDir?: (p: string) => boolean; readdir?: (p: string) => string[] } = {}): string[] {
  const dirOk = deps.isDir ?? isDir;
  const readdir = deps.readdir ?? ((p: string) => fs.readdirSync(p));
  const root = myHermesRoot(home);
  if (!dirOk(root)) return [];
  const out = [MY_HERMES_DEFAULT_PROFILE];
  let names: string[] = [];
  try {
    names = readdir(path.join(root, 'profiles'));
  } catch {
    names = [];
  }
  for (const name of [...names].sort()) {
    if (name !== MY_HERMES_DEFAULT_PROFILE && HERMES_PROFILE_RE.test(name) && dirOk(path.join(root, 'profiles', name))) out.push(name);
  }
  return out.slice(0, 50);
}

/** The largest launcher script read to see which install it starts. */
const LAUNCHER_MAX_BYTES = 8 * 1024;

/** Whether `exe` is the Hermes installed in `root` (`<root>/hermes-agent`):
 *  the executable itself lives there, or it is the installer's small
 *  launcher script that execs a `hermes` there. A Hermes from elsewhere
 *  could migrate this home's state to its own version. */
export function hermesExeOwnedBy(
  exe: string,
  root: string,
  deps: { realpath?: (p: string) => string; readSmall?: (p: string) => string | null } = {},
): boolean {
  const real = deps.realpath ?? ((p: string) => fs.realpathSync(p));
  const install = path.join(root, 'hermes-agent');
  let installReal = install;
  try {
    installReal = real(install);
  } catch {
    /* compare as written */
  }
  const inside = (p: string): boolean => p === installReal || p.startsWith(installReal + path.sep) || p.startsWith(install + path.sep);
  try {
    if (inside(real(exe))) return true;
  } catch {
    return false;
  }
  const text = (deps.readSmall ?? readSmallText)(exe);
  if (text === null || !text.startsWith('#!')) return false;
  // `exec "<root>/hermes-agent/venv/bin/hermes" "$@"` (the installer's launcher).
  for (const m of text.matchAll(/(["']?)(\/[^"'\s]+\/hermes)\1/g)) {
    if (inside(m[2])) return true;
  }
  return false;
}

function readSmallText(p: string): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > LAUNCHER_MAX_BYTES) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** The variable names a `.env` text sets (`NAME=…`, `export NAME=…`),
 *  without their values. Pure. */
export function envNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The names in the profile's `.env` (never a value), or [] when it has none. */
function readEnvNames(file: string): string[] {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return [];
    return envNames(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

const truthy = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|on|1)$/i.test(v.trim()));
const falsy = (v: unknown): boolean => v === false || v === 0 || (typeof v === 'string' && /^(false|no|off|0)$/i.test(v.trim()));

/** The platforms a Hermes `platforms` block turns on (`<name>.enabled`), and
 *  the ones it turns off explicitly. `local` is the terminal, not a
 *  messenger. Pure. */
export function configuredPlatforms(...blocks: unknown[]): { on: string[]; off: string[] } {
  const on = new Set<string>();
  const off = new Set<string>();
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [name, cfg] of Object.entries(block as Record<string, unknown>)) {
      if (name === 'local' || !cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
      const enabled = (cfg as Record<string, unknown>).enabled;
      if (truthy(enabled)) on.add(name);
      else if (falsy(enabled)) off.add(name);
    }
  }
  return { on: [...on], off: [...off] };
}

/** Hermes's approvals.mode as Hermes reads it (tools/approval.py
 *  `_normalize_approval_mode`). Pure. */
export function hermesApprovalMode(v: unknown): 'manual' | 'smart' | 'off' {
  if (typeof v === 'boolean') return v ? 'manual' : 'off';
  if (typeof v === 'string') {
    const m = v.trim().toLowerCase();
    if (m === 'smart' || m === 'off') return m;
  }
  return 'manual';
}

/** MCP server names wmux refuses in the owner's config: a wmux server there
 *  would hand the bot wmux's operator tools. */
const WMUX_MCP_NAMES = new Set(['wmux', 'mcp-wmux', 'mcp_wmux']);

export interface MyHermesReadinessDeps {
  home: string;
  platform: NodeJS.Platform;
  resolveExe: () => string | null;
  run: HermesRun;
  /** Base environment (default process.env), allowlisted by hermesEnv. */
  baseEnv?: NodeJS.ProcessEnv;
  isDir?: (p: string) => boolean;
  /** Whether a PID is alive (default: signal 0). */
  pidAlive?: (pid: number) => boolean;
  ownedBy?: (exe: string, root: string) => boolean;
  envNamesOf?: (file: string) => string[];
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function notReady(reason: MyHermesNotReadyReason, message: string, extra: Partial<MyHermesReadiness> = {}): MyHermesReadiness {
  return { ready: false, reason, message, notices: [], ...extra };
}

/** Whether `profile` of the owner's Hermes could serve a bot, read-only.
 *  Never throws, never writes. */
export async function myHermesReadiness(profile: string, deps: MyHermesReadinessDeps): Promise<MyHermesReadiness> {
  try {
    if (deps.platform === 'win32') return notReady('unsupported-os', 'My Hermes runs on macOS and Linux in this version.');
    if (!HERMES_PROFILE_RE.test(profile)) return notReady('profile-missing', 'That is not a Hermes profile name.');
    const dir = myHermesProfileDir(deps.home, profile);
    if (!(deps.isDir ?? isDir)(dir)) return notReady('profile-missing', `No Hermes profile ${profile} was found.`);
    const exe = deps.resolveExe();
    if (!exe) return notReady('not-installed', 'Hermes is not installed (no hermes executable found).');
    const root = myHermesRoot(deps.home);
    if (!(deps.ownedBy ?? hermesExeOwnedBy)(exe, root)) {
      return notReady('foreign-install', `The hermes wmux found (${exe}) is not the one installed in ~/.hermes.`);
    }
    const env = hermesEnv(dir, deps.baseEnv ?? process.env, deps.platform, deps.home);
    const v = await deps.run(exe, ['--version'], { env, timeoutMs: 20_000 });
    const version = v.code === 0 ? parseHermesVersion(v.stdout) : null;
    if (!version) return notReady('unknown', 'Hermes did not report its version.');
    const status = hermesVersionStatus(version);
    if (status === 'outdated') return notReady('outdated', `Hermes ${version} is older than ${HERMES_VERSION_MIN}. Update it with \`${HERMES_UPDATE_COMMAND}\`.`, { version });
    if (status === 'unsupported') return notReady('unsupported', `Hermes ${version} is newer than the versions wmux was tested with (below ${HERMES_VERSION_BELOW}).`, { version });
    const check = await deps.run(exe, ['acp', '--check'], { env, timeoutMs: 30_000 });
    if (check.code !== 0) return notReady('acp-missing', 'Hermes\'s ACP support is missing (`hermes acp --check` failed).', { version });

    // Only `config get`: the profile is read, never written.
    const get = async (key: string): Promise<unknown> => {
      const r = await deps.run(exe, ['-p', profile, 'config', 'get', '--json', key], { env, timeoutMs: 20_000 });
      if (r.code !== 0) {
        if (/config key not set/i.test(r.stdout + r.stderr)) return undefined;
        throw new Error(`hermes config get ${key} failed`);
      }
      return JSON.parse(r.stdout.trim());
    };
    const [model, approvals, mcpServers, allowlist, platforms, gatewayPlatforms] = await Promise.all(
      ['model', 'approvals.mode', 'mcp_servers', 'command_allowlist', 'platforms', 'gateway.platforms'].map(get));

    const notices: MyHermesNotice[] = [];
    const mode = hermesApprovalMode(approvals);
    if (mode === 'smart') notices.push({ kind: 'approvals-smart' });
    if (Array.isArray(allowlist) && allowlist.length > 0) notices.push({ kind: 'allowlist', count: allowlist.length });
    const servers = mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers) ? Object.keys(mcpServers) : [];
    const wmuxServer = servers.find((s) => WMUX_MCP_NAMES.has(s.toLowerCase()));
    const others = servers.filter((s) => !WMUX_MCP_NAMES.has(s.toLowerCase()));
    if (others.length > 0) notices.push({ kind: 'mcp-servers', names: others.slice(0, 20) });
    const base = { version, notices };

    if (!hermesHasModel(model)) return notReady('no-model', 'This Hermes has no model set.', base);
    if (mode === 'off') return notReady('approvals-off', 'Approvals are off in this Hermes (approvals.mode: off), so every command would run without asking.', base);
    if (wmuxServer) {
      return notReady('wmux-mcp', `This Hermes has an MCP server named ${wmuxServer}, which would give the bot wmux's own tools. Remove it from ${profile === MY_HERMES_DEFAULT_PROFILE ? '~/.hermes' : `~/.hermes/profiles/${profile}`}/config.yaml.`, base);
    }
    const cfg = configuredPlatforms(gatewayPlatforms, platforms);
    const fromEnv = (deps.envNamesOf ?? readEnvNames)(path.join(dir, '.env'))
      .map((n) => HERMES_MESSENGER_TOKEN_ENV[n])
      .filter((p): p is string => typeof p === 'string' && !cfg.off.includes(p));
    const messengers = [...new Set([...cfg.on, ...fromEnv])].sort();
    if (messengers.length > 0) {
      return notReady('messengers', `This Hermes connects to ${messengers.join(', ')}.`, { ...base, platforms: messengers });
    }
    const state = readHermesGatewayState(dir);
    const live = state ? Object.keys(state.platforms).filter((p) => p !== 'local') : [];
    if (state && live.length > 0 && (deps.pidAlive ?? defaultPidAlive)(state.pid)) {
      return notReady('gateway-messengers', `This Hermes's gateway is running ${live.slice(0, 5).join(', ')}.`, { ...base, platforms: live.slice(0, 5).sort() });
    }
    return { ready: true, ...base };
  } catch (err) {
    return notReady('unknown', `Hermes could not be checked (${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}).`);
  }
}

/** The app's checks: the real home, PATH and runner. */
export function defaultMyHermesDeps(): MyHermesReadinessDeps {
  return { home: os.homedir(), platform: process.platform, resolveExe: () => resolveHermesExecutable(), run: runHermes };
}

/** How long an answer serves the picker's re-asks; a Check again is fresh. */
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: MyHermesReadiness }>();
const inFlight = new Map<string, Promise<MyHermesReadiness>>();

/** `myHermesReadiness`, one check per profile at a time, cached briefly. */
export function myHermesReadinessCached(profile: string, fresh: boolean, deps: MyHermesReadinessDeps = defaultMyHermesDeps(), now: () => number = Date.now): Promise<MyHermesReadiness> {
  const hit = cache.get(profile);
  if (!fresh && hit && now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  const running = inFlight.get(profile);
  if (running) return running;
  const p = myHermesReadiness(profile, deps).then((value) => {
    cache.set(profile, { at: now(), value });
    return value;
  }).finally(() => inFlight.delete(profile));
  inFlight.set(profile, p);
  return p;
}

/** Forget the cached answers (tests). */
export function clearMyHermesCache(): void {
  cache.clear();
  inFlight.clear();
}
