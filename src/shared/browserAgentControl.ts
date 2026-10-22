// Leaf module: no electron, no node imports. Main, the renderer and the MCP
// bundle all import it.

/**
 * Who may drive one in-app browser tab right now.
 *
 * - `agent`  — the default: agent browser tools act on the tab.
 * - `paused` — the user pressed Stop. The in-flight action was cancelled and
 *              every further agent action on the tab is refused until Resume.
 * - `user`   — the user took the tab over. Agent actions are refused until the
 *              user hands it back.
 *
 * Only the user's own UI moves a tab out of `agent` or back into it; no RPC an
 * agent can reach changes it.
 */
export type BrowserAgentControlMode = 'agent' | 'paused' | 'user';

/** What the renderer draws for one surface. */
export interface BrowserAgentControlState {
  surfaceId: string;
  /** An agent browser action is in flight on the tab (or ended a moment ago). */
  active: boolean;
  mode: BrowserAgentControlMode;
}

/** The user's intents. Each one is a single transition (see BrowserAgentControl). */
export type BrowserAgentControlIntent = 'stop' | 'resume' | 'takeOver' | 'handBack';

export const BROWSER_AGENT_CONTROL_INTENTS: readonly BrowserAgentControlIntent[] = [
  'stop',
  'resume',
  'takeOver',
  'handBack',
];

export function isBrowserAgentControlIntent(value: unknown): value is BrowserAgentControlIntent {
  return typeof value === 'string' && (BROWSER_AGENT_CONTROL_INTENTS as readonly string[]).includes(value);
}

/** A tab of the user's own Chrome that is lent to this workspace's agents. */
export interface LentLiveTab {
  surfaceId: string;
  title: string;
  url: string;
}

export const BROWSER_AGENT_CONTROL_IPC = {
  /** renderer → main: every surface whose state is not the idle default. */
  list: 'browser:agent-control:list',
  /** renderer → main: one user intent for one surface. */
  intent: 'browser:agent-control:intent',
  /** main → renderer: one surface's state changed. */
  changed: 'browser:agent-control:changed',
  /** renderer → main: the Live Chrome tabs lent to one workspace. */
  lentTabs: 'browser:agent-control:lent-tabs',
  /** renderer → main: hand one lent Live Chrome tab back to the user. */
  returnTab: 'browser:agent-control:return-tab',
} as const;

// ---------------------------------------------------------------------------
// Refusals agents get. Stable codes, carried as the message PREFIX (optionally
// after one `<rpc.method>: ` segment) so they survive the pipe, where only the
// message crosses.
// ---------------------------------------------------------------------------

export const AGENT_PAUSED_CODE = 'BROWSER_AGENT_PAUSED';
export const USER_IN_CONTROL_CODE = 'BROWSER_USER_IN_CONTROL';
export type BrowserAgentControlRefusalCode = typeof AGENT_PAUSED_CODE | typeof USER_IN_CONTROL_CODE;

const REFUSAL_TEXT: Record<BrowserAgentControlRefusalCode, string> = {
  [AGENT_PAUSED_CODE]:
    'the user paused agent control of this tab, so nothing was done. Do not retry: wait until the ' +
    'user resumes it, or ask them in the terminal.',
  [USER_IN_CONTROL_CODE]:
    'the user took over this tab and is using it, so nothing was done. Do not retry until the user ' +
    'hands it back; ask them in the terminal if you need it.',
};

const CANCEL_TEXT: Record<BrowserAgentControlRefusalCode, string> = {
  [AGENT_PAUSED_CODE]:
    'the user stopped this action and paused agent control of this tab. Part of the action may ' +
    'already have happened; once the user resumes, check the page before continuing.',
  [USER_IN_CONTROL_CODE]:
    'the user took over this tab while this action ran, and the action was stopped. Part of it may ' +
    'already have happened; once the user hands the tab back, check the page before continuing.',
};

export function refusalCodeForMode(mode: BrowserAgentControlMode): BrowserAgentControlRefusalCode | null {
  if (mode === 'paused') return AGENT_PAUSED_CODE;
  if (mode === 'user') return USER_IN_CONTROL_CODE;
  return null;
}

/** `<method>: <CODE>: <why>` — what main throws for a refused agent call. */
export function agentControlRefusalMessage(method: string, code: BrowserAgentControlRefusalCode): string {
  return `${method}: ${code}: ${REFUSAL_TEXT[code]}`;
}

/** `<CODE>: <why>` — what an in-flight action that the user stopped fails with. */
export function agentControlCancelMessage(code: BrowserAgentControlRefusalCode): string {
  return `${code}: ${CANCEL_TEXT[code]}`;
}

const REFUSAL_PREFIX = new RegExp(
  `^(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*:[ \\t]+)?(${AGENT_PAUSED_CODE}|${USER_IN_CONTROL_CODE}):`,
);

/** Typed refusal for the MCP lane. */
export class BrowserAgentControlError extends Error {
  readonly code: BrowserAgentControlRefusalCode;
  constructor(code: BrowserAgentControlRefusalCode, message: string) {
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = 'BrowserAgentControlError';
    this.code = code;
  }
}

/**
 * The refusal `error` carries, or null. The code must be the message prefix,
 * never a substring elsewhere, so a page title quoted inside some other error
 * cannot forge it.
 */
export function agentControlRefusal(error: unknown): BrowserAgentControlError | null {
  if (error instanceof BrowserAgentControlError) return error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = REFUSAL_PREFIX.exec(message);
  if (!match) return null;
  const body = message.replace(/^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*:[ \t]+)?/, '');
  return new BrowserAgentControlError(match[1] as BrowserAgentControlRefusalCode, body);
}
