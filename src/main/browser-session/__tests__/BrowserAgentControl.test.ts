import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentControl } from '../BrowserAgentControl';
import {
  AGENT_PAUSED_CODE,
  USER_IN_CONTROL_CODE,
  agentControlRefusal,
  type BrowserAgentControlState,
} from '../../../shared/browserAgentControl';

function setup(lingerMs = 1_000) {
  const emitted: BrowserAgentControlState[] = [];
  const cancelled: Array<{ surfaceId: string; error: Error }> = [];
  const control = new BrowserAgentControl({
    emit: (state) => emitted.push(state),
    cancelInFlight: (surfaceId, error) => cancelled.push({ surfaceId, error }),
    lingerMs,
  });
  return { control, emitted, cancelled };
}

describe('BrowserAgentControl state machine', () => {
  it('Stop pauses, Resume clears it', () => {
    const { control, emitted } = setup();
    expect(control.apply('s1', 'stop')).toEqual({ changed: true, state: { surfaceId: 's1', active: false, mode: 'paused' } });
    expect(control.apply('s1', 'resume').state.mode).toBe('agent');
    expect(emitted.map((s) => s.mode)).toEqual(['paused', 'agent']);
  });

  it('Take over hands the tab to the user from agent or paused; Hand back returns it', () => {
    const { control } = setup();
    expect(control.apply('s1', 'takeOver').state.mode).toBe('user');
    expect(control.apply('s1', 'handBack').state.mode).toBe('agent');
    control.apply('s1', 'stop');
    expect(control.apply('s1', 'takeOver').state.mode).toBe('user');
  });

  it('ignores intents that do not apply to the current mode', () => {
    const { control, emitted } = setup();
    expect(control.apply('s1', 'resume').changed).toBe(false);
    expect(control.apply('s1', 'handBack').changed).toBe(false);
    control.apply('s1', 'takeOver');
    // Paused and taken over are two reasons, not a stack: Stop does not demote
    // a take-over, and Resume cannot lift one.
    expect(control.apply('s1', 'stop').changed).toBe(false);
    expect(control.apply('s1', 'resume').changed).toBe(false);
    expect(control.get('s1').mode).toBe('user');
    expect(emitted).toHaveLength(1);
  });

  it('keeps each surface separate', () => {
    const { control } = setup();
    control.apply('s1', 'stop');
    expect(control.get('s2').mode).toBe('agent');
    expect(control.refusal('s2', 'browser.lease.acquire')).toBeNull();
  });
});

describe('BrowserAgentControl refusals', () => {
  it('refuses agent calls with a stable code while paused or taken over, and not otherwise', () => {
    const { control } = setup();
    expect(control.refusal('s1', 'browser.lease.acquire')).toBeNull();
    expect(control.refusal(undefined, 'browser.lease.acquire')).toBeNull();

    control.apply('s1', 'stop');
    const paused = control.refusal('s1', 'browser.lease.acquire');
    expect(paused?.message).toMatch(/^browser\.lease\.acquire: BROWSER_AGENT_PAUSED: the user paused agent control of this tab/);
    expect(agentControlRefusal(paused)?.code).toBe(AGENT_PAUSED_CODE);

    control.apply('s1', 'takeOver');
    const taken = control.refusal('s1', 'browser.click.cdp');
    expect(taken?.message).toMatch(/^browser\.click\.cdp: BROWSER_USER_IN_CONTROL: the user took over this tab/);
    expect(agentControlRefusal(taken)?.code).toBe(USER_IN_CONTROL_CODE);

    control.apply('s1', 'handBack');
    expect(control.refusal('s1', 'browser.lease.acquire')).toBeNull();
  });

  it('Stop and Take over cancel the action in flight; Resume and Hand back do not', () => {
    const { control, cancelled } = setup();
    control.apply('s1', 'stop');
    control.apply('s1', 'resume');
    control.apply('s1', 'takeOver');
    control.apply('s1', 'handBack');
    expect(cancelled.map((c) => [c.surfaceId, agentControlRefusal(c.error)?.code])).toEqual([
      ['s1', AGENT_PAUSED_CODE],
      ['s1', USER_IN_CONTROL_CODE],
    ]);
  });

  it('does not recognise the code anywhere but the message prefix', () => {
    expect(agentControlRefusal(new Error('navigation to "BROWSER_AGENT_PAUSED: x" failed'))).toBeNull();
    expect(agentControlRefusal(new Error('BROWSER_AGENT_PAUSED: stopped'))?.code).toBe(AGENT_PAUSED_CODE);
  });
});

describe('BrowserAgentControl activity marker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('turns on with the first lease and off a linger after the last one ends', () => {
    const { control, emitted } = setup(1_000);
    control.noteLeases('s1', 1);
    expect(control.get('s1').active).toBe(true);
    control.noteLeases('s1', 2);
    control.noteLeases('s1', 1);
    control.noteLeases('s1', 0);
    // Still lit inside the linger: back-to-back steps do not flicker.
    vi.advanceTimersByTime(999);
    expect(control.get('s1').active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(control.get('s1').active).toBe(false);
    expect(emitted.map((s) => s.active)).toEqual([true, false]);
  });

  it('a new action inside the linger keeps the marker on without a second push', () => {
    const { control, emitted } = setup(1_000);
    control.noteLeases('s1', 1);
    control.noteLeases('s1', 0);
    vi.advanceTimersByTime(500);
    control.noteLeases('s1', 1);
    vi.advanceTimersByTime(5_000);
    expect(control.get('s1').active).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it('lists only surfaces that are active or held by the user', () => {
    const { control } = setup(1_000);
    control.noteLeases('s1', 1);
    control.apply('s2', 'stop');
    expect(control.list()).toEqual([
      { surfaceId: 's1', active: true, mode: 'agent' },
      { surfaceId: 's2', active: false, mode: 'paused' },
    ]);
  });
});
