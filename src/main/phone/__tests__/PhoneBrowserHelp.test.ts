import { describe, expect, it, vi } from 'vitest';
import { browserHelpRow, browserHelpRows, createBrowserHelpFeed, createTabListReader, handlePhoneBrowserHelpCommand, type BrowserHelpTabDeps } from '../PhoneBrowserHelp';
import type { PendingHelpRequest, PhoneHelpResolution } from '../../browser-session/HelpRequests';
import type { PhoneBrowserHelpRow } from '../../../shared/phoneBrowserHelp';

// Main's half of browser help on the phone: the row it publishes for each open
// request (read now, never starting a browser) and the decision command.

const pending = (over: Partial<PendingHelpRequest> = {}): PendingHelpRequest => ({
  requestId: 'req-1', workspaceId: 'ws-1', surfaceId: 'surf-1', prompt: 'Sign in, then press Done.',
  createdAt: 1_000, deadlineAt: 61_000, ...over,
});

function tabs(over: Partial<BrowserHelpTabDeps> = {}): BrowserHelpTabDeps {
  return {
    backend: () => 'builtin',
    builtinUrl: () => null,
    mayBeLiveChrome: () => false,
    chromeTabs: async () => [],
    ...over,
  };
}

describe('browserHelpRow', () => {
  it('an embedded pane this workspace owns is previewable, with the origin pinned when the request was made', async () => {
    // The pane has since moved on: the row still carries the origin the request was made at.
    const deps = tabs({ builtinUrl: (s, ws) => (s === 'surf-1' && ws === 'ws-1' ? 'https://evil.example.com/' : null) });
    expect(await browserHelpRow(pending({ origin: 'https://login.example.com:8443' }), deps)).toEqual({
      requestId: 'req-1', workspaceId: 'ws-1', surfaceId: 'surf-1', prompt: 'Sign in, then press Done.',
      createdAt: 1_000, deadlineAt: 61_000, backend: 'builtin', previewable: true, origin: 'https://login.example.com:8443',
    });
    // Unknown when the request was made: never read later, so never an origin.
    const unknown = await browserHelpRow(pending(), tabs({ builtinUrl: () => 'https://login.example.com/' }));
    expect(unknown).toMatchObject({ previewable: true });
    expect(unknown).not.toHaveProperty('origin');
    // Another workspace's pane, or none: not previewable, nothing read.
    expect(await browserHelpRow(pending({ workspaceId: 'ws-2' }), deps)).toMatchObject({ backend: 'builtin', previewable: false });
    expect(await browserHelpRow(pending({ surfaceId: undefined }), deps)).not.toHaveProperty('surfaceId');
  });

  it('a dedicated Chrome tab gets its origin, and is previewable, only when this workspace recorded it', async () => {
    const chromeTabs = vi.fn(async () => [
      { surfaceId: 'chrome-a', targetId: 't-a', workspaceId: 'ws-1', url: 'https://shop.example.com/cart' },
      { surfaceId: 'chrome-b', targetId: 't-b', url: 'https://bank.example.com/' },
    ]);
    const deps = tabs({ backend: () => 'chrome', chromeTabs });
    const shop = { surfaceId: 'chrome-a', origin: 'https://shop.example.com' };
    expect(await browserHelpRow(pending(shop), deps)).toMatchObject({ backend: 'chrome', previewable: true, origin: 'https://shop.example.com' });
    // Named by its CDP target id: the preview addresses it by surfaceId only.
    expect(await browserHelpRow(pending({ surfaceId: 't-a' }), deps)).toMatchObject({ backend: 'chrome', previewable: false });
    // A tab with no workspace on record is not this workspace's.
    const unclaimed = await browserHelpRow(pending({ surfaceId: 'chrome-b' }), deps);
    expect(unclaimed).not.toHaveProperty('origin');
    expect(unclaimed).toMatchObject({ previewable: false });
    // A tab the preview may not drive (a pane's exclusive profile): its origin, not previewable.
    chromeTabs.mockResolvedValueOnce([{ surfaceId: 'chrome-a', targetId: 't-a', workspaceId: 'ws-1', url: 'https://shop.example.com/cart', previewable: false }] as never);
    expect(await browserHelpRow(pending(shop), deps)).toMatchObject({ backend: 'chrome', previewable: false, origin: 'https://shop.example.com' });
    // A list that cannot be read: not previewable, the pinned origin unchanged.
    chromeTabs.mockRejectedValueOnce(new Error('gone'));
    expect(await browserHelpRow(pending(shop), deps)).toMatchObject({ previewable: false, origin: 'https://shop.example.com' });
  });

  it('Live Chrome is never previewable and carries no origin', async () => {
    const row = await browserHelpRow(pending({ origin: 'https://bank.example.com' }), tabs({ backend: () => 'chrome', mayBeLiveChrome: () => true }));
    expect(row).toMatchObject({ backend: 'live', previewable: false });
    expect(row).not.toHaveProperty('origin');
  });

  it('a tab missing from the workspace Chrome is asked about as possibly Live, a found one is not', async () => {
    const mayBeLiveChrome = vi.fn((_ws: string, found: boolean) => !found);
    const deps = tabs({
      backend: () => 'chrome', mayBeLiveChrome,
      chromeTabs: async () => [{ surfaceId: 'chrome-a', targetId: 't-a', workspaceId: 'ws-1', url: 'https://shop.example.com/' }],
    });
    expect(await browserHelpRow(pending({ surfaceId: 'chrome-a', origin: 'https://shop.example.com' }), deps)).toMatchObject({ backend: 'chrome', origin: 'https://shop.example.com' });
    expect(await browserHelpRow(pending({ surfaceId: 'TARGET1', origin: 'https://shop.example.com' }), deps)).toMatchObject({ backend: 'live', previewable: false });
    expect(mayBeLiveChrome.mock.calls).toEqual([['ws-1', true], ['ws-1', false]]);
  });

  it('a lookup that throws costs only its own field, never the row', async () => {
    const boom = () => { throw new Error('store unreadable'); };
    expect(await browserHelpRow(pending(), tabs({ builtinUrl: boom, backend: () => 'chrome', mayBeLiveChrome: boom })))
      .toMatchObject({ requestId: 'req-1', backend: 'live', previewable: false });
    expect(await browserHelpRow(pending(), tabs({ backend: boom, mayBeLiveChrome: () => false })))
      .toMatchObject({ requestId: 'req-1', backend: 'chrome', previewable: false });
  });

  it('drops a surface id the phone contract cannot carry', async () => {
    expect(await browserHelpRow(pending({ surfaceId: 'has space' }), tabs())).not.toHaveProperty('surfaceId');
  });
});

describe('browserHelpRows', () => {
  it('reads each workspace\'s Chrome tabs once per publication', async () => {
    const chromeTabs = vi.fn(async () => []);
    await browserHelpRows([pending(), pending({ requestId: 'req-2', surfaceId: 'surf-2' }), pending({ requestId: 'req-3', workspaceId: 'ws-2' })], tabs({ backend: () => 'chrome', chromeTabs }));
    expect(chromeTabs.mock.calls).toEqual([['ws-1'], ['ws-2']]);
  });

  it('a Chrome that never answers costs only the preview, never the table', async () => {
    const hung = () => new Promise<never>(() => undefined);
    const rows = await browserHelpRows([pending({ surfaceId: 'chrome-a', origin: 'https://shop.example.com' })], tabs({ backend: () => 'chrome', chromeTabs: hung }), createTabListReader(hung, { budgetMs: 10 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ backend: 'chrome', previewable: false, origin: 'https://shop.example.com' });
  });

  it('labels a request under the OS browser setting live', async () => {
    expect(await browserHelpRow(pending(), tabs({ backend: () => 'external' }))).toMatchObject({ backend: 'live', previewable: false });
  });

  it('drops a row the daemon would refuse and keeps the oldest 128', async () => {
    const many = Array.from({ length: 130 }, (_, i) => pending({ requestId: `req-${i}` }));
    const rows = await browserHelpRows([pending({ requestId: 'req-x', workspaceId: 'ws with space' }), ...many], tabs());
    expect(rows).toHaveLength(128);
    expect(rows[0].requestId).toBe('req-0');
    expect(rows.at(-1)?.requestId).toBe('req-127');
  });
});

describe('createTabListReader', () => {
  it('a Chrome that never answers plus repeated changes still publishes, with one fetch outstanding', async () => {
    vi.useFakeTimers();
    try {
      const fetches = vi.fn(() => new Promise<never>(() => undefined));
      const sent: unknown[] = [];
      const deps = tabs({ backend: () => 'chrome', chromeTabs: fetches });
      const feed = createBrowserHelpFeed({
        pending: () => [pending({ surfaceId: 'chrome-a', requestId: `req-${sent.length}` })],
        tabs: deps,
        push: async (rows) => { sent.push(rows); },
        tabReader: createTabListReader(fetches, { now: () => Date.now() }),
      });
      feed.publishNow();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sent).toHaveLength(1);
      // Changes keep coming: each goes out at once, with no new fetch.
      for (let i = 0; i < 5; i += 1) {
        feed.publishNow();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(sent).toHaveLength(6);
      expect(fetches).toHaveBeenCalledTimes(1);
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses a finished list briefly, then reads again', async () => {
    let at = 0;
    const read = vi.fn(async () => []);
    const reader = createTabListReader(read, { now: () => at, cacheMs: 1_000 });
    await reader('ws-1');
    at = 500;
    await reader('ws-1');
    expect(read).toHaveBeenCalledTimes(1);
    at = 1_600;
    await reader('ws-1');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('handlePhoneBrowserHelpCommand', () => {
  const store = (result: PhoneHelpResolution) => ({ resolveFromPhone: vi.fn(async () => result) });

  it('settles through resolveFromPhone in the workspace the daemon sent and maps its answer', async () => {
    const ok = store({ ok: true, state: 'cancelled' });
    expect(await handlePhoneBrowserHelpCommand('workspaces.browserHelpDecide', { requestId: 'req-1', workspaceId: 'ws-1', outcome: 'cancelled' }, () => ok))
      .toEqual({ state: 'cancelled' });
    expect(ok.resolveFromPhone).toHaveBeenCalledWith('ws-1', 'req-1', 'cancelled');
    expect(await handlePhoneBrowserHelpCommand('workspaces.browserHelpDecide', { requestId: 'req-1', workspaceId: 'ws-1', outcome: 'continued' }, () => store({ ok: false, reason: 'closed' })))
      .toEqual({ error: 'browser-help-closed' });
    expect(await handlePhoneBrowserHelpCommand('workspaces.browserHelpDecide', { requestId: 'req-1', workspaceId: 'ws-1', outcome: 'continued' }, () => store({ ok: false, reason: 'not-found' })))
      .toEqual({ error: 'browser-help-not-found' });
    // Main's store is not up yet: unavailable, not disabled.
    expect(await handlePhoneBrowserHelpCommand('workspaces.browserHelpDecide', { requestId: 'req-1', workspaceId: 'ws-1', outcome: 'continued' }, () => null))
      .toEqual({ unavailable: true });
  });

  it('refuses a malformed payload without touching the store, and ignores other commands', async () => {
    const s = store({ ok: true, state: 'continued' });
    expect(await handlePhoneBrowserHelpCommand('workspaces.browserHelpDecide', { requestId: 'req-1', workspaceId: 'ws-1', outcome: 'completed' }, () => s))
      .toEqual({ invalid: true });
    expect(await handlePhoneBrowserHelpCommand('workspaces.browserHelpDecide', { requestId: 'req-1', outcome: 'continued' }, () => s))
      .toEqual({ invalid: true });
    expect(s.resolveFromPhone).not.toHaveBeenCalled();
    expect(await handlePhoneBrowserHelpCommand('workspaces.list', {}, () => s)).toBeNull();
  });
});

describe('createBrowserHelpFeed', () => {
  it('sends only the newest table when an older one finishes its tab reads later', async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | null = null;
      let current = [pending()];
      const sent: PhoneBrowserHelpRow[][] = [];
      const feed = createBrowserHelpFeed({
        pending: () => current,
        tabs: tabs({
          builtinUrl: () => null,
          backend: () => 'chrome',
          // The first publication's tab read is slow.
          chromeTabs: () => (release === null
            ? new Promise((resolve) => { release = () => resolve([]); })
            : Promise.resolve([])),
        }),
        push: async (rows) => { sent.push(rows); },
      });
      feed.publishNow();
      current = [];
      feed.publishNow();
      await vi.advanceTimersByTimeAsync(0);
      (release as unknown as () => void)();
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual([[]]);
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
