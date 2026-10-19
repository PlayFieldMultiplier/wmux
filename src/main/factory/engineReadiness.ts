// ─── The default bot engine: readiness and the Claude sign-in ──────────────
//
// FACTORY_ENGINE_READINESS answers whether a bot on the default engine
// (claude-sdk) can run here, without spending a model turn: the claude
// executable resolves (the same lookup botEngines.ts refuses a spawn on),
// a Claude sign-in is stored (the same credential check a bot's Claude
// login_request is settled on, botSecret.rpc.ts), and a short `claude
// --version` probe succeeds (no billing). The credential is read only to
// learn that it exists; nothing of it leaves this module.
//
// FACTORY_ENGINE_LOGIN starts the sign-in the app already uses for accounts:
// `claude auth login` in a new terminal tab of the active workspace, as the
// tab's startup command (the renderer's `surface.new` with `initialCommand`,
// which replaces a workspace profile's own startup command). One Claude
// config folder serves all three — the sign-in, readiness and the bots' own
// runs (the bot engine inherits main's environment, ClaudeSdkAdapter): main's
// CLAUDE_CONFIG_DIR when it has one, else Claude's default. The line sets
// that folder (or clears the variable for the default), so a workspace
// profile or account binding cannot send the sign-in elsewhere.
// The CLI opens the browser itself; the tab stays for the owner to read or
// close. One at a time. The renderer polls readiness to see the sign-in land.

import type { FactoryEngineReadiness } from '../../shared/factoryEngine';
import { probeClaudeExecutable, type ClaudeProbeDeps } from './claudeProbe';

export interface EngineReadinessDeps {
  claudeExecutable: () => string | null;
  /** loadClaudeCredential's outcome, without the credential. */
  credential: () => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
  /** Optional: override the version probe (tests). Absent: live probe. */
  probe?: (exe: string) => Promise<{ ok: true; version: string } | { ok: false; detail: string }>;
  /** Forwarded to the live probe when `probe` is absent. */
  probeOpts?: ClaudeProbeDeps;
}

/** The readiness of the default engine. Never throws. */
export async function engineReadiness(deps: EngineReadinessDeps): Promise<FactoryEngineReadiness> {
  let exe: string | null = null;
  try {
    exe = deps.claudeExecutable();
  } catch {
    exe = null;
  }
  if (!exe) {
    return { ready: false, reason: 'claude-not-installed', message: 'Claude Code is not installed (no claude executable found).' };
  }
  try {
    const r = await deps.credential();
    if (!r.ok) {
      if (r.reason === 'not-found') {
        return { ready: false, reason: 'claude-not-logged-in', message: 'Claude Code is not signed in.' };
      }
      return { ready: false, reason: 'unknown', message: r.detail ? `The Claude sign-in could not be read (${r.detail}).` : 'The Claude sign-in could not be read.' };
    }
  } catch {
    return { ready: false, reason: 'unknown', message: 'The Claude sign-in could not be read.' };
  }
  // Path + sign-in are not enough: a broken binary still fails the first turn.
  try {
    const probe = deps.probe ?? ((path: string) => probeClaudeExecutable(path, deps.probeOpts));
    const p = await probe(exe);
    if (!p.ok) {
      return {
        ready: false,
        reason: 'claude-unusable',
        message: `Claude is installed but could not run (${p.detail}).`,
      };
    }
  } catch (err) {
    return {
      ready: false,
      reason: 'claude-unusable',
      message: `Claude is installed but could not run (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  return { ready: true };
}

export const CLAUDE_LOGIN_COMMAND = 'claude auth login';

/** The Claude config folder the bots run on, readiness reads and the
 *  sign-in writes: main's CLAUDE_CONFIG_DIR, or undefined for Claude's
 *  default. */
export function botClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.CLAUDE_CONFIG_DIR;
  return v && v.trim() ? v : undefined;
}

/** The sign-in line for the tab's shell: CLAUDE_CONFIG_DIR set to
 *  `configDir` (quoted for that shell, as account.handler.ts quotes an
 *  account's), or cleared when there is none. `shell` is the shell the tab
 *  runs (Windows: the native one main picked; elsewhere undefined = the
 *  user's POSIX shell). Pure. */
export function claudeLoginLine(platform: NodeJS.Platform, shell: string | undefined, configDir?: string): string | null {
  if (platform === 'win32') {
    const base = (shell ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
    if (base.startsWith('cmd')) {
      // cmd cannot quote `"` or `%` inside `set "…"`: such a folder is not typed.
      if (configDir && /["%\r\n]/.test(configDir)) return null;
      return `set "CLAUDE_CONFIG_DIR=${configDir ?? ''}" & ${CLAUDE_LOGIN_COMMAND}`;
    }
    if (base.startsWith('pwsh') || base.startsWith('powershell') || base === '') {
      return configDir
        ? (/[\r\n\0]/.test(configDir) ? null : `$env:CLAUDE_CONFIG_DIR='${configDir.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'; ${CLAUDE_LOGIN_COMMAND}`)
        : `$env:CLAUDE_CONFIG_DIR=$null; ${CLAUDE_LOGIN_COMMAND}`;
    }
  }
  if (configDir && /[\r\n\0]/.test(configDir)) return null;
  return configDir
    ? `CLAUDE_CONFIG_DIR='${configDir.replace(/'/g, `'\\''`)}' ${CLAUDE_LOGIN_COMMAND}`
    : `env -u CLAUDE_CONFIG_DIR ${CLAUDE_LOGIN_COMMAND}`;
}

export interface EngineLoginDeps {
  /** Open a terminal tab in the active workspace running `initialCommand`
   *  (renderer `surface.new`); `shell` overrides the default shell. Resolves
   *  the new tab's PTY id, or an error. */
  openTab: (shell: string | undefined, initialCommand: string) => Promise<{ ptyId?: unknown; error?: unknown } | null | undefined>;
  /** On Windows, the native shell to use: a WSL default shell would run a
   *  Linux claude whose sign-in this app does not read. */
  windowsShell: () => string;
  platform: NodeJS.Platform;
  /** The folder to sign in to (botClaudeConfigDir); undefined = default. */
  configDir?: string;
}

let inFlight: Promise<void> | null = null;

/** Open the Claude sign-in tab. Rejects with a plain message when no tab
 *  could be opened; a second call while one is opening shares it. */
export function startEngineLogin(deps: EngineLoginDeps): Promise<void> {
  if (!inFlight) inFlight = open(deps).finally(() => { inFlight = null; });
  return inFlight;
}

async function open(deps: EngineLoginDeps): Promise<void> {
  const shell = deps.platform === 'win32' ? deps.windowsShell() : undefined;
  const line = claudeLoginLine(deps.platform, shell, deps.configDir);
  if (line === null) throw new Error(`wmux cannot type the sign-in for the Claude folder ${deps.configDir ?? ''} in this shell. Run \`claude auth login\` with CLAUDE_CONFIG_DIR set to it.`);
  let r: Awaited<ReturnType<EngineLoginDeps['openTab']>>;
  try {
    r = await deps.openTab(shell, line);
  } catch {
    throw new Error('wmux could not open a terminal for the Claude sign-in. Run `claude auth login` in a terminal.');
  }
  const ptyId = r && typeof r.ptyId === 'string' && r.ptyId ? r.ptyId : null;
  if (!ptyId) {
    throw new Error('wmux could not open a terminal for the Claude sign-in. Run `claude auth login` in a terminal.');
  }
}
