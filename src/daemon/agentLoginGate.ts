import { authConfigDir, authLostKey, type AuthLostAgent } from '../shared/agentAuthLost';

/** The agent's own status command, run with this env: true / false, or null when it cannot be told. */
export type LoginProbe = (agent: AuthLostAgent, env: NodeJS.ProcessEnv) => Promise<boolean | null>;

export const LOGIN_GATE_TTL_MS = 60_000;

/**
 * "Is this agent signed out for this account?" before a launch, at most one
 * status probe per agent and account a minute. Only a signed-out answer acts,
 * so only a signed-in or unknown answer is cached: a signed-out one is asked
 * again every time, which means a sign-in that just landed is seen by the very
 * next launch instead of being refused for the rest of the minute.
 */
export class AgentLoginGate {
  private readonly cache = new Map<string, { at: number; signedIn: boolean | null }>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly probe: LoginProbe, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? LOGIN_GATE_TTL_MS;
  }

  /** True only when the agent's status command says signed out. A failed probe is "cannot tell" (false). */
  signedOut(agent: AuthLostAgent, env: NodeJS.ProcessEnv): Promise<boolean> {
    const key = authLostKey(agent, authConfigDir(agent, env));
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return Promise.resolve(false);
    const running = this.inflight.get(key);
    if (running) return running;
    const check = this.probe(agent, env).catch(() => null).then((signedIn) => {
      if (signedIn === false) this.cache.delete(key);
      else this.cache.set(key, { at: this.now(), signedIn });
      return signedIn === false;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, check);
    return check;
  }
}
