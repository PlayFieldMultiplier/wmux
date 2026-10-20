// The install and sign-in commands behind the "Agent ready" cards.
//
// SUPPLY CHAIN: this table ships inside the app and changes only with an app
// release. wmux never fetches a command (or a list of commands) at runtime;
// the line the user is shown and confirms is exactly the line typed into the
// visible pane. Each line is the agent vendor's own documented native
// installer, copied verbatim (no flag added or removed) from the source URL
// next to it, checked 2026-10-21. Both install into the user's own folder and
// need no administrator rights and no Node.js. When an install fails, the card
// opens `officialPage` instead of trying anything else.

import type { AgentId } from './agentSetup';

/** Which shell the pane runs the line in. */
export type AgentCommandShell =
  /** The user's own default shell (macOS / Linux). */
  | 'user'
  /**
   * Windows PowerShell. Both Windows lines are PowerShell syntax, and a WSL or
   * cmd default shell would run a different (or no) install than the Windows
   * one wmux detects.
   */
  | 'powershell';

export interface AgentInstallMethod {
  command: string;
  shell: AgentCommandShell;
  /** Where the command was copied from. */
  source: string;
  /** Opened when the install fails or a prerequisite is missing. */
  officialPage: string;
  /** Programs the line itself calls, checked before it is offered. */
  requires: readonly string[];
}

const CLAUDE_PAGE = 'https://code.claude.com/docs/en/setup';
const CODEX_PAGE = 'https://learn.chatgpt.com/docs/codex/cli';

/** Bundled install lines, by agent and by `posix` (macOS, Linux) / `win32`. */
export const AGENT_INSTALL_TABLE: Readonly<Record<AgentId, Readonly<Record<'posix' | 'win32', AgentInstallMethod>>>> = {
  claude: {
    // Source: https://code.claude.com/docs/en/setup, "Native Install
    // (Recommended)", macOS, Linux, WSL.
    posix: {
      command: 'curl -fsSL https://claude.ai/install.sh | bash',
      shell: 'user',
      source: CLAUDE_PAGE,
      officialPage: CLAUDE_PAGE,
      requires: ['curl', 'bash'],
    },
    // Source: https://code.claude.com/docs/en/setup, "Native Install
    // (Recommended)", Windows PowerShell ("You do not need to run as
    // Administrator").
    win32: {
      command: 'irm https://claude.ai/install.ps1 | iex',
      shell: 'powershell',
      source: CLAUDE_PAGE,
      officialPage: CLAUDE_PAGE,
      requires: [],
    },
  },
  codex: {
    // Source: https://github.com/openai/codex README ("Mac or Linux") and
    // https://learn.chatgpt.com/docs/codex/cli (macOS/Linux tab).
    posix: {
      command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      shell: 'user',
      source: 'https://github.com/openai/codex#readme',
      officialPage: CODEX_PAGE,
      requires: ['curl', 'sh'],
    },
    // Source: https://github.com/openai/codex README ("Windows"). The
    // `-ExecutionPolicy ByPass` is the vendor's own text, kept verbatim.
    win32: {
      command: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      shell: 'powershell',
      source: 'https://github.com/openai/codex#readme',
      officialPage: CODEX_PAGE,
      requires: [],
    },
  },
};

export function agentInstallMethod(agent: AgentId, platform: NodeJS.Platform): AgentInstallMethod {
  return AGENT_INSTALL_TABLE[agent][platform === 'win32' ? 'win32' : 'posix'];
}

/** Official install page for an agent (the fallback whenever a command fails). */
export function agentOfficialPage(agent: AgentId): string {
  return agent === 'claude' ? CLAUDE_PAGE : CODEX_PAGE;
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
    const q = `'${executable.replace(/'/g, "''")}'`;
    return isScript ? `node ${q}` : `& ${q}`;
  }
  const q = `'${executable.replace(/'/g, `'\\''`)}'`;
  return isScript ? `node ${q}` : q;
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

/** What the card needs to offer an install or a sign-in. */
export interface AgentSetupPlan {
  agent: AgentId;
  install: {
    command: string;
    shell: AgentCommandShell;
    officialPage: string;
    /** Programs `command` needs that were not found; non-empty = cannot run here. */
    missing: string[];
  };
  /** Null when the agent is not installed. */
  login: { command: string; shell: AgentCommandShell } | null;
}

/** Outcome of the "installed but not found" path field. */
export type SetAgentPathResult =
  | { ok: true }
  | { ok: false; reason: 'not-absolute' | 'not-found' | 'wrong-program' | 'does-not-run' };

/** File names a typed path may end in, per agent (case-insensitive). */
export const AGENT_EXECUTABLE_NAMES: Readonly<Record<AgentId, readonly string[]>> = {
  claude: ['claude', 'claude.exe', 'cli.js'],
  codex: ['codex', 'codex.exe', 'codex.js'],
};
