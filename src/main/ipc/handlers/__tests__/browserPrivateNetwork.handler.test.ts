import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { BROWSER_PRIVATE_NETWORK_IPC } from '../../../../shared/browserBackend';
import { registerBrowserPrivateNetworkIpc } from '../browserPrivateNetwork.handler';
import { ALLOW_PRIVATE_NETWORK_ENV } from '../../../../shared/types';

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
  afterEach(() => {
    delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
  });

  it('get answers the stored setting, to the wmux window only', async () => {
    const { handlers, trusted, untrusted } = setup(true);
    await expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.get)!(trusted)).resolves.toEqual({ allow: true, envForced: false });
    await expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.get)!(untrusted)).resolves.toEqual({ allow: false, envForced: false });
  });

  it('get says when the environment variable in main turns the ranges on, without touching the setting', async () => {
    process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
    const { handlers, store, trusted } = setup(false);
    await expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.get)!(trusted)).resolves.toEqual({ allow: false, envForced: true });
    expect(store.setAllowPrivateNetwork).not.toHaveBeenCalled();
  });

  it('set answers the value in force and that it was saved', async () => {
    const { handlers, trusted } = setup(false);
    await expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(trusted, true)).resolves.toEqual({ allow: true, saved: true });
    await expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(trusted, false)).resolves.toEqual({ allow: false, saved: true });
  });

  it('set says when the file did not keep the change', async () => {
    const { handlers, store, trusted } = setup(true);
    store.state.writes = false;
    // Off applies now but is not saved; on is not applied at all.
    await expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(trusted, false)).resolves.toEqual({ allow: false, saved: false });
    await expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(trusted, true)).resolves.toEqual({ allow: false, saved: false });
  });

  it('writes nothing for another sender or a non-boolean value', async () => {
    const { handlers, store, trusted, untrusted } = setup(true);
    await expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(untrusted, false)).resolves.toEqual({ allow: true, saved: false });
    await expect(handlers.get(BROWSER_PRIVATE_NETWORK_IPC.set)!(trusted, 'false')).resolves.toEqual({ allow: true, saved: false });
    expect(store.setAllowPrivateNetwork).not.toHaveBeenCalled();
  });
});
