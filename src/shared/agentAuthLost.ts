/**
 * An agent that lost its sign-in (N4). The daemon reports it when a turn ends
 * on an authentication failure, when an agent starts in a pane whose account
 * is signed out, and when a scheduled run is refused for that reason. main
 * folds the reports into one notice per agent and account, and the renderer
 * offers the agent's own sign-in. Nothing here carries a token or the
 * provider's message text.
 */

export type AuthLostAgent = 'claude' | 'codex';

/** Where the daemon saw it: a failed turn, an agent start, or a scheduled run it refused. */
export type AuthLostOrigin = 'turn' | 'start' | 'schedule';

export interface AgentAuthLost {
  agent: AuthLostAgent;
  /** The account's config dir (CLAUDE_CONFIG_DIR / CODEX_HOME), or null for the agent's default. */
  configDir: string | null;
  origin: AuthLostOrigin;
  /** The provider's own error code when a turn failed (`authentication_failed`, `unauthorized`, …). */
  providerCode?: string;
  at: number;
}

/** One signed-out agent and account, with the panes that reported it (main → renderer). */
export interface AuthLostEntry {
  key: string;
  agent: AuthLostAgent;
  configDir: string | null;
  ptyIds: string[];
}

export function isAuthLostAgent(value: unknown): value is AuthLostAgent {
  return value === 'claude' || value === 'codex';
}

export function authConfigEnvKey(agent: AuthLostAgent): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' {
  return agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
}

/** The account a pane or run uses, read from its env; null = the agent's default. */
export function authConfigDir(agent: AuthLostAgent, env: Readonly<Record<string, string | undefined>> | undefined): string | null {
  const dir = env?.[authConfigEnvKey(agent)]?.trim();
  return dir ? dir : null;
}

/** Dedup key: one notice per agent and account. */
export function authLostKey(agent: AuthLostAgent, configDir: string | null): string {
  return `${agent}:${configDir ?? ''}`;
}

const ORIGINS: ReadonlySet<string> = new Set(['turn', 'start', 'schedule']);
const PROVIDER_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Validate a report that crossed the daemon pipe; anything malformed is null. */
export function parseAgentAuthLost(value: unknown): AgentAuthLost | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isAuthLostAgent(v.agent) || typeof v.origin !== 'string' || !ORIGINS.has(v.origin)) return null;
  if (v.configDir !== null && (typeof v.configDir !== 'string' || v.configDir.length === 0 || v.configDir.length > 4096)) return null;
  const at = typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : Date.now();
  return {
    agent: v.agent,
    configDir: v.configDir,
    origin: v.origin as AuthLostOrigin,
    ...(typeof v.providerCode === 'string' && PROVIDER_CODE.test(v.providerCode) ? { providerCode: v.providerCode } : {}),
    at,
  };
}
