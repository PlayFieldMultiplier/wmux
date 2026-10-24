import { describe, expect, it, vi } from 'vitest';
import { AgentLoginGate } from '../agentLoginGate';

const account = (dir?: string): NodeJS.ProcessEnv => (dir ? { CLAUDE_CONFIG_DIR: dir } : {});

describe('AgentLoginGate', () => {
  it('lets a launch through the moment a sign-in lands, inside the cache window', async () => {
    const clock = { t: 0 };
    let signedIn = false;
    const probe = vi.fn(async () => signedIn);
    const gate = new AgentLoginGate(probe, { now: () => clock.t, ttlMs: 60_000 });
    expect(await gate.signedOut('claude', account('/acc/a'))).toBe(true);
    // The user signs in; one second later the next launch is not refused.
    signedIn = true;
    clock.t += 1_000;
    expect(await gate.signedOut('claude', account('/acc/a'))).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('asks each agent and account at most once a minute while it is signed in, and shares a probe in flight', async () => {
    const clock = { t: 0 };
    const probe = vi.fn(async () => true);
    const gate = new AgentLoginGate(probe, { now: () => clock.t, ttlMs: 60_000 });
    await Promise.all([gate.signedOut('claude', account()), gate.signedOut('claude', account())]);
    expect(probe).toHaveBeenCalledTimes(1);
    clock.t += 59_000;
    await gate.signedOut('claude', account());
    expect(probe).toHaveBeenCalledTimes(1);
    // Another account and another agent are their own entries.
    await gate.signedOut('claude', account('/acc/b'));
    await gate.signedOut('codex', account());
    expect(probe).toHaveBeenCalledTimes(3);
    clock.t += 2_000;
    await gate.signedOut('claude', account());
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('treats "cannot tell" and a failed probe as not signed out', async () => {
    expect(await new AgentLoginGate(async () => null).signedOut('codex', {})).toBe(false);
    expect(await new AgentLoginGate(async () => { throw new Error('spawn failed'); }).signedOut('codex', {})).toBe(false);
  });
});
