import { describe, expect, it } from 'vitest';
import { BrowserHelpTable } from '../BrowserHelpTable';
import type { PhoneBrowserHelpFrame, PhoneBrowserHelpRow } from '../../../shared/phoneBrowserHelp';

// The daemon's copy of main's open browser help requests: who may write it,
// the open / close frames a change produces, and what a disconnect does.

const row = (over: Partial<PhoneBrowserHelpRow> = {}): PhoneBrowserHelpRow => ({
  requestId: 'req-1', workspaceId: 'ws-1', surfaceId: 'surf-1', prompt: 'Sign in, then press Done.',
  createdAt: 1_000, deadlineAt: 61_000, backend: 'builtin', previewable: true, origin: 'https://login.example.com', ...over,
});

function table(owner: string | null = 'main', firstParty = (id: string) => id === 'main' || id === 'other-main') {
  const frames: PhoneBrowserHelpFrame[] = [];
  const t = new BrowserHelpTable({ firstParty, isOwner: (id) => owner !== null && id === owner, emit: (f) => frames.push(...f) });
  return { t, frames };
}

describe('BrowserHelpTable', () => {
  it('takes the table only from the registered desktop', () => {
    const { t, frames } = table('main');
    // First-party but not the bridge owner, and an outside client.
    expect(t.set('other-main', { requests: [row()] })).toMatchObject({ ok: false });
    expect(t.set('mcp-1', { requests: [row()] })).toMatchObject({ ok: false });
    expect(t.published).toBe(false);
    expect(t.list()).toEqual([]);
    expect(frames).toEqual([]);
    // With no desktop registered at all, nobody may write it.
    expect(table(null).t.set('main', { requests: [row()] })).toMatchObject({ ok: false });
    expect(t.set('main', { requests: [row()] })).toEqual({ ok: true, accepted: 1 });
    expect(t.list()).toEqual([row()]);
  });

  it('refuses a malformed table whole and keeps the last good one', () => {
    const { t } = table();
    t.set('main', { requests: [row()] });
    expect(t.set('main', { requests: [row(), row({ requestId: 'req-2', backend: 'firefox' as never })] })).toMatchObject({ ok: false });
    expect(t.set('main', { requests: 'nope' })).toMatchObject({ ok: false });
    expect(t.list()).toEqual([row()]);
  });

  it('never marks a Live Chrome row previewable and drops unlisted keys', () => {
    const { t } = table();
    t.set('main', { requests: [{ ...row({ backend: 'live', previewable: true }), cdpUrl: 'ws://127.0.0.1:9222' }] });
    expect(t.list()).toEqual([row({ backend: 'live', previewable: false })]);
  });

  it('turns each change into open and close frames that carry no prompt', () => {
    const { t, frames } = table();
    t.set('main', { requests: [row()] });
    t.set('main', { requests: [row(), row({ requestId: 'req-2', surfaceId: undefined })] });
    t.set('main', { requests: [row({ requestId: 'req-2', surfaceId: undefined })], closed: [{ requestId: 'req-1', state: 'continued' }, { requestId: 'req-0', state: 'bogus' }] });
    expect(frames).toEqual([
      { phase: 'open', requestId: 'req-1', workspaceId: 'ws-1', surfaceId: 'surf-1', deadlineAt: 61_000 },
      { phase: 'open', requestId: 'req-2', workspaceId: 'ws-1', deadlineAt: 61_000 },
      { phase: 'close', requestId: 'req-1', workspaceId: 'ws-1', surfaceId: 'surf-1', deadlineAt: 61_000, state: 'continued' },
    ]);
    expect(JSON.stringify(frames)).not.toContain('Sign in');
    expect(t.lookup('req-1')).toEqual({ closed: true });
    expect(t.lookup('req-2')).toEqual({ row: row({ requestId: 'req-2', surfaceId: undefined }) });
    expect(t.lookup('req-9')).toBeNull();
  });

  it('closes and drops every row when its publisher disconnects, and only then', () => {
    const { t, frames } = table();
    t.set('main', { requests: [row()] });
    t.onClientClose('mcp-1');
    expect(t.list()).toHaveLength(1);
    t.onClientClose('main');
    expect(t.published).toBe(false);
    expect(t.list()).toEqual([]);
    expect(frames.at(-1)).toEqual({ phase: 'close', requestId: 'req-1', workspaceId: 'ws-1', surfaceId: 'surf-1', deadlineAt: 61_000 });
    // Republished after the desktop reconnects: open again, no longer closed.
    t.set('main', { requests: [row()] });
    expect(t.lookup('req-1')).toEqual({ row: row() });
  });
});
