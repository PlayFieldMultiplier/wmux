import { describe, it, expect } from 'vitest';
import { suspendedListEntry } from '../suspendedListEntry';
import { recoversInBackground } from '../../shared/suspendedSession';
import type { DaemonSession } from '../types';

const record = (extra: Partial<DaemonSession>): DaemonSession => ({
  id: 's1',
  cmd: 'wsl.exe',
  state: 'suspended',
  cwd: '/home/me/app',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastActivity: '2026-10-01T00:00:00.000Z',
  ...extra,
} as DaemonSession);

// Second-model P2-2 (#2398): a graceful shutdown suspends exec units and
// supervised sessions like any other, and the recovery cap leaves the
// long-silent ones only in sessions.json. Their list entry carried neither
// field, so main's pty:reconnect and the reconcile held them as plain shells
// and a `restart: always` service in a workspace nobody opened stayed down.
describe('suspendedListEntry', () => {
  it('carries an exec unit’s exec, so it is one that starts on its own', () => {
    const entry = suspendedListEntry(record({ exec: { command: 'npm run dev' } }), false);
    expect(entry.exec).toEqual({ command: 'npm run dev' });
    expect(recoversInBackground(entry)).toBe(true);
  });

  it('carries a supervised session’s supervision', () => {
    const supervision = { restart: 'always', status: 'armed' } as unknown as DaemonSession['supervision'];
    const entry = suspendedListEntry(record({ supervision }), false);
    expect(entry.supervision).toEqual(supervision);
    expect(recoversInBackground(entry)).toBe(true);
  });

  it('a plain shell carries neither and is held', () => {
    const entry = suspendedListEntry(record({}), false);
    expect('exec' in entry).toBe(false);
    expect('supervision' in entry).toBe(false);
    expect(recoversInBackground(entry)).toBe(false);
  });

  it('carries the resume binding only when the caller’s guard passed', () => {
    const resumeBinding = { agent: 'claude', sessionId: 'x', cwd: '/home/me/app' } as unknown as DaemonSession['resumeBinding'];
    expect(suspendedListEntry(record({ resumeBinding }), true).resumeBinding).toEqual(resumeBinding);
    expect('resumeBinding' in suspendedListEntry(record({ resumeBinding }), false)).toBe(false);
  });
});
