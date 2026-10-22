import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, mockDisconnect } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  mockDisconnect: vi.fn(async () => undefined),
}));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ disconnect: mockDisconnect, drainLocalLifecycle: () => [] }),
  },
}));

import { withAutomationLease } from '../automationLease';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';
import { AGENT_PAUSED_CODE, USER_IN_CONTROL_CODE } from '../../../shared/browserAgentControl';

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

/** sendRpc where each renew parks until the test answers it. */
function parkedRenews() {
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  mockSendRpc.mockImplementation((method: string) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
    if (method === 'browser.lease.renew') {
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    }
    return Promise.resolve({});
  });
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockSendRpc.mockReset();
  mockDisconnect.mockClear();
  __resetSurfaceRoutingForTesting();
  deps.resolveWorkspaceId.mockResolvedValue('ws-test');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withAutomationLease — the user stops the tab mid-action', () => {
  it('fails the in-flight action with the refusal at once and drops the Playwright connection', async () => {
    const renews = parkedRenews();
    // A click still waiting for its element: it would never finish on its own.
    const body = vi.fn(() => new Promise<string>(() => undefined));

    const op = withAutomationLease(deps, 'surface-1', body);
    const settled = op.then(() => 'resolved', (err: Error) => err);
    await vi.advanceTimersByTimeAsync(600);
    expect(body).toHaveBeenCalled();
    expect(renews).toHaveLength(1);

    // Main answers the parked renew: the user pressed Stop.
    renews[0].reject(new Error('browser.lease.renew: BROWSER_AGENT_PAUSED: the user stopped this action and paused agent control of this tab.'));
    const err = await settled;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe(AGENT_PAUSED_CODE);
    expect((err as Error).message).toMatch(/^BROWSER_AGENT_PAUSED: the user stopped this action/);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockSendRpc).toHaveBeenCalledWith('browser.lease.release', { token: 'lease-1' });
  });

  it('a lease refused because the user has the tab is final: the body never runs', async () => {
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.lease.acquire'
        ? Promise.reject(new Error('browser.lease.acquire: BROWSER_USER_IN_CONTROL: the user took over this tab and is using it, so nothing was done.'))
        : Promise.resolve({}),
    );
    const body = vi.fn(async () => 'must not run');

    await expect(withAutomationLease(deps, 'surface-1', body)).rejects.toMatchObject({ code: USER_IN_CONTROL_CODE });
    expect(body).not.toHaveBeenCalled();
  });

  it('a finished action never reports a Stop that comes after it', async () => {
    const renews = parkedRenews();
    let finish!: (v: string) => void;
    const body = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));

    const op = withAutomationLease(deps, 'surface-1', body);
    await vi.advanceTimersByTimeAsync(600);
    finish('done');
    await expect(op).resolves.toBe('done');
    renews[0].reject(new Error('browser.lease.renew: BROWSER_AGENT_PAUSED: late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it('paces renewals like before against a main that does not park them', async () => {
    mockSendRpc.mockImplementation((method: string) =>
      Promise.resolve(method === 'browser.lease.acquire' ? { token: 'lease-1' } : method === 'browser.lease.renew' ? { ok: true } : {}),
    );
    const op = withAutomationLease(deps, 'surface-1', () => new Promise<string>((r) => setTimeout(() => r('ok'), 25_000)));
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(op).resolves.toBe('ok');
    const renews = mockSendRpc.mock.calls.filter(([m]) => m === 'browser.lease.renew');
    // 0.5s, 10.5s, 20.5s — not a tight loop.
    expect(renews).toHaveLength(3);
    expect(renews[0][1]).toEqual({ token: 'lease-1', waitMs: 8_000 });
  });
});
