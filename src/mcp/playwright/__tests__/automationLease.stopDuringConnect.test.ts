import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real engine under a real lease: Stop lands while the op's FIRST
// connectOverCDP is still in flight. The Stop's disconnect runs before there is
// a browser to drop, so the attach that resolves afterwards must not be kept
// and driven.

const { mockSendRpc, mockConnectOverCDP } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  mockConnectOverCDP: vi.fn(),
}));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));
vi.mock('../lazyPlaywright', () => ({
  loadPlaywright: () => ({ chromium: { connectOverCDP: (...a: unknown[]) => mockConnectOverCDP(...a) }, devices: {} }),
}));

import { withAutomationLease } from '../automationLease';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';
import { AGENT_PAUSED_CODE } from '../../../shared/browserAgentControl';
import { deliberateSleep } from '../../../test-utils/waitFor';

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

/** A connected browser holding one guest page (target t1) that records clicks. */
function fakeBrowser(targetsDelayMs = 0) {
  const click = vi.fn(async () => undefined);
  const session = {
    send: vi.fn(async (method: string) => {
      if (method === 'Target.getTargets') {
        if (targetsDelayMs) await deliberateSleep(targetsDelayMs, 'stub latency: slow target discovery, driven by fake timers');
        return { targetInfos: [{ targetId: 't1', type: 'page', url: 'https://guest.test/', title: '', attached: true }] };
      }
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 't1' } };
      return {};
    }),
    detach: vi.fn(async () => undefined),
  };
  const page = { url: () => 'https://guest.test/', click, context: () => context, on: vi.fn(), off: vi.fn(), once: vi.fn() };
  const context = { pages: () => [page], newCDPSession: vi.fn(async () => session) };
  const browser = {
    isConnected: () => true,
    contexts: () => [context],
    newBrowserCDPSession: vi.fn(async () => session),
    close: vi.fn(async () => undefined),
  };
  return { browser, click };
}

beforeEach(async () => {
  vi.useFakeTimers();
  mockSendRpc.mockReset();
  mockConnectOverCDP.mockReset();
  __resetSurfaceRoutingForTesting();
  await PlaywrightEngine.getInstance().disconnect();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Stop while the first CDP attach is in flight', () => {
  it('ends the op with the refusal, drops the late connection and never clicks', async () => {
    const renews: Array<(e: Error) => void> = [];
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
      if (method === 'browser.lease.renew') return new Promise((_r, reject) => renews.push(reject));
      if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
      if (method === 'browser.cdp.info') {
        return Promise.resolve({
          cdpPort: 18800,
          targetsScoped: true,
          targets: [{ surfaceId: 'surface-1', targetId: 't1', workspaceId: 'ws-test' }],
        });
      }
      return Promise.resolve({});
    });
    const { browser, click } = fakeBrowser();
    let attach!: () => void;
    mockConnectOverCDP.mockImplementation(() => new Promise((resolve) => { attach = () => resolve(browser); }));

    const op = withAutomationLease(deps, 'surface-1', async (scope) => {
      const page = await PlaywrightEngine.getInstance().getPageForScope(scope);
      await (page as unknown as { click: (s: string) => Promise<void> } | null)?.click('#buy');
      return 'clicked';
    });
    const settled = op.then(() => 'resolved', (err: Error) => err);

    await vi.advanceTimersByTimeAsync(600);
    expect(mockConnectOverCDP).toHaveBeenCalledTimes(1);
    expect(renews).toHaveLength(1);

    // Stop lands mid-attach; only then does the attach complete.
    renews[0](new Error('browser.lease.renew: BROWSER_AGENT_PAUSED: the user stopped this action and paused agent control of this tab.'));
    const err = await settled;
    expect((err as Error & { code?: string }).code).toBe(AGENT_PAUSED_CODE);
    attach();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(click).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
    expect(mockConnectOverCDP).toHaveBeenCalledTimes(1);
  });

  it('a page found after the Stop is not handed to the stopped op', async () => {
    const renews: Array<(e: Error) => void> = [];
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
      if (method === 'browser.lease.renew') return new Promise((_r, reject) => renews.push(reject));
      if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
      if (method === 'browser.cdp.info') {
        return Promise.resolve({
          cdpPort: 18800,
          targetsScoped: true,
          targets: [{ surfaceId: 'surface-1', targetId: 't1', workspaceId: 'ws-test' }],
        });
      }
      return Promise.resolve({});
    });
    // Discovery is slow, so the Stop lands while it is matching the page.
    const { browser, click } = fakeBrowser(700);
    mockConnectOverCDP.mockResolvedValue(browser);

    let clickedInBody = false;
    const op = withAutomationLease(deps, 'surface-1', async (scope) => {
      const page = await PlaywrightEngine.getInstance().getPageForScope(scope);
      if (page) {
        clickedInBody = true;
        await (page as unknown as { click: (s: string) => Promise<void> }).click('#buy');
      }
      return 'clicked';
    });
    const settled = op.then(() => 'resolved', (err: Error) => err);

    await vi.advanceTimersByTimeAsync(600);
    expect(renews).toHaveLength(1);
    renews[0](new Error('browser.lease.renew: BROWSER_AGENT_PAUSED: the user stopped this action and paused agent control of this tab.'));
    const err = await settled;
    expect((err as Error & { code?: string }).code).toBe(AGENT_PAUSED_CODE);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(clickedInBody).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });

  it('an op that joined another\'s page discovery and was stopped does not get the page', async () => {
    const renewsByToken = new Map<string, (e: Error) => void>();
    let acquires = 0;
    mockSendRpc.mockImplementation((method: string, params: { token?: string }) => {
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: `lease-${++acquires}` });
      if (method === 'browser.lease.renew') {
        return new Promise((_r, reject) => renewsByToken.set(params.token ?? '', reject));
      }
      if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
      if (method === 'browser.cdp.info') {
        return Promise.resolve({
          cdpPort: 18800,
          targetsScoped: true,
          targets: [{ surfaceId: 'surface-1', targetId: 't1', workspaceId: 'ws-test' }],
        });
      }
      return Promise.resolve({});
    });
    // Slow discovery, so B joins A's while it is still running.
    const { browser, click } = fakeBrowser(700);
    mockConnectOverCDP.mockResolvedValue(browser);
    // Stop drops the connection, which would also end A's discovery. Kept
    // alive here so A resolves its page: what is under test is that B, which
    // joined A's discovery and was stopped meanwhile, is not handed that page.
    const engine = PlaywrightEngine.getInstance();
    const disconnect = vi.spyOn(engine, 'disconnect').mockResolvedValue(undefined);

    const body = (who: string) => async (scope: Parameters<typeof engine.getPageForScope>[0]) => {
      const page = await engine.getPageForScope(scope);
      await (page as unknown as { click: (s: string) => Promise<void> } | null)?.click(`#${who}`);
      return who;
    };
    const opA = withAutomationLease(deps, 'surface-1', body('a'));
    await vi.advanceTimersByTimeAsync(100);
    const opB = withAutomationLease(deps, 'surface-1', body('b'));
    const settledB = opB.then(() => 'resolved', (err: Error) => err);

    await vi.advanceTimersByTimeAsync(550); // B's watch is parked by now
    expect(renewsByToken.has('lease-2')).toBe(true);
    renewsByToken.get('lease-2')!(new Error('browser.lease.renew: BROWSER_AGENT_PAUSED: the user stopped this action and paused agent control of this tab.'));
    const errB = await settledB;
    expect((errB as Error & { code?: string }).code).toBe(AGENT_PAUSED_CODE);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(opA).resolves.toBe('a');
    expect(click.mock.calls).toEqual([['#a']]);
    disconnect.mockRestore();
  });
});

