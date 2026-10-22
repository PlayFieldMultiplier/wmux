import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// browser_open and browser_tabs new as the FIRST browser call on a pane.
//
// Main opens a tab by loading its URL at once, before the MCP lane holds a
// Page for it, so a URL that downloads was saved before the download guard
// existed. On an unprotected Chrome pane the tab now opens on about:blank, the
// engine hands the page out (arming the guard), and only then is the URL
// loaded: a download it starts is cancelled and deleted. A protected pane, or
// any other backend, keeps main's own open path.

const { mockSendRpc, isUnprotectedChrome, getPage } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  isUnprotectedChrome: vi.fn(),
  getPage: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      isUnprotectedChrome,
      getPageForScope: getPage,
      resolveWorkspaceBackend: vi.fn(async () => 'chrome'),
      isLiveWriteConfined: async () => false,
    }),
  },
}));
// No DNS in a unit test: the resolving half of the URL policy answers "fine".
vi.mock('../../../shared/navigationPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/navigationPolicy')>()),
  validateResolvedNavigationUrl: vi.fn(async () => ({ valid: true })),
}));

import { openWithDownloadGuard, registerNavigationTools } from '../tools/navigation';
import { resetProtectionMemoryForTests } from '../automationLease';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-1') };
const tools = new Map<string, ToolHandler>();
registerNavigationTools({ tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => tools.set(n, h) } as never, deps);
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

const DOWNLOAD_URL = 'https://files.example/report.zip';
let leasePolicy: unknown = { protected: false };

/** A page whose goto starts a download (Content-Disposition: attachment). */
function downloadingPage() {
  const listeners = new Map<string, Array<(arg: unknown) => void>>();
  const download = {
    url: () => DOWNLOAD_URL,
    cancel: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  let armedAtGoto = false;
  const page = {
    on: vi.fn((ev: string, fn: (arg: unknown) => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
    }),
    url: () => 'about:blank',
    goto: vi.fn(async () => {
      armedAtGoto = (listeners.get('download') ?? []).length > 0;
      (listeners.get('download') ?? []).forEach((fn) => fn(download));
      throw new Error('page.goto: Download is starting');
    }),
  };
  return { page, download, armedAtGoto: () => armedAtGoto };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  leasePolicy = { protected: false };
  resetProtectionMemoryForTests();
  __resetSurfaceRoutingForTesting();
  mockSendRpc.mockImplementation(async (method: string) => {
    if (method === 'browser.lease.acquire') return { token: 't', policy: leasePolicy };
    if (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get') return { token: null };
    if (method === 'browser.tabs') {
      return { ok: true, action: 'new', tab: { surfaceId: 's-new', paneId: 'p', url: 'about:blank', title: '', selected: true } };
    }
    return {};
  });
});

describe('browser_tabs new as the first browser call', () => {
  it('unprotected Chrome: opens on about:blank, arms the guard, then loads; the download is cancelled and deleted', async () => {
    isUnprotectedChrome.mockResolvedValue(true);
    const { page, download, armedAtGoto } = downloadingPage();
    getPage.mockResolvedValue(page);

    const out = await tools.get('browser_tabs')!({ action: 'new', url: DOWNLOAD_URL });

    const tabsCall = mockSendRpc.mock.calls.find(([m]) => m === 'browser.tabs');
    expect(tabsCall?.[1]).not.toHaveProperty('url');
    expect(page.goto).toHaveBeenCalledWith(DOWNLOAD_URL, expect.anything());
    expect(armedAtGoto()).toBe(true);
    await flush();
    expect(download.cancel).toHaveBeenCalled();
    expect(download.delete).toHaveBeenCalled();
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('"surfaceId": "s-new"');
    expect(text(out)).toContain('loading the URL failed');
  });

  it('protected pane: main opens the URL itself, as before, and no page is armed', async () => {
    isUnprotectedChrome.mockResolvedValue(false);
    const out = await tools.get('browser_tabs')!({ action: 'new', url: DOWNLOAD_URL });
    const tabsCall = mockSendRpc.mock.calls.find(([m]) => m === 'browser.tabs');
    expect(tabsCall?.[1]).toMatchObject({ action: 'new', url: DOWNLOAD_URL });
    expect(getPage).not.toHaveBeenCalled();
    expect(out.isError).toBeUndefined();
  });
});

describe('browser_open as the first browser call', () => {
  // browser_open lives in src/mcp/index.ts and delegates to this function with
  // its own browser.open call; the stand-in below plays that call.
  function openStandIn() {
    const calls: Array<string | undefined> = [];
    const open = async (withUrl: string | undefined) => {
      calls.push(withUrl);
      return { surfaceId: 's-open' };
    };
    return { calls, open };
  }

  it('index.ts routes browser_open through openWithDownloadGuard', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf-8');
    const open = src.slice(src.indexOf("'browser_open',"), src.indexOf("'browser_close'"));
    expect(open).toContain('openWithDownloadGuard(');
    expect(open).toContain("{ ...(withUrl && { url: withUrl })");
  });

  it('unprotected Chrome: opens on about:blank, arms the guard, then loads; the download is cancelled and deleted', async () => {
    isUnprotectedChrome.mockResolvedValue(true);
    const { page, download, armedAtGoto } = downloadingPage();
    getPage.mockResolvedValue(page);
    const { calls, open } = openStandIn();

    const { load } = await openWithDownloadGuard(deps, 'browser_open', 'ws-1', DOWNLOAD_URL, open, (r) => r.surfaceId);

    expect(calls).toEqual([undefined]);
    expect(armedAtGoto()).toBe(true);
    await flush();
    expect(download.cancel).toHaveBeenCalled();
    expect(download.delete).toHaveBeenCalled();
    expect(load).toMatchObject({ ok: false, error: expect.stringContaining('Download is starting') });
  });

  it('a URL the policy blocks opens nothing', async () => {
    isUnprotectedChrome.mockResolvedValue(true);
    const { calls, open } = openStandIn();
    await expect(
      openWithDownloadGuard(deps, 'browser_open', 'ws-1', 'file:///etc/passwd', open, (r) => r.surfaceId),
    ).rejects.toThrow(/URL blocked/);
    expect(calls).toEqual([]);
  });

  it('protected pane: main opens the URL itself, as before, and no page is armed', async () => {
    isUnprotectedChrome.mockResolvedValue(false);
    const { calls, open } = openStandIn();
    const { load } = await openWithDownloadGuard(deps, 'browser_open', 'ws-1', DOWNLOAD_URL, open, (r) => r.surfaceId);
    expect(calls).toEqual([DOWNLOAD_URL]);
    expect(load).toBeUndefined();
    expect(getPage).not.toHaveBeenCalled();
  });

  it('a pane that became protected before the load is not armed and keeps its own navigation rule', async () => {
    isUnprotectedChrome.mockResolvedValue(true);
    leasePolicy = { protected: true, epoch: 2, hosts: { mode: 'allowlist', allow: ['other.example'], block: [] } };
    const { page } = downloadingPage();
    getPage.mockResolvedValue(page);
    const { open } = openStandIn();
    const { load } = await openWithDownloadGuard(deps, 'browser_open', 'ws-1', DOWNLOAD_URL, open, (r) => r.surfaceId);
    expect(load).toMatchObject({ ok: false });
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.on).not.toHaveBeenCalledWith('download', expect.anything());
  });
});
