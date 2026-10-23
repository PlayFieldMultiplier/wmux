import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real engine under a real lease: Stop lands while page discovery is in
// its retry loop. Before the op signal, the loop slept, reconnected through
// browser.cdp.info and went on to drive the tab the user had stopped.

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

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

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

describe('Stop during page discovery', () => {
  it('ends the op with the refusal and never reconnects or clicks', async () => {
    const renews: Array<(e: Error) => void> = [];
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
      if (method === 'browser.lease.renew') return new Promise((_r, reject) => renews.push(reject));
      if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
      // Discovery keeps failing transiently, so the engine sits in its retry loop.
      if (method === 'browser.cdp.info') return Promise.reject(new Error('connect ECONNRESET'));
      return Promise.resolve({});
    });
    const clicked = vi.fn();

    const op = withAutomationLease(deps, 'surface-1', async (scope) => {
      // A tool body: find the page, then act on it.
      await PlaywrightEngine.getInstance().getPageForScope(scope);
      clicked();
      return 'clicked';
    });
    const settled = op.then(() => 'resolved', (err: Error) => err);

    await vi.advanceTimersByTimeAsync(600);
    expect(renews).toHaveLength(1);
    const infoBeforeStop = mockSendRpc.mock.calls.filter(([m]) => m === 'browser.cdp.info').length;
    expect(infoBeforeStop).toBeGreaterThan(0);

    // The user presses Stop: main answers the parked renew with the refusal.
    renews[0](new Error('browser.lease.renew: BROWSER_AGENT_PAUSED: the user stopped this action and paused agent control of this tab.'));
    const err = await settled;
    expect((err as Error & { code?: string }).code).toBe(AGENT_PAUSED_CODE);

    // Let every retry the engine would have made come due.
    await vi.advanceTimersByTimeAsync(30_000);
    const infoAfter = mockSendRpc.mock.calls.filter(([m]) => m === 'browser.cdp.info').length;
    expect(infoAfter).toBe(infoBeforeStop);
    expect(mockConnectOverCDP).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });
});
