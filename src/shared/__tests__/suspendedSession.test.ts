import { describe, it, expect } from 'vitest';
import { recoversInBackground, suspendedReconnectAction } from '../suspendedSession';
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
    expect(suspendedReconnectAction({ exec: { command: 'npm run dev' } }, { promote: false })).toBe('promote');
    expect(suspendedReconnectAction({ supervision: { restart: 'always' } }, { promote: false })).toBe('promote');
    expect(suspendedReconnectAction({ supervision: { restart: 'always' } }, undefined)).toBe('promote');
  });
});
