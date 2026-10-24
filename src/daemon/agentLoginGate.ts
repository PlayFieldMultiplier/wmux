import { authConfigDir, authLostKey, type AuthLostAgent } from '../shared/agentAuthLost';

/**
 * The agent's own status command, run with this env: true / false, or null
 * when it cannot be told. The production probe (AgentSetupDetector.loginState)
 * is bounded by its runner's timeout, which kills the probe and answers null.
 */
export type LoginProbe = (agent: AuthLostAgent, env: NodeJS.ProcessEnv) => Promise<boolean | null>;

export const LOGIN_GATE_TTL_MS = 60_000;

/**
 * "Is this agent signed in for this account?" before a launch, at most one
 * status probe per agent and account a minute. Only a signed-out answer acts,
 * so only a signed-in or unknown answer is cached: a signed-out one is asked
 * again every time, which means a sign-in that just landed is seen by the very
 * next launch instead of being refused for the rest of the minute.
 *
 * `forget` drops what is known about an account (a turn just failed on its
 * sign-in, or just worked). A probe already running for it then answers
 * "cannot tell" instead of its now-stale result, and is not cached.
 */
export class AgentLoginGate {
  private readonly cache = new Map<string, { at: number; signedIn: boolean | null }>();
  private readonly inflight = new Map<string, Promise<boolean | null>>();
  private readonly generation = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly probe: LoginProbe, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? LOGIN_GATE_TTL_MS;
  }

  /** Signed in (true), signed out (false), or cannot tell (null; a failed probe too). */
  check(agent: AuthLostAgent, env: NodeJS.ProcessEnv): Promise<boolean | null> {
    const key = authLostKey(agent, authConfigDir(agent, env));
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return Promise.resolve(hit.signedIn);
    const running = this.inflight.get(key);
    if (running) return running;
    const started = this.generation.get(key) ?? 0;
    const check: Promise<boolean | null> = this.probe(agent, env).catch(() => null).then((signedIn) => {
      if ((this.generation.get(key) ?? 0) !== started) return null;
      if (signedIn === false) this.cache.delete(key);
      else this.cache.set(key, { at: this.now(), signedIn });
      return signedIn;
    }).finally(() => {
      if (this.inflight.get(key) === check) this.inflight.delete(key);
    });
    this.inflight.set(key, check);
    return check;
  }

  /** True only when the agent's status command says signed out. */
  async signedOut(agent: AuthLostAgent, env: NodeJS.ProcessEnv): Promise<boolean> {
    return (await this.check(agent, env)) === false;
  }

  forget(agent: AuthLostAgent, configDir: string | null): void {
    const key = authLostKey(agent, configDir);
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.cache.delete(key);
    this.inflight.delete(key);
  }
}
