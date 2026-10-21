import { describe, it, expect } from 'vitest';
import { heldReconnectAnswer, promoteOutcome, promoteStartedSession, recoversInBackground, suspendedReconnectAction } from '../suspendedSession';
import { recoversInBackground as daemonRecoversInBackground } from '../../daemon/recoverySelector';

// #2398 — one predicate decides which suspended sessions start on their own:
// the daemon's boot promote and main's pty:reconnect must agree on it.
describe('suspended session reconnect action', () => {
  it('the daemon promotes in the background with the same predicate', () => {
    expect(daemonRecoversInBackground).toBe(recoversInBackground);
  });

  it('holds a plain shell unless the caller explicitly asks to promote', () => {
    expect(suspendedReconnectAction({}, { promote: false })).toBe('hold');
    expect(suspendedReconnectAction({}, undefined)).toBe('hold');
    expect(suspendedReconnectAction({}, {})).toBe('hold');
    expect(suspendedReconnectAction({}, { promote: true })).toBe('promote');
  });

  // Review item 2 — the daemon starts an exec unit or a supervised session at
  // boot whatever its pane does; holding it left that pane deferred on a
  // session that was running. The reconnect joins the start instead.
  it('promotes an exec unit or a supervised session even from a hidden pane', () => {
    // 'join': promoted to join the daemon's own start, which this call did
    // not cause (round 7: a stop key to such a unit is delivered).
    expect(suspendedReconnectAction({ exec: { command: 'npm run dev' } }, { promote: false })).toBe('join');
    expect(suspendedReconnectAction({ supervision: { restart: 'always' } }, { promote: false })).toBe('join');
    expect(suspendedReconnectAction({ supervision: { restart: 'always' } }, undefined)).toBe('join');
    // A caller that asks starts it itself, unit or not.
    expect(suspendedReconnectAction({ exec: { command: 'npm run dev' } }, { promote: true })).toBe('promote');
  });

  // Second-model P2-1: a stop key never starts a unit, it only joins a start
  // in flight; a plain shell is held as before.
  it("a join-only caller joins a unit's start without starting one", () => {
    expect(suspendedReconnectAction({ exec: { command: 'npm run dev' } }, { promote: false, joinOnly: true })).toBe('join-only');
    expect(suspendedReconnectAction({ supervision: { restart: 'always' } }, { promote: false, joinOnly: true })).toBe('join-only');
    expect(suspendedReconnectAction({}, { promote: false, joinOnly: true })).toBe('hold');
  });
});

// #2398 round 7 — whether a reconnect's promote started the session is read
// from the daemon's answer, never from the action label: a 'join' whose
// background start failed or never covered the unit spawns it here.
describe('promoteStartedSession', () => {
  it('a fresh spawn started it; a join, an already running session or a failure did not', () => {
    expect(promoteStartedSession({ ok: true, alreadyActive: false })).toBe(true);
    expect(promoteStartedSession({ ok: true, alreadyActive: false, joined: true })).toBe(false);
    expect(promoteStartedSession({ ok: true, alreadyActive: true })).toBe(false);
    expect(promoteStartedSession({ ok: false })).toBe(false);
  });

  it('an older daemon that cannot say counts as started (a stop key is refused)', () => {
    expect(promoteStartedSession({ ok: true })).toBe(true);
  });
});

// Mac review P3-2: main's mapping of the daemon's promote answer was pinned
// by source scans only.
describe('pty:reconnect on the promote answer', () => {
  it('a join-only call with nothing in flight is held, never a failed recovery', () => {
    expect(promoteOutcome({ ok: false, notInFlight: true })).toBe('held');
    expect(promoteOutcome({ ok: false })).toBe('failed');
    expect(promoteOutcome({ ok: true, alreadyActive: true } as { ok: boolean })).toBe('attach');
    expect(promoteOutcome({ ok: true })).toBe('attach');
  });

  it('the held answer is deferred, with the resume hint and binding only when the session has them', () => {
    const binding = { agent: 'claude', sessionId: 'x', cwd: '/p' };
    expect(heldReconnectAnswer({})).toEqual({ success: false, deferred: true });
    expect(heldReconnectAnswer({ resumeAgent: 'claude', resumeBinding: binding }))
      .toEqual({ success: false, deferred: true, resumeAgent: 'claude', resumeBinding: binding });
  });
});
