import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { liveRecoveryHint, markCwdMissing, namedAgentAlive } from '../recoveryHint';

describe('liveRecoveryHint', () => {
  const make = () => ({
    hints: new Map<string, string>([['p1', 'claude']]),
    bindings: new Map<string, { sessionId: string }>([['p1', { sessionId: 'x' }]]),
  });

  it('drops a hint and its binding once the pane agent is observed alive', () => {
    const { hints, bindings } = make();
    expect(liveRecoveryHint('p1', () => true, hints, bindings)).toBeUndefined();
    expect(hints.has('p1')).toBe(false);
    expect(bindings.has('p1')).toBe(false);
  });

  it('keeps the hint while liveness is unknown or the agent is not running', () => {
    for (const alive of [undefined, false]) {
      const { hints, bindings } = make();
      expect(liveRecoveryHint('p1', () => alive, hints, bindings)).toBe('claude');
      expect(hints.has('p1')).toBe(true);
      expect(bindings.has('p1')).toBe(true);
    }
  });

  it('returns undefined for a pane that was never flagged', () => {
    const { hints, bindings } = make();
    expect(liveRecoveryHint('p2', () => true, hints, bindings)).toBeUndefined();
    expect(hints.size).toBe(1);
  });
});

describe('namedAgentAlive', () => {
  it('answers only for a process attributed to a named agent', () => {
    expect(namedAgentAlive({ slug: 'claude', alive: true })).toBe(true);
    expect(namedAgentAlive({ slug: 'claude', alive: false })).toBe(false);
    // A slugless pick: `tail -f` printing a quoted banner is not an agent.
    expect(namedAgentAlive({ alive: true })).toBeUndefined();
    expect(namedAgentAlive(undefined)).toBeUndefined();
  });

  it('the daemon consumes recovery hints on named-agent liveness only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    const calls = src.match(/liveRecoveryHint\([^,]+, \([^)]*\) => [^,]+,/g) ?? [];
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toMatch(/namedAgentAlive\(agentProcessTracker\.identityFor\(/);
  });
});

describe('markCwdMissing', () => {
  const binding = { agent: 'claude', sessionId: 'a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a', cwd: '/repo/wt-gone', ts: 1, transcriptPath: '/t/x.jsonl' };
  const gone = () => false;
  const lives = () => true;

  it('marks a person-driven pane whose folder is gone while its transcript lives', () => {
    const out = markCwdMissing(binding, { cmd: '/bin/zsh' }, lives, gone);
    expect(out).toEqual({ ...binding, cwdMissing: true });
    expect(binding).not.toHaveProperty('cwdMissing'); // the stored binding is never changed
  });

  it('leaves exec, supervised and WSL panes, a present folder and a purged transcript unmarked', () => {
    for (const pane of [{ exec: { command: 'claude' } }, { supervision: {} }, { wslTarget: { distro: 'Ubuntu' } }]) {
      expect(markCwdMissing(binding, pane, lives, gone)).toBe(binding);
    }
    expect(markCwdMissing(binding, {}, lives, () => true)).toBe(binding);
    expect(markCwdMissing(binding, {}, () => false, gone)).toBe(binding);
  });
});
