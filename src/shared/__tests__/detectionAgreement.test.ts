import { describe, expect, it } from 'vitest';
import {
  analyzeDetectionRecords,
  detectionErrorRate,
  detectorReadClass,
  hookTruthFor,
  parseDetectionLog,
  type AgentDetectionStats,
  type DetectionRecord,
  type HookTruth,
} from '../detectionAgreement';

const S = 'pty-1';

function hook(t: number, h: HookTruth, k = 'agent.activity', extra: Partial<{ pv: true; a: string; s: string }> = {}): DetectionRecord {
  return { v: 1, t, s: extra.s ?? S, a: extra.a ?? 'claude', src: 'hook', h, k, ...(extra.pv ? { pv: true } : {}) };
}

function det(t: number, st: string, extra: Partial<{ d: string; r: string; a: string }> = {}): DetectionRecord {
  return {
    v: 1, t, s: S, a: extra.a ?? 'claude', src: 'det', st,
    ...(extra.d !== undefined ? { d: extra.d } : {}),
    ...(extra.r !== undefined ? { r: extra.r } : {}),
  };
}

/** A record on another pane, so the windows before it can settle. */
function later(t: number): DetectionRecord {
  return hook(t, 'busy', 'agent.user_prompt_submit', { s: 'pty-other' });
}

function claude(records: DetectionRecord[], graceMs = 5_000): AgentDetectionStats {
  const stats = analyzeDetectionRecords(records, { graceMs }).agents['claude'];
  if (!stats) throw new Error('no claude stats');
  return stats;
}

/** Every counted read and edge ends in exactly one bucket. */
function expectBalanced(st: AgentDetectionStats): void {
  expect(st.agree + st.early + st.falseIdle + st.falseBusy + st.falseAwaiting + st.unconfirmedAwaiting).toBe(st.reads);
  expect(st.hitIdle + st.hitAwaiting + st.missedIdle + st.missedAwaiting).toBe(st.hookEdges);
}

describe('hookTruthFor', () => {
  it('reads a fresh session as idle, not working', () => {
    expect(hookTruthFor('agent.session_start', 'running')).toBe('idle');
  });

  it('keeps a stop with background work busy and a real stop idle', () => {
    expect(hookTruthFor('agent.stop', 'running')).toBe('busy');
    expect(hookTruthFor('agent.stop', 'complete')).toBe('idle');
    expect(hookTruthFor('agent.stop_failure', 'error')).toBe('idle');
  });

  it('leaves the state alone for a subagent stop', () => {
    expect(hookTruthFor('agent.subagent_stop', 'complete')).toBeNull();
  });

  it('keeps wmux\'s own tool gate busy, since the agent draws no dialog for it', () => {
    expect(hookTruthFor('agent.awaiting_permission', 'running')).toBe('busy');
    expect(hookTruthFor('agent.awaiting_input', 'awaiting_input')).toBe('awaiting');
  });
});

describe('detectorReadClass', () => {
  it('maps detector statuses onto pane states', () => {
    expect(detectorReadClass('waiting')).toBe('idle');
    expect(detectorReadClass('complete')).toBe('idle');
    expect(detectorReadClass('awaiting_input')).toBe('awaiting');
    expect(detectorReadClass('running')).toBe('busy');
    expect(detectorReadClass('something-new')).toBeNull();
  });
});

describe('analyzeDetectionRecords', () => {
  it('counts a read that matches the hook as agreement', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      hook(10_000, 'idle', 'agent.stop'),
      det(11_000, 'waiting'),
    ]);
    expect(st.reads).toBe(1);
    expect(st.agree).toBe(1);
    expect(st.hitIdle).toBe(1);
    expect(st.missedIdle).toBe(0);
    expectBalanced(st);
  });

  it('counts a read the hook confirms within the grace window as early, not false', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      det(9_000, 'waiting'),
      hook(10_000, 'idle', 'agent.stop'),
    ]);
    expect(st.early).toBe(1);
    expect(st.falseIdle).toBe(0);
    expect(st.hitIdle).toBe(1);
    expect(st.offsetMs.led).toBe(1);
    expectBalanced(st);
  });

  it('flags a mid-turn "ready" read the hook never confirms as false idle, and leaked when not vetoed', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      det(2_000, 'waiting', { d: 'veto', r: 'Ready for input' }),
      det(3_000, 'complete', { d: 'emit', r: 'Applied edit' }),
      hook(60_000, 'idle', 'agent.stop'),
    ]);
    expect(st.falseIdle).toBe(2);
    expect(st.leaked).toBe(1);
    expect(st.falseByRule).toEqual({ 'Ready for input': 1, 'Applied edit': 1 });
    expectBalanced(st);
  });

  it('counts a hook stop the detector never reflects as a missed idle', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      hook(10_000, 'idle', 'agent.stop'),
      det(30_000, 'running'),
    ]);
    expect(st.missedIdle).toBe(1);
    expect(st.hitIdle).toBe(0);
    expectBalanced(st);
  });

  it('counts a hook dialog with no detector dialog read as a missed awaiting', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      hook(5_000, 'awaiting', 'agent.awaiting_input'),
      later(30_000),
    ]);
    expect(st.missedAwaiting).toBe(1);
    expectBalanced(st);
  });

  it('does not count a dialog the hook never reported while busy as an error', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      det(4_000, 'awaiting_input', { r: 'Do you want to proceed?' }),
      later(30_000),
    ]);
    expect(st.unconfirmedAwaiting).toBe(1);
    expect(st.falseAwaiting).toBe(0);
    expect(detectionErrorRate(st)).toBe(0);
    expectBalanced(st);
  });

  it('flags a dialog read on an idle pane as false awaiting', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      hook(1_000, 'idle', 'agent.stop'),
      det(1_500, 'waiting'),
      det(20_000, 'awaiting_input'),
      later(30_000),
    ]);
    expect(st.falseAwaiting).toBe(1);
    expectBalanced(st);
  });

  it('does not let a read the previous turn made stand for this turn\'s stop', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      hook(10_000, 'idle', 'agent.stop'),
      det(11_000, 'waiting'),
      hook(20_000, 'busy', 'agent.user_prompt_submit'),
      hook(40_000, 'idle', 'agent.stop'),
      later(60_000),
    ]);
    expect(st.hitIdle).toBe(1);
    expect(st.missedIdle).toBe(1);
    expectBalanced(st);
  });

  it('judges a read made after the hook moved on against the new state, not the old edge', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      hook(10_000, 'idle', 'agent.stop'),
      hook(11_000, 'busy', 'agent.user_prompt_submit'),
      det(12_000, 'waiting'),
      later(60_000),
    ]);
    expect(st.hookEdges).toBe(0);
    expect(st.falseIdle).toBe(1);
    expectBalanced(st);
  });

  it('counts a false read held for confirmation as held, not leaked', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      det(2_000, 'complete', { d: 'pending' }),
      later(60_000),
    ]);
    expect(st.falseIdle).toBe(1);
    expect(st.held).toBe(1);
    expect(st.leaked).toBe(0);
  });

  it('leaves a window still open at the end of the log unjudged', () => {
    const st = claude([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      det(2_000, 'waiting'),
      hook(30_000, 'idle', 'agent.stop'),
    ]);
    expect(st.falseIdle).toBe(1);
    expect(st.hookEdges).toBe(0);
    expect(st.missedIdle).toBe(0);
    expectBalanced(st);
  });

  it('drops windows a daemon restart cut off and forgets the old truth', () => {
    const report = analyzeDetectionRecords([
      hook(0, 'busy', 'agent.user_prompt_submit'),
      hook(10_000, 'idle', 'agent.stop'),
      { v: 1, type: 'start', t: 11_000, app: '4.2.0', os: 'darwin' },
      det(60_000, 'running'),
    ]);
    const st = report.agents['claude'];
    expect(st?.missedIdle).toBe(0);
    expect(st?.hookEdges).toBe(0);
    expect(st?.noTruth).toBe(1);
  });

  it('ignores an unconfirmed Codex stop as truth', () => {
    const report = analyzeDetectionRecords([
      hook(0, 'busy', 'agent.user_prompt_submit', { a: 'codex' }),
      hook(5_000, 'idle', 'agent.stop', { a: 'codex', pv: true }),
      det(6_000, 'running', { a: 'codex' }),
    ]);
    const st = report.agents['codex'];
    expect(st?.provisionalStops).toBe(1);
    expect(st?.hookEdges).toBe(0);
    expect(st?.agree).toBe(1);
  });

  it('judges the same records differently under a different grace window', () => {
    const records = [
      hook(0, 'busy', 'agent.user_prompt_submit'),
      det(4_000, 'waiting'),
      hook(10_000, 'idle', 'agent.stop'),
    ];
    expect(claude(records, 5_000).falseIdle).toBe(1);
    expect(claude(records, 7_000).early).toBe(1);
  });

  it('counts reads made before any hook truth separately', () => {
    const st = claude([det(0, 'waiting'), hook(1_000, 'busy', 'agent.user_prompt_submit')]);
    expect(st.noTruth).toBe(1);
    expect(st.reads).toBe(0);
  });

  it('counts records before `since` for state only', () => {
    const report = analyzeDetectionRecords(
      [hook(0, 'busy', 'agent.user_prompt_submit'), hook(10_000, 'idle', 'agent.stop'), det(20_000, 'waiting')],
      { since: 15_000 },
    );
    const st = report.agents['claude'];
    expect(st?.hookEdges).toBe(0);
    expect(st?.reads).toBe(1);
    expect(st?.agree).toBe(1);
    expect(report.from).toBe(20_000);
  });

  it('counts never-measured sessions once per reason', () => {
    const skip = (s: string, why: 'no-turn-start' | 'inexact-routing'): DetectionRecord =>
      ({ v: 1, t: 0, s, a: 'claude', src: 'skip', why });
    const report = analyzeDetectionRecords([
      skip('a', 'no-turn-start'),
      skip('a', 'no-turn-start'),
      skip('b', 'inexact-routing'),
      // Skipped until its first prompt, measured after: not excluded.
      skip('c', 'no-turn-start'),
      hook(1_000, 'busy', 'agent.user_prompt_submit', { s: 'c' }),
    ]);
    expect(report.skipped).toEqual({ brain: 0, 'inexact-routing': 1, 'no-turn-start': 1 });
  });
});

describe('parseDetectionLog', () => {
  it('keeps valid v1 records and drops everything else', () => {
    const text = [
      JSON.stringify({ v: 1, type: 'start', t: 1, app: '4.2.0', os: 'darwin' }),
      JSON.stringify({ v: 1, t: 2, s: S, a: 'claude', src: 'hook', h: 'busy', k: 'agent.user_prompt_submit' }),
      '{not json',
      JSON.stringify({ v: 2, t: 3, s: S, a: 'claude', src: 'det', st: 'waiting' }),
      JSON.stringify({ v: 1, t: 4, s: S, a: 'claude', src: 'hook', h: 'sleeping', k: 'x' }),
      '',
    ].join('\n');
    const records = parseDetectionLog(text);
    expect(records).toHaveLength(2);
    expect(analyzeDetectionRecords(records).apps).toEqual(['4.2.0']);
  });
});
