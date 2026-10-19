import { describe, expect, it, vi } from 'vitest';
import { AgentDetector, type AgentSlug } from '../AgentDetector';

function detector() {
  const det = new AgentDetector();
  const events = vi.fn();
  const quota = vi.fn();
  det.onEvent(events);
  det.onUsageLimit(quota);
  return { det, events, quota };
}

function seed(det: AgentDetector, slug: AgentSlug) {
  return det.seedTrustedIdentity(slug, det.getIdentityEpoch());
}

describe('AgentDetector trusted launch identity', () => {
  it.each([
    ['agy', 'Do you trust the contents of this project?\n', 'Antigravity CLI', 'awaiting_input'],
    ['opencode', 'opencode>\n', 'OpenCode', 'waiting'],
    ['claude', 'Do you want to proceed?\n❯ 1. Yes\n', 'Claude Code', 'awaiting_input'],
  ] as const)('recognizes a %s prompt without claiming process presence is a turn', (slug, prompt, agent, status) => {
    const { det, events } = detector();
    det.feed(prompt);
    expect(events).not.toHaveBeenCalled();
    expect(seed(det, slug)).toBe(true);
    expect(events).not.toHaveBeenCalled();
    expect(det.getLastAgent()).toBeNull(); // external identity is not screen evidence
    expect(det.getTrustedAgent()).toBe(slug);
    det.feed(prompt);
    expect(events.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ agent, status }),
    ]);
    expect(det.getLastAgent()).toBeNull(); // a gated prompt does not become a banner
  });

  it('keeps repeated evidence idempotent, including a pending dialog and dedup', () => {
    const { det, events } = detector();
    seed(det, 'claude');
    det.feed('Do you want to proceed?\n');
    const epoch = det.getIdentityEpoch();
    expect(seed(det, 'claude')).toBe(true);
    expect(det.getIdentityEpoch()).toBe(epoch);
    det.feed('❯ 1. Yes\n');
    expect(events).toHaveBeenCalledTimes(1);
    seed(det, 'claude');
    det.feed('Do you want to proceed?\n❯ 1. Yes\n');
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('does not let another provider chrome override a trusted owner', () => {
    const { det, events } = detector();
    seed(det, 'agy');
    det.feed('Claude Code\nbypass permissions on\n');
    det.feed('Kiro CLI\nask a question or describe a task\n');
    det.feed('>_ OpenAI Codex (v0.149.1)\n');
    expect(events).not.toHaveBeenCalled();
    expect(det.getLastAgent()).toBeNull();
    det.feed('Do you trust the contents of this project?\n');
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ agent: 'Antigravity CLI', status: 'awaiting_input' }));
  });

  it.each(['\u001b]133;A\u0007', '\u001b]133;D;0\u001b\\'])('revokes authority at the complete shell boundary %j', (boundary) => {
    const { det, events } = detector();
    seed(det, 'agy');
    const oldEpoch = det.getIdentityEpoch();
    det.feed(boundary.slice(0, -1));
    expect(det.getIdentityEpoch()).toBe(oldEpoch);
    expect(det.getTrustedAgent()).toBe('agy');
    det.feed(boundary.slice(-1));
    expect(det.getIdentityEpoch()).toBeGreaterThan(oldEpoch);
    expect(det.getIdentityBoundaryAt()).toBeGreaterThan(0);
    expect(det.getTrustedAgent()).toBeNull();
    expect(det.seedTrustedIdentity('agy', oldEpoch)).toBe(false);
    det.feed('Do you trust the contents of this project?\n');
    expect(events).not.toHaveBeenCalled();
    expect(seed(det, 'agy')).toBe(true);
    det.feed('Do you trust the contents of this project?\n');
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('rejects an in-flight old epoch even before any identity has been seen', () => {
    const { det, events } = detector();
    const epoch = det.getIdentityEpoch();
    det.feed('\u001b]133;A\u0007');
    expect(det.seedTrustedIdentity('agy', epoch)).toBe(false);
    det.feed('Do you trust the contents of this project?\n');
    expect(events).not.toHaveBeenCalled();
  });

  it('clears confirmed death/disposal evidence and accepts only a new epoch', () => {
    const { det, events } = detector();
    seed(det, 'claude');
    det.feed('Do you want to proceed?\n');
    const oldEpoch = det.getIdentityEpoch();
    det.clearTrustedIdentity();
    expect(det.getTrustedAgent()).toBeNull();
    expect(det.getLastAgent()).toBeNull();
    expect(det.seedTrustedIdentity('claude', oldEpoch)).toBe(false);
    seed(det, 'claude');
    det.feed('❯ 1. Yes\n');
    expect(events).not.toHaveBeenCalled();
    det.feed('Do you want to proceed?\n❯ 1. Yes\n');
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('clears old line, compound, dialog, and quota evidence on identity replacement', () => {
    const { det, events, quota } = detector();
    seed(det, 'codex');
    det.feed("■ You've hit your usage limit. Upgrade to Pro or\n");
    expect(quota).toHaveBeenCalledTimes(1);
    seed(det, 'claude');
    det.feed('Do you want to proceed?\n');
    const oldEpoch = det.getIdentityEpoch();
    seed(det, 'opencode');
    expect(det.getIdentityEpoch()).toBeGreaterThan(oldEpoch);
    expect(det.seedTrustedIdentity('claude', oldEpoch)).toBe(false);
    det.feed('openco');
    seed(det, 'claude');
    det.feed('de>\n❯ 1. Yes\n');
    expect(events).not.toHaveBeenCalled();
    seed(det, 'codex');
    quota.mockClear();
    det.feed('try again in 2 hours.\n');
    expect(quota).not.toHaveBeenCalled();
  });

  it('promotes real same-provider chrome to screen evidence without a started event', () => {
    const { det, events } = detector();
    seed(det, 'opencode');
    det.feed('\u001b]0;OpenCode\u0007');
    expect(det.getLastAgent()).toBe('OpenCode');
    expect(det.getTrustedAgent()).toBe('opencode');
    expect(events).not.toHaveBeenCalled();
  });

  it('preserves existing same-provider screen evidence without duplicate started events', () => {
    const { det, events } = detector();
    det.feed('\u001b]0;OpenCode\u0007');
    events.mockClear();
    seed(det, 'opencode');
    expect(det.getLastAgent()).toBe('OpenCode');
    expect(events).not.toHaveBeenCalled();
    seed(det, 'agy');
    expect(det.getLastAgent()).toBeNull();
    expect(events).not.toHaveBeenCalled();
  });

  it('exposes a monotonic invalidation time without treating repeated seeds as a new boundary', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const { det, events } = detector();
      now.mockReturnValue(1000);
      expect(det.getIdentityBoundaryAt()).toBe(0);
      seed(det, 'opencode');
      expect(det.getIdentityBoundaryAt()).toBe(0);
      det.feed('\u001b]133;A\u0007');
      const shellEpoch = det.getIdentityEpoch();
      expect(det.getIdentityBoundaryAt()).toBe(1000);
      seed(det, 'opencode');
      seed(det, 'opencode');
      expect(det.getIdentityEpoch()).toBe(shellEpoch);
      now.mockReturnValue(900); // clock rollback cannot admit pre-boundary hooks
      seed(det, 'agy');
      expect(det.getIdentityBoundaryAt()).toBe(1000);
      now.mockReturnValue(1100);
      det.clearTrustedIdentity();
      expect(det.getIdentityBoundaryAt()).toBe(1100);
      expect(events).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('can confirm a seeded compound Claude profile with later real chrome', () => {
    const { det, events } = detector();
    seed(det, 'claude');
    det.feed('Claude Code\nbypass permissions on\n');
    expect(det.getLastAgent()).toBe('Claude Code');
    expect(events.mock.calls.map((call) => call[0].status)).toEqual(['waiting']);
    expect(events.mock.calls.map((call) => call[0].message)).not.toContain('Agent started');
  });

  it('retains strict screen gates after authority is revoked', () => {
    const { det, events } = detector();
    seed(det, 'opencode');
    det.clearTrustedIdentity();
    det.feed('Documentation: compare opencode with other tools.\n');
    expect(events).not.toHaveBeenCalled();
    det.feed('\u001b]0;OpenCode\u0007');
    expect(events).toHaveBeenCalledWith({ agent: 'OpenCode', status: 'running', message: 'Agent started' });
  });

  it.each(['', 'AGY', 'Antigravity CLI', 'unknown-provider', 'constructor'])('rejects a slug without a detector profile: %j', (slug) => {
    const { det, events } = detector();
    seed(det, 'agy');
    const epoch = det.getIdentityEpoch();
    expect(det.seedTrustedIdentity(slug as AgentSlug, epoch)).toBe(false);
    expect(det.getIdentityEpoch()).toBe(epoch);
    expect(det.getTrustedAgent()).toBe('agy');
    expect(events).not.toHaveBeenCalled();
  });
});
