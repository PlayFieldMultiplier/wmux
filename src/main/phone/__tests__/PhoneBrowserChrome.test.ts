import { describe, expect, it, vi } from 'vitest';
import { handlePhoneBrowser } from '../PhoneBrowser';
import { createPhoneChromeDeps, phoneChromeTabs, type PhoneChromeDeps, type PhoneChromeRegistry } from '../PhoneBrowserChrome';
import { ChromePageSessionError, type ChromeBackendClient, type ChromeTargetInfo } from '../../browser-session/ChromeLauncher';
import type { RpcResponse } from '../../../shared/rpc';

const METRICS = { cssVisualViewport: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 40, scale: 1 } };

/** A fake CDP page session: answers by method, records every call. */
function fakeChrome(over: Partial<PhoneChromeDeps> = {}) {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let url = 'https://shop.example.com/cart';
  const answer = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'Page.getLayoutMetrics') return METRICS;
    if (method === 'Page.captureScreenshot') return { data: 'aGVsbG8=' };
    return {};
  });
  const deps: PhoneChromeDeps & { setURL(next: string): void } = {
    tabs: vi.fn(async (ws: string) => ws === 'ws-1' ? [{ surfaceId: 'chrome-own', url, title: 'Cart' }] : [{ surfaceId: 'chrome-other', url: 'https://bank.example.com/', title: 'Bank' }]),
    session: vi.fn(async () => ({
      isValid: () => true,
      send: async (method: string, params?: Record<string, unknown>) => {
        sent.push({ method, ...(params ? { params } : {}) });
        return answer(method);
      },
    })),
    focus: vi.fn(async () => true),
    canOpen: () => true,
    validateNavigation: vi.fn(async () => undefined),
    setURL: (next: string) => { url = next; },
    ...over,
  };
  return { deps, sent, answer };
}

function fixture(chrome?: PhoneChromeDeps) {
  return {
    backend: () => 'chrome',
    clearViewport: vi.fn(async () => undefined),
    nativeBounds: async () => ({ width: 1000, height: 728 }),
    scroll: vi.fn(async () => undefined),
    input: (_id: number, operation: () => Promise<RpcResponse>) => operation(),
    targets: () => [
      { surfaceId: 'pane', workspaceId: 'ws-1', webContentsId: 1, targetId: 't', wsUrl: 'ws://private' },
    ],
    page: () => ({ title: 'Pane', url: 'https://pane.example.com/' }),
    invoke: vi.fn(async (method: string): Promise<RpcResponse> => ({ id: 'rpc', ok: true, result: method === 'browser.evaluate' ? { value: { width: 1000, height: 728, scrollX: 0, scrollY: 0, scale: 1 } } : { ok: true, tab: { surfaceId: 'chrome-new' } } })),
    ...(chrome ? { chrome } : {}),
  };
}

const scope = { workspaceId: 'ws-1', surfaceId: 'chrome-own' };
const geometry = { width: 1000, height: 700, scrollX: 0, scrollY: 40 };

describe('phone preview on dedicated-profile Chrome', () => {
  it('lists Chrome rows only for a phone that asked, and labels every row then', async () => {
    const { deps } = fakeChrome();
    expect(await handlePhoneBrowser('browser.list', { workspaceId: 'ws-1' }, fixture(deps)))
      .toEqual({ pages: [{ id: 'pane', title: 'Pane', url: 'https://pane.example.com/' }] });
    expect(deps.tabs).not.toHaveBeenCalled();
    expect(await handlePhoneBrowser('browser.list', { workspaceId: 'ws-1', chrome: true }, fixture(deps))).toEqual({ pages: [
      { id: 'pane', title: 'Pane', url: 'https://pane.example.com/', backend: 'builtin' },
      { id: 'chrome-own', title: 'Cart', url: 'https://shop.example.com/cart', backend: 'chrome' },
    ] });
  });

  it('leaves out a tab that is not an http(s) page, and refuses to drive it', async () => {
    const { deps, sent } = fakeChrome();
    deps.setURL('chrome://settings/');
    const listed = await handlePhoneBrowser('browser.list', { workspaceId: 'ws-1', chrome: true }, fixture(deps)) as { pages: unknown[] };
    expect(listed.pages).toHaveLength(1);
    await expect(handlePhoneBrowser('browser.capture', scope, fixture(deps))).rejects.toThrow('Only HTTP');
    expect(sent).toHaveLength(0);
  });

  it('captures with the builtin shape, clipped to the viewport the geometry describes', async () => {
    const { deps, sent } = fakeChrome();
    const capture = await handlePhoneBrowser('browser.capture', scope, fixture(deps)) as Record<string, unknown>;
    expect(capture).toMatchObject({ data: 'aGVsbG8=', mimeType: 'image/jpeg', geometry, pageURL: 'https://shop.example.com/cart' });
    expect(typeof capture.capturedAt).toBe('number');
    expect(sent.find((c) => c.method === 'Page.captureScreenshot')?.params)
      .toEqual({ format: 'jpeg', quality: 65, clip: { x: 0, y: 40, width: 1000, height: 700, scale: 0.75 } });
  });

  it('retakes an oversized capture smaller, then gives up within the same limit', async () => {
    const { deps, sent, answer } = fakeChrome();
    answer.mockImplementation(async (method: string) => method === 'Page.getLayoutMetrics' ? METRICS : { data: 'x'.repeat(800 * 1024) });
    await expect(handlePhoneBrowser('browser.capture', scope, fixture(deps))).rejects.toThrow('too large for preview');
    expect(sent.filter((c) => c.method === 'Page.captureScreenshot').map((c) => c.params?.quality)).toEqual([65, 50]);
  });

  it('a capture that does not finish in its budget is a hidden tab', async () => {
    const { deps, answer } = fakeChrome({ captureMs: 20 });
    answer.mockImplementation(async (method: string) => method === 'Page.getLayoutMetrics' ? METRICS : new Promise(() => undefined));
    expect(await handlePhoneBrowser('browser.capture', scope, fixture(deps))).toEqual({ error: 'browser-tab-hidden' });
  });

  it('a tab that went away is gone, and so is a Chrome surface this workspace does not have', async () => {
    const { deps } = fakeChrome({ session: vi.fn(async () => { throw new ChromePageSessionError('gone', 'x'); }) });
    expect(await handlePhoneBrowser('browser.capture', scope, fixture(deps))).toEqual({ error: 'browser-tab-gone' });
    const live = fakeChrome();
    // Another workspace's tab: never looked up across workspaces, never driven.
    expect(await handlePhoneBrowser('browser.capture', { workspaceId: 'ws-1', surfaceId: 'chrome-other' }, fixture(live.deps))).toEqual({ error: 'browser-tab-gone' });
    expect(live.deps.session).not.toHaveBeenCalled();
    // Without the Chrome driver, the builtin answer is what it always was.
    await expect(handlePhoneBrowser('browser.capture', { workspaceId: 'ws-1', surfaceId: 'chrome-other' }, fixture())).rejects.toThrow('does not belong');
  });

  it('a socket that is not up says the backend is unavailable', async () => {
    const { deps } = fakeChrome({ session: vi.fn(async () => { throw new ChromePageSessionError('unavailable', 'x'); }) });
    expect(await handlePhoneBrowser('browser.capture', scope, fixture(deps))).toEqual({ error: 'browser-backend-unavailable' });
  });

  it('types with focus emulation around it, and never echoes the text', async () => {
    const { deps, sent } = fakeChrome();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await handlePhoneBrowser('browser.type', { ...scope, expectedURL: 'https://shop.example.com/cart', text: 'hunter2-secret' }, fixture(deps));
    expect(result).toEqual({ applied: true });
    expect(sent.map((c) => c.method)).toEqual(['Emulation.setFocusEmulationEnabled', 'Input.insertText', 'Emulation.setFocusEmulationEnabled']);
    expect(sent[0].params).toEqual({ enabled: true });
    expect(sent[2].params).toEqual({ enabled: false });
    // A failure does not carry Chrome's words, which could quote the input.
    const failing = fakeChrome();
    failing.answer.mockImplementation(async (method: string) => {
      if (method === 'Input.insertText') throw new Error('CDP: cannot insert hunter2-secret');
      return {};
    });
    const err = await handlePhoneBrowser('browser.type', { ...scope, expectedURL: 'https://shop.example.com/cart', text: 'hunter2-secret' }, fixture(failing.deps)).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('hunter2');
    expect(failing.sent.at(-1)).toEqual({ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } });
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
    log.mockRestore();
  });

  it('enforces the page and the viewport the phone last saw, inside the input closure too', async () => {
    const { deps, sent } = fakeChrome();
    await expect(handlePhoneBrowser('browser.type', { ...scope, expectedURL: 'https://shop.example.com/old', text: 'x' }, fixture(deps))).rejects.toThrow('page changed');
    await expect(handlePhoneBrowser('browser.tap', { ...scope, expectedURL: 'https://shop.example.com/cart', geometry: { ...geometry, scrollY: 0 }, x: 0.5, y: 0.5 }, fixture(deps))).rejects.toThrow('viewport changed');
    expect(sent.some((c) => c.method.startsWith('Input.'))).toBe(false);
    await handlePhoneBrowser('browser.tap', { ...scope, expectedURL: 'https://shop.example.com/cart', geometry, x: 0.5, y: 0.5 }, fixture(deps));
    expect(sent.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(sent.at(-1)?.params).toMatchObject({ x: 500, y: 350 });
    // The tab navigates while the input waits its turn.
    const racing = fakeChrome();
    let reads = 0;
    racing.deps.tabs = vi.fn(async () => [{ surfaceId: 'chrome-own', url: reads++ < 2 ? 'https://shop.example.com/cart' : 'https://evil.example.com/', title: 'Cart' }]);
    await expect(handlePhoneBrowser('browser.type', { ...scope, expectedURL: 'https://shop.example.com/cart', text: 'x' }, fixture(racing.deps))).rejects.toThrow('page changed');
    expect(racing.sent).toHaveLength(0);
  });

  it('keys go through parseKeyPress; scroll moves the pointer first', async () => {
    const { deps, sent } = fakeChrome();
    await handlePhoneBrowser('browser.key', { ...scope, expectedURL: 'https://shop.example.com/cart', key: 'Shift+Tab' }, fixture(deps));
    expect(sent.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => [c.params?.type, c.params?.key, c.params?.modifiers])).toEqual([['keyDown', 'Tab', 8], ['keyUp', 'Tab', 8]]);
    sent.length = 0;
    await handlePhoneBrowser('browser.scroll', { ...scope, expectedURL: 'https://shop.example.com/cart', geometry, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 }, fixture(deps));
    const mouse = sent.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((c) => c.params?.type)).toEqual(['mouseMoved', 'mouseWheel']);
    expect(mouse[1].params).toMatchObject({ x: 500, y: 350, deltaX: 0, deltaY: 350 });
  });

  it('help-card typing is refused when the tab left the origin the help row showed', async () => {
    const { deps, sent } = fakeChrome();
    const typed = { ...scope, expectedURL: 'https://shop.example.com/cart', text: 'pw' };
    expect(await handlePhoneBrowser('browser.type', { ...typed, helpOrigin: 'https://login.example.com' }, fixture(deps))).toEqual({ error: 'browser-help-origin-changed' });
    expect(sent.some((c) => c.method === 'Input.insertText')).toBe(false);
    expect(await handlePhoneBrowser('browser.type', { ...typed, helpOrigin: 'https://shop.example.com' }, fixture(deps))).toEqual({ applied: true });
    // The same rule on a builtin pane.
    const pane = fixture();
    pane.backend = () => 'builtin';
    expect(await handlePhoneBrowser('browser.type', { workspaceId: 'ws-1', surfaceId: 'pane', expectedURL: 'https://pane.example.com/', text: 'pw', helpOrigin: 'https://login.example.com' }, pane)).toEqual({ error: 'browser-help-origin-changed' });
    expect(pane.invoke).not.toHaveBeenCalledWith('browser.type.cdp', expect.anything());
  });

  it('navigates through the desktop policy, and has no viewport emulation', async () => {
    const { deps, sent } = fakeChrome();
    await handlePhoneBrowser('browser.navigate', { ...scope, url: 'https://shop.example.com/next' }, fixture(deps));
    expect(deps.validateNavigation).toHaveBeenCalledWith('https://shop.example.com/next');
    expect(sent.at(-1)).toEqual({ method: 'Page.navigate', params: { url: 'https://shop.example.com/next' } });
    await expect(handlePhoneBrowser('browser.navigate', { ...scope, url: 'file:///etc/passwd' }, fixture(deps))).rejects.toThrow();
    expect(await handlePhoneBrowser('browser.viewport', { ...scope, mode: 'mobile' }, fixture(deps))).toEqual({ error: 'browser-action-unsupported' });
  });

  it('focus brings forward only a tab of this workspace', async () => {
    const { deps } = fakeChrome();
    expect(await handlePhoneBrowser('browser.focus', scope, fixture(deps))).toEqual({ applied: true });
    expect(deps.focus).toHaveBeenCalledWith('chrome-own', 'ws-1');
    vi.mocked(deps.focus).mockClear();
    expect(await handlePhoneBrowser('browser.focus', { workspaceId: 'ws-1', surfaceId: 'chrome-other' }, fixture(deps))).toEqual({ error: 'browser-tab-gone' });
    expect(deps.focus).not.toHaveBeenCalled();
    // A builtin pane: the renderer's select, when wired.
    const pane = fixture(deps);
    const focusBuiltin = vi.fn(async () => true);
    expect(await handlePhoneBrowser('browser.focus', { workspaceId: 'ws-1', surfaceId: 'pane' }, { ...pane, focusBuiltin })).toEqual({ applied: true });
    expect(focusBuiltin).toHaveBeenCalledWith('pane', 'ws-1');
    expect(await handlePhoneBrowser('browser.focus', { workspaceId: 'ws-1', surfaceId: 'pane' }, pane)).toEqual({ error: 'browser-action-unsupported' });
  });

  it('opens a Chrome tab only in a dedicated profile', async () => {
    const { deps } = fakeChrome({ canOpen: () => false });
    const live = fixture(deps);
    expect(await handlePhoneBrowser('browser.open', { workspaceId: 'ws-1', url: 'https://a.example.com/', backend: 'chrome' }, live)).toEqual({ error: 'browser-backend-unavailable' });
    expect(live.invoke).not.toHaveBeenCalled();
    const dedicated = fixture(fakeChrome().deps);
    expect(await handlePhoneBrowser('browser.open', { workspaceId: 'ws-1', url: 'https://a.example.com/', backend: 'chrome' }, dedicated)).toEqual({ surfaceId: 'chrome-new' });
    expect(dedicated.invoke).toHaveBeenCalledWith('browser.tabs', { workspaceId: 'ws-1', action: 'new', url: 'https://a.example.com/' });
    const builtinSetting = { ...fixture(fakeChrome().deps), backend: () => 'builtin' };
    expect(await handlePhoneBrowser('browser.open', { workspaceId: 'ws-1', url: 'https://a.example.com/', backend: 'chrome' }, builtinSetting)).toEqual({ error: 'browser-backend-unavailable' });
    await expect(handlePhoneBrowser('browser.open', { workspaceId: 'ws-1', url: 'https://a.example.com/', backend: 'live' }, dedicated)).rejects.toThrow('Invalid browser backend');
  });
});

describe('which Chrome tabs a workspace has (phoneChromeTabs)', () => {
  function client(tabs: ChromeTargetInfo[], extra: Partial<ChromeBackendClient> = {}): ChromeBackendClient {
    return {
      endpoint: async () => ({}), cdpInfoTargets: async () => [], openTab: async () => { throw new Error('no'); },
      listTargets: vi.fn(async () => tabs), closeSurface: async () => false, hasSurface: () => true, dispose: () => undefined,
      selectSurface: vi.fn(async () => true),
      pageSession: vi.fn(async () => ({ isValid: () => true, send: async () => ({}) })),
      ...extra,
    };
  }
  const tab = (surfaceId: string, workspaceId?: string): ChromeTargetInfo => ({ surfaceId, targetId: `t-${surfaceId}`, url: 'https://a.example.com/', title: surfaceId, ...(workspaceId ? { workspaceId } : {}) });

  it('strict workspace equality, pane profiles included, never Live, never a launch', async () => {
    const work = client([tab('chrome-mine', 'ws-1'), tab('chrome-nobody'), tab('chrome-theirs', 'ws-2')]);
    const pane = client([tab('chrome-pane', 'ws-1')]);
    const live = client([tab('user-bank', 'ws-1')], { writeScope: {} as ChromeBackendClient['writeScope'] });
    const peek = vi.fn((profile: string) => ({ work, pane, live, lent: live } as Record<string, ChromeBackendClient>)[profile]);
    const registry: PhoneChromeRegistry = { profileFor: () => 'work', peekLauncher: peek };
    const bindings = () => ({ p1: { workspaceId: 'ws-1', profile: 'pane' }, p2: { workspaceId: 'ws-1', profile: 'live' }, p3: { workspaceId: 'ws-1', profile: 'lent' }, p4: { workspaceId: 'ws-2', profile: 'other' } });
    const found = await phoneChromeTabs('ws-1', registry, bindings);
    expect(found.map(({ tab }) => tab.surfaceId)).toEqual(['chrome-mine', 'chrome-pane']);
    // The Live profile is never even looked up; a client with a write scope is never asked.
    expect(peek).not.toHaveBeenCalledWith('live');
    expect(live.listTargets).not.toHaveBeenCalled();
    expect(peek).not.toHaveBeenCalledWith('other');
  });

  it('focus and sessions reach only a listed tab, never a Live one', async () => {
    const work = client([tab('chrome-mine', 'ws-1')]);
    const live = client([tab('user-tab', 'ws-1')], { writeScope: {} as ChromeBackendClient['writeScope'] });
    const deps = createPhoneChromeDeps({
      registry: { profileFor: (ws) => (ws === 'ws-live' ? 'live' : 'work'), peekLauncher: (p) => (p === 'work' ? work : p === 'live' ? live : undefined) },
      paneBindings: () => ({}),
      validateNavigation: async () => undefined,
    });
    expect(await deps.focus('chrome-mine', 'ws-1')).toBe(true);
    expect(work.selectSurface).toHaveBeenCalledWith('chrome-mine');
    expect(await deps.focus('user-tab', 'ws-live')).toBe(false);
    expect(await deps.focus('chrome-mine', 'ws-2')).toBe(false);
    expect(live.selectSurface).not.toHaveBeenCalled();
    await expect(deps.session('user-tab', 'ws-live')).rejects.toMatchObject({ reason: 'gone' });
    expect(live.pageSession).not.toHaveBeenCalled();
    expect(deps.canOpen('ws-live')).toBe(false);
    expect(deps.canOpen('ws-1')).toBe(true);
    expect(await deps.tabs('ws-live')).toEqual([]);
  });
});
