// ─── The default bot engine: readiness and the Claude sign-in ──────────────
//
// FACTORY_ENGINE_READINESS answers whether a bot on the default engine
// (claude-sdk) can run here, without spending a model turn: the claude
// executable resolves (the same lookup botEngines.ts refuses a spawn on) and
// a Claude sign-in is stored (the same credential check a bot's Claude
// login_request is settled on, botSecret.rpc.ts). The credential is read only
// to learn that it exists; nothing of it leaves this module.
//
// FACTORY_ENGINE_LOGIN starts the sign-in the app already uses for accounts:
// `claude auth login` in a new terminal tab of the active workspace (the
// renderer's `surface.new`), typed once the shell is up. The line clears
// CLAUDE_CONFIG_DIR first, so a workspace profile or account binding cannot
// send the sign-in to another config folder than the one readiness reads.
// The CLI opens the browser itself; the tab stays for the owner to read or
// close. One at a time. The renderer polls readiness to see the sign-in land.
// Known gap: a workspace whose profile starts an agent in every new pane
// receives the line as that agent's input.

import type { FactoryEngineReadiness } from '../../shared/factoryEngine';

export interface EngineReadinessDeps {
  claudeExecutable: () => string | null;
  /** loadClaudeCredential's outcome, without the credential. */
  credential: () => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
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
    if (r.ok) return { ready: true };
    if (r.reason === 'not-found') {
      return { ready: false, reason: 'claude-not-logged-in', message: 'Claude Code is not signed in.' };
    }
    return { ready: false, reason: 'unknown', message: r.detail ? `The Claude sign-in could not be read (${r.detail}).` : 'The Claude sign-in could not be read.' };
  } catch {
    return { ready: false, reason: 'unknown', message: 'The Claude sign-in could not be read.' };
  }
}

export const CLAUDE_LOGIN_COMMAND = 'claude auth login';

/** The sign-in line for the tab's shell, with CLAUDE_CONFIG_DIR cleared.
 *  `shell` is the shell the tab runs (Windows: the native one main picked;
 *  elsewhere undefined = the user's POSIX shell). Pure. */
export function claudeLoginLine(platform: NodeJS.Platform, shell: string | undefined): string {
  if (platform === 'win32') {
    const base = (shell ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
    if (base.startsWith('cmd')) return `set "CLAUDE_CONFIG_DIR=" & ${CLAUDE_LOGIN_COMMAND}`;
    if (base.startsWith('pwsh') || base.startsWith('powershell') || base === '') return `$env:CLAUDE_CONFIG_DIR=$null; ${CLAUDE_LOGIN_COMMAND}`;
  }
  return `env -u CLAUDE_CONFIG_DIR ${CLAUDE_LOGIN_COMMAND}`;
}

export interface EngineLoginDeps {
  /** Open a terminal tab in the active workspace (renderer `surface.new`);
   *  `shell` overrides the default shell. Resolves the new tab's PTY id. */
  openTab: (shell: string | undefined) => Promise<{ ptyId?: unknown; error?: unknown } | null | undefined>;
  /** Type `line` + Enter into the tab once its shell can read it. */
  typeLine: (ptyId: string, line: string) => void;
  /** On Windows, the native shell to use: a WSL default shell would run a
   *  Linux claude whose sign-in this app does not read. */
  windowsShell: () => string;
  platform: NodeJS.Platform;
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
  let r: Awaited<ReturnType<EngineLoginDeps['openTab']>>;
  try {
    r = await deps.openTab(shell);
  } catch {
    throw new Error('wmux could not open a terminal for the Claude sign-in. Run `claude auth login` in a terminal.');
  }
  const ptyId = r && typeof r.ptyId === 'string' && r.ptyId ? r.ptyId : null;
  if (!ptyId) {
    throw new Error('wmux could not open a terminal for the Claude sign-in. Run `claude auth login` in a terminal.');
  }
  deps.typeLine(ptyId, claudeLoginLine(deps.platform, shell));
}
