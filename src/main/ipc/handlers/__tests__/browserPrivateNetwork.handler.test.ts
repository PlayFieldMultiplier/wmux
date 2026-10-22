import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { BROWSER_PRIVATE_NETWORK_IPC } from '../../../../shared/browserBackend';
import { registerBrowserPrivateNetworkIpc } from '../browserPrivateNetwork.handler';

function fakeWindow() {
  const mainFrame = { id: 'main-frame' };
  const webContents = { mainFrame, isDestroyed: () => false };
  return { win: { webContents, isDestroyed: () => false } as unknown as BrowserWindow, webContents, mainFrame };
}

/** A store whose writes succeed or fail on demand, with the store's own rules. */
function fakeStore(initial: boolean) {
  let value = initial;
  const state = { writes: true };
  return {
    state,
    allowPrivateNetwork: () => value,
    setAllowPrivateNetwork: vi.fn((allow: boolean) => {
      value = allow;
      if (!state.writes && allow) value = false;
      return state.writes;
    }),
  };
}

function setup(initial = false) {
  const { win, webContents, mainFrame } = fakeWindow();
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const store = fakeStore(initial);
  registerBrowserPrivateNetworkIpc({ handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never, {
    getWindow: () => win,
    store,
  });
  const trusted = { sender: webContents, senderFrame: mainFrame };
  const untrusted = { sender: { mainFrame: { id: 'guest' } }, senderFrame: { id: 'guest' } };
  return { handlers, store, trusted, untrusted };
}

describe('browser private-network IPC', () => {
  it('get answers the value in force, to the wmux window only', () => {
    const { handlers, trusted, untrusted } = setup(true);
    expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.get)!(trusted)).toBe(true);
    expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.get)!(untrusted)).toBe(false);
  });

  it('set answers the value in force and that it was saved', () => {
    const { handlers, trusted } = setup(false);
    expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(trusted, true)).toEqual({ allow: true, saved: true });
    expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(trusted, false)).toEqual({ allow: false, saved: true });
  });

  it('set says when the file did not keep the change', () => {
    const { handlers, store, trusted } = setup(true);
    store.state.writes = false;
    // Off applies now but is not saved; on is not applied at all.
    expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(trusted, false)).toEqual({ allow: false, saved: false });
    expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(trusted, true)).toEqual({ allow: false, saved: false });
  });

  it('writes nothing for another sender or a non-boolean value', () => {
    const { handlers, store, trusted, untrusted } = setup(true);
    expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(untrusted, false)).toEqual({ allow: true, saved: false });
    expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(trusted, 'false')).toEqual({ allow: true, saved: false });
    expect(store.setAllowPrivateNetwork).not.toHaveBeenCalled();
  });
});
