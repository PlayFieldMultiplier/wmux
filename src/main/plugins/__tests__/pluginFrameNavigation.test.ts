import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { PLUGIN_FRAME_IPC } from '../../../shared/pluginHost';
import { attachPluginFrameNavigation, isPluginBundleUrl, pluginBridgeBootstrap } from '../pluginFrameNavigation';

function setup() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { frames: [] as unknown[], url: 'file:///app/index.html' }, send: vi.fn(), ipc: { handle: vi.fn() },
  });
  const frame = { name: 'wmux-plugin-frame:demo:abc', url: 'wmux-plugin://demo/index.html',
    executeJavaScript: vi.fn(async () => true), frameTreeNodeId: 1, parent: contents.mainFrame };
  contents.mainFrame.frames.push(frame);
  attachPluginFrameNavigation(contents as unknown as WebContents);
  const ready = contents.ipc.handle.mock.calls.find(([channel]) => channel === PLUGIN_FRAME_IPC.ready)![1];
  return { contents, frame, ready: () => ready({ senderFrame: contents.mainFrame }, 'demo', 'wmux-plugin-frame:demo:abc', '12345678-1234-1234'), rawReady: ready };
}

describe('plugin bundle navigation', () => {
  it.each(['https://example.test/', 'data:text/html,test', 'about:blank', 'wmux-plugin://other/index.html',
    'wmux-plugin://demo:123/index.html', 'wmux-plugin://user@demo/index.html'])('refuses %s', (url) => {
    expect(isPluginBundleUrl('demo', url)).toBe(false);
    const { contents, frame } = setup();
    for (const eventName of ['will-frame-navigate', 'will-redirect']) {
      const event = { isMainFrame: false, frame, url, preventDefault: vi.fn() };
      contents.emit(eventName, event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });
  it('allows its own bundled pages, while preserving the original identity after a rename', () => {
    const { contents, frame } = setup();
    const event = { isMainFrame: false, frame, url: 'wmux-plugin://demo/next.html', preventDefault: vi.fn() };
    contents.emit('will-frame-navigate', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    frame.name = 'wmux-plugin-frame:other:abc';
    contents.emit('will-frame-navigate', { ...event, url: 'wmux-plugin://other/index.html' });
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it('requires the committed URL, a unique direct child and the owner top frame', async () => {
    const { contents, frame, ready, rawReady } = setup();
    expect(await ready()).toBe(true);
    frame.url = 'https://example.test';
    expect(await ready()).toBe(false);
    frame.url = 'wmux-plugin://demo/index.html';
    expect(await rawReady({ senderFrame: frame }, 'demo', frame.name, '12345678-1234-1234')).toBe(false);
    contents.mainFrame.frames.push({ ...frame });
    expect(await ready()).toBe(false);
  });
  it('revokes the original frame bridge on document navigation, but not anchor changes', () => {
    const { contents, frame } = setup();
    contents.emit('did-start-navigation', { frame, url: frame.url, isMainFrame: false, isSameDocument: false });
    expect(contents.send).toHaveBeenCalledWith(PLUGIN_FRAME_IPC.navigated, frame.name);
    contents.send.mockClear();
    contents.emit('did-start-navigation', { frame, url: frame.url, isMainFrame: false, isSameDocument: true });
    expect(contents.send).not.toHaveBeenCalled();
  });
  it('refuses unbound or nested frames', () => {
    const { contents, frame } = setup();
    const event = { isMainFrame: false, frame: { ...frame, parent: frame }, url: frame.url, preventDefault: vi.fn() };
    contents.emit('will-frame-navigate', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});

it('preserves the current bridge when navigation will be refused', () => {
  const { contents, frame } = setup();
  for (const url of ['https://example.test/', 'wmux-plugin://other/index.html', 'about:blank']) {
    contents.emit('did-start-navigation', { frame, url, isMainFrame: false, isSameDocument: false });
  }
  expect(contents.send).not.toHaveBeenCalled();
});
it('refuses navigation when a detached frame property throws', () => {
  const { contents } = setup();
  const frame = { get parent() { throw new Error('detached'); } };
  const event = { frame, url: 'https://example.test', isMainFrame: false, preventDefault: vi.fn() };
  contents.emit('will-frame-navigate', event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
});

it('checks the executing document again before creating or offering a channel', () => {
  const channel = vi.fn();
  const parent = { postMessage: vi.fn() };
  const script = pluginBridgeBootstrap('demo', 'nonce', 'file://');
  for (const href of ['about:blank', 'https://demo/', 'wmux-plugin://other/page.html']) {
    expect(runInNewContext(script, { location: new URL(href), MessageChannel: channel, parent })).toBe(false);
  }
  expect(channel).not.toHaveBeenCalled();
  expect(parent.postMessage).not.toHaveBeenCalled();
});

it('creates both ends in the checked document and preserves the v1 init source', () => {
  const channel = new MessageChannel();
  const parent = { postMessage: vi.fn() };
  const window = { dispatchEvent: vi.fn() };
  const result = runInNewContext(pluginBridgeBootstrap('demo', 'nonce', 'null'), {
    location: new URL('wmux-plugin://demo/page.html'), parent, window,
    MessageChannel: class { port1 = channel.port1; port2 = channel.port2; },
    MessageEvent: class { constructor(public type: string, public options: unknown) {} },
  });
  expect(result).toBe(true);
  expect(parent.postMessage).toHaveBeenCalledWith({ kind: 'wmux-plugin-bridge', nonce: 'nonce' }, '*', [channel.port1]);
  expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
    type: 'message', options: { data: { v: 1, kind: 'init' }, source: parent, origin: 'null', ports: [channel.port2] },
  }));
  channel.port1.close();
  channel.port2.close();
});
