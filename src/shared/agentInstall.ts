// The install and sign-in commands behind the "Agent ready" cards.
//
// SUPPLY CHAIN: the install lines live on the agents' registry rows
// (src/shared/agentIdentity.ts, `setup.install`), ship inside the app and
// change only with an app release. wmux never fetches a command (or a list of
// commands) at runtime; the line the user is shown and confirms is exactly the
// line typed into the visible pane. Each line is the vendor's own documented
// installer, copied verbatim (no flag added or removed) from the source URL
// next to it; the one WinGet line is `winget install` with the package id the
// vendor documents. They install into the user's own folder and need no
// administrator rights and no Node.js. When an install fails, the card opens
// `officialPage` instead of trying anything else.

import { agentRow } from './agentIdentity';
import type { AgentId } from './agentSetup';

/** Which shell the pane runs the line in. */
export type AgentCommandShell =
  /** The user's own default shell (macOS / Linux). */
  | 'user'
  /**
   * Windows PowerShell. The vendors' main Windows lines are PowerShell syntax,
   * and a WSL or cmd default shell would run a different (or no) install than
   * the Windows one wmux detects.
   */
  | 'powershell'
  /** cmd.exe, for a vendor line written for it (`&&`, `del`). */
  | 'cmd';

/** Which of an agent's documented lines: its main installer script, or one of
 *  the row's `install.more`. */
export type AgentInstallVia = 'script' | 'winget' | 'cmd';

export interface AgentInstallMethod {
  via: AgentInstallVia;
  command: string;
  shell: AgentCommandShell;
  /** Where the command was copied from. */
  source: string;
  /** Opened when the install fails or a prerequisite is missing. */
  officialPage: string;
  /** Programs the line itself calls, checked before it is offered. */
  requires: readonly string[];
}

/** Every bundled install line for an agent on this platform, the row's main
 *  one first, then its other documented ways there (`install.more`). */
export function agentInstallMethods(agent: AgentId, platform: NodeJS.Platform): AgentInstallMethod[] {
  const install = agentRow(agent)?.setup?.install;
  if (!install) return [];
  const win = platform === 'win32';
  const main: AgentInstallMethod = {
    via: 'script',
    command: win ? install.win32.command : install.posix.command,
    shell: win ? 'powershell' : 'user',
    source: install.source,
    officialPage: install.officialPage,
    requires: win ? [] : install.posix.requires,
  };
  const more = (install.more ?? [])
    .filter((m) => m.platform === (win ? 'win32' : 'posix'))
    .map((m): AgentInstallMethod => ({
      via: m.via,
      command: m.command,
      shell: m.via === 'cmd' ? 'cmd' : win ? 'powershell' : 'user',
      source: m.source,
      officialPage: install.officialPage,
      requires: m.requires,
    }));
  return [main, ...more];
}

/** The bundled install line for an agent on this platform (from its row). */
export function agentInstallMethod(agent: AgentId, platform: NodeJS.Platform): AgentInstallMethod | null {
  return agentInstallMethods(agent, platform)[0] ?? null;
}

/** Official install page for an agent (the fallback whenever a command fails). */
export function agentOfficialPage(agent: AgentId): string | null {
  return agentRow(agent)?.setup?.install.officialPage ?? null;
}

/** File names a typed path may end in: the binary, its `.exe`, and the npm entrypoints. */
export function agentExecutableNames(agent: AgentId): string[] {
  const spec = agentRow(agent)?.setup;
  if (!spec) return [];
  const entries = (spec.npm?.winEntries ?? []).map((e) => e[e.length - 1] ?? '').filter(Boolean);
  return [...new Set([spec.binary, `${spec.binary}.exe`, ...entries].map((n) => n.toLowerCase()))];
}

/**
 * The sign-in line: the agent itself, started interactively, at the exact path
 * the card detected (so the card and the pane talk about the same install, and
 * a folder not yet on the pane's PATH does not matter). It is the agent's own
 * first-run flow, which asks the user how to sign in; wmux picks nothing.
 * `claude auth login` is deliberately not used: it signs in with the
 * subscription method unless told otherwise, which would choose for the user.
 * Quoted for the pane's shell, so spaces and non-ASCII folders are safe.
 */
export function agentLoginCommand(executable: string, shell: AgentCommandShell): string {
  const isScript = /\.(c|m)?js$/i.test(executable);
  if (shell === 'powershell') {
    // PowerShell also ends a single-quoted string at the typographic single
    // quotes, so those are doubled too (same rule as chat/v2/handoff pwshQuote).
    const q = `'${executable.replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c)}'`;
    return isScript ? `node ${q}` : `& ${q}`;
  }
  const q = `'${executable.replace(/'/g, `'\\''`)}'`;
  return isScript ? `node ${q}` : q;
}

/** Quoting family of a shell executable: PowerShell (pwsh) or POSIX-like. */
export function shellSyntax(shellPath: string | undefined): AgentCommandShell {
  const base = (shellPath ?? '').split(/[\\/]/).pop() ?? '';
  return /^(pwsh|powershell)(\.exe)?$/i.test(base) ? 'powershell' : 'user';
}

/** Why an install line did not finish, read from the end of its pane. */
export type InstallFailureKind = 'network' | 'permission' | 'unknown';

// Allow-lists of what curl, PowerShell's Invoke-RestMethod and the two
// installers print for these causes. Anything else is 'unknown' (the card then
// shows the log and the official page); this is not a parser.
const NETWORK_PATTERNS: readonly RegExp[] = [
  /could not resolve (host|proxy)/i,
  /failed to connect/i,
  /connection (timed out|refused|reset)/i,
  /\bproxy\b/i,
  /\bSSL\b|certificate|\bTLS\b/i,
  /curl: \(\d+\)/i,
  /the remote name could not be resolved/i,
  /unable to connect to the remote server/i,
  /\(403\)|\b403\b forbidden|error 403/i,
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND/,
];

const PERMISSION_PATTERNS: readonly RegExp[] = [
  /permission denied/i,
  /access (to the path .* )?is denied/i,
  /\bEACCES\b|\bEPERM\b/,
  /operation not permitted/i,
  /read-only file system/i,
];

export function classifyInstallFailure(paneText: string): InstallFailureKind {
  if (NETWORK_PATTERNS.some((re) => re.test(paneText))) return 'network';
  if (PERMISSION_PATTERNS.some((re) => re.test(paneText))) return 'permission';
  return 'unknown';
}

/** One install line the card can offer. */
export interface AgentSetupPlanInstall {
  via: AgentInstallVia;
  command: string;
  shell: AgentCommandShell;
  officialPage: string;
  /** Programs `command` needs that were not found; non-empty = cannot run here. */
  missing: string[];
}

/** What the card needs to offer an install or a sign-in. */
export interface AgentSetupPlan {
  agent: AgentId;
  /** The main line (`installs[0]`). */
  install: AgentSetupPlanInstall;
  /** Every documented line on this platform, the main one first. */
  installs: AgentSetupPlanInstall[];
  /** Null when the agent is not installed. */
  login: { command: string; shell: AgentCommandShell } | null;
}

/** Outcome of the "installed but not found" path field. */
export type SetAgentPathResult =
  | { ok: true }
  | { ok: false; reason: 'not-absolute' | 'not-found' | 'wrong-program' | 'does-not-run' };
