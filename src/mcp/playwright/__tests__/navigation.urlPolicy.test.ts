import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1359 — the chrome lane and the URL policy.
//
// `browser_navigate` on the chrome backend drives a Playwright page directly:
// it never reaches main's `browser.navigate`, which is where the RESOLVING
// half of the policy runs. `browser_tabs new` is always an RPC, so it always
// got that half. One URL, two verdicts — a hostname whose DNS answer lands in
// a blocked range loaded in the open tab and was refused in a new one.
//
// The lane now runs the same shared policy before it touches the page.

const mockSendRpc = vi.fn();
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

vi.mock('../../browser-replay/actionRing', () => ({ recordAction: vi.fn() }));

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

const getPageForScope = vi.fn();
const resolveWorkspaceBackend = vi.fn(async () => 'chrome');
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope, resolveWorkspaceBackend }),
  },
}));

import { registerNavigationTools } from '../tools/navigation';
import { validateResolvedNavigationUrl } from '../../../shared/navigationPolicy';
import { ALLOW_PRIVATE_NETWORK_ENV } from '../../../shared/types';
import type { BrowserToolDeps } from '../browserScope';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const resolveWorkspaceId = vi.fn(async () => 'ws-caller');
let navigate: ToolHandler;
let goto: ReturnType<typeof vi.fn>;
/** What main answers to browser.navigationPolicy.get; an Error means main is unreachable. */
let mainPolicy: { allowPrivateNetwork: boolean } | Error;

afterEach(() => {
  delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveWorkspaceId.mockResolvedValue('ws-caller');
  resolveWorkspaceBackend.mockResolvedValue('chrome');
  goto = vi.fn(async () => null);
  getPageForScope.mockResolvedValue({ url: () => 'about:blank', goto });
  mainPolicy = { allowPrivateNetwork: false };
  delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
  mockSendRpc.mockImplementation((method: string) => {
    if (method === 'browser.navigationPolicy.get') {
      return mainPolicy instanceof Error ? Promise.reject(mainPolicy) : Promise.resolve(mainPolicy);
    }
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
    if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
    return Promise.resolve({});
  });
  const tools = new Map<string, ToolHandler>();
  registerNavigationTools(
    {
      tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      },
    } as never,
    { resolveWorkspaceId } as BrowserToolDeps,
  );
  navigate = tools.get('browser_navigate')!;
});

describe('browser_navigate chrome lane URL policy', () => {
  it('refuses a hostname that resolves into a blocked range, as the RPC lane does', async () => {
    lookupMock.mockResolvedValue([{ address: '172.16.4.9', family: 4 }]);

    const result = await navigate({ url: 'http://intranet.example/app' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('URL blocked:');
    expect(result.content[0].text).toContain('172.16.4.9');
    // And it says how to allow it, the same sentence every other entry point
    // prints for the same address.
    expect(result.content[0].text).toContain('turn on Settings → Browser → Allow private network addresses');
    expect(result.content[0].text).toContain('WMUX_ALLOW_PRIVATE_NETWORK=1');
    // The page was never touched.
    expect(goto).not.toHaveBeenCalled();

    // Same URL, same policy object the tabs/open/replay lanes call.
    await expect(
      validateResolvedNavigationUrl('http://intranet.example/app', { allowPrivateNetwork: false }),
    ).resolves.toMatchObject({ valid: false });
  });

  it('lets a host that simply does not resolve reach the browser', async () => {
    // Not a positive block: refusing here would replace Chrome's own
    // net::ERR_NAME_NOT_RESOLVED with a paraphrase, and there is nothing
    // reachable to protect against.
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND gone.test'));

    const result = await navigate({ url: 'https://gone.test/page' });

    expect(result.isError).toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it('allows a public host without comment', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const result = await navigate({ url: 'https://example.com/' });

    expect(result.isError).toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);
  });
});

describe('browser_navigate chrome lane: the private-network switch comes from main', () => {
  it.each([
    ['10.20.30.40', 4],
    ['172.16.4.9', 4],
    ['192.168.7.7', 4],
    ['fd00::1234', 6],
  ] as const)('a host resolving to %s loads while main reports the setting on, and not after it is turned off', async (address, family) => {
    lookupMock.mockResolvedValue([{ address, family }]);

    mainPolicy = { allowPrivateNetwork: true };
    const on = await navigate({ url: 'http://intranet.example/app' });
    expect(on.isError, on.content[0].text).toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);

    // Toggled off: no restart, no cache — the very next navigation is refused.
    mainPolicy = { allowPrivateNetwork: false };
    const off = await navigate({ url: 'http://intranet.example/app' });
    expect(off.isError).toBe(true);
    expect(off.content[0].text).toContain('URL blocked:');
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it('asks main once per navigation, before anything else', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await navigate({ url: 'https://example.com/' });
    await navigate({ url: 'https://example.com/' });
    const methods = mockSendRpc.mock.calls.map(([method]) => method);
    expect(methods.filter((m) => m === 'browser.navigationPolicy.get')).toHaveLength(2);
    expect(methods[0]).toBe('browser.navigationPolicy.get');
  });

  it('keeps metadata and link-local blocked with the setting on', async () => {
    mainPolicy = { allowPrivateNetwork: true };
    for (const [address, family] of [['169.254.169.254', 4], ['fe80::1', 6], ['::ffff:169.254.169.254', 6]] as const) {
      lookupMock.mockResolvedValue([{ address, family }]);
      const result = await navigate({ url: 'http://sneaky.example/' });
      expect(result.isError, address).toBe(true);
    }
    expect(goto).not.toHaveBeenCalled();
  });

  describe('when main cannot answer', () => {
    it('falls back to the environment variable alone: off refuses', async () => {
      mainPolicy = new Error('wmux is not running. Start the app first.');
      lookupMock.mockResolvedValue([{ address: '10.0.0.8', family: 4 }]);

      const literal = await navigate({ url: 'http://10.0.0.8/' });
      expect(literal.isError).toBe(true);
      expect(literal.content[0].text).toContain('URL blocked:');
      const resolved = await navigate({ url: 'http://intranet.example/' });
      expect(resolved.isError).toBe(true);
      expect(goto).not.toHaveBeenCalled();
    });

    it('falls back to the environment variable alone: on allows', async () => {
      mainPolicy = new Error('Unknown method: browser.navigationPolicy.get');
      process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
      lookupMock.mockResolvedValue([{ address: '10.0.0.8', family: 4 }]);

      const result = await navigate({ url: 'http://intranet.example/' });
      expect(result.isError, result.content[0].text).toBeUndefined();
      expect(goto).toHaveBeenCalledTimes(1);
    });
  });
});
