import { describe, expect, it } from 'vitest';
import { canSeedHookIdentity, DETECTOR_IDENTITY_HOOK_MAX_AGE_MS, isHookIdentityCandidate } from '../detectorIdentity';
import type { AgentSignal, AgentSignalKind } from '../signal-types';

const now = 1_000_000;
const signal = (patch: Partial<AgentSignal> = {}): AgentSignal => ({
  agent: 'opencode', kind: 'agent.activity', ptyId: 'pane', cwd: '/project',
  ts: now - 1, payload: {}, ...patch,
});
const context = { ptyId: 'pane', now, boundaryAt: now - 100 };

describe('hook evidence for bannerless detector identity', () => {
  it.each<AgentSignalKind>([
    'agent.session_start', 'agent.user_prompt_submit', 'agent.activity',
    'agent.tool_started', 'agent.awaiting_input', 'agent.awaiting_permission',
  ])('accepts a fresh exact lead %s after the launch boundary', (kind) => {
    expect(canSeedHookIdentity(signal({ kind }), context)).toBe(true);
  });

  it.each<AgentSignalKind>([
    'agent.stop', 'agent.stop_failure', 'agent.subagent_stop',
    'agent.input_answered', 'agent.permission_answered',
  ])('cannot reclaim identity from a delayed %s', (kind) => {
    expect(isHookIdentityCandidate(signal({ kind }))).toBe(false);
  });

  it.each([{ agent_id: 'child', agent_type: 'worker' }, { agent_id: 'suggestion' }])(
    'does not let a child or internal fork claim its parent pane (%j)', (payload) => {
      expect(canSeedHookIdentity(signal({ payload }), context)).toBe(false);
    },
  );

  it.each([undefined, 'neighbor'])('requires exact pane routing (%j)', (ptyId) => {
    expect(canSeedHookIdentity(signal({ ptyId }), context)).toBe(false);
  });

  it.each([now - 101, now - 100, now + 1, NaN, Infinity, 0])(
    'rejects pre-boundary, ambiguous or invalid payload time %s', (ts) => {
      expect(canSeedHookIdentity(signal({ ts }), context)).toBe(false);
    },
  );

  it('ages the original payload even when there has been no shell boundary', () => {
    const firstLaunch = { ...context, boundaryAt: -Infinity };
    expect(canSeedHookIdentity(signal({ ts: now - DETECTOR_IDENTITY_HOOK_MAX_AGE_MS }), firstLaunch)).toBe(true);
    expect(canSeedHookIdentity(signal({ ts: now - DETECTOR_IDENTITY_HOOK_MAX_AGE_MS - 1 }), firstLaunch)).toBe(false);
  });
});
