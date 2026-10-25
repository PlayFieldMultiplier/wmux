// @wmux-lane unit — 'win32' here is the platform openTarget is told; shell.openExternal is a mock and nothing is opened.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  return { ipcMain, shell: { openExternal: vi.fn(async () => undefined) }, __handlers: handlers };
});
// Never reach the native elevation from a unit test.
vi.mock('../../../net/elevate', () => ({
  shellExecuteAndWait: vi.fn(async () => {
    throw new Error('must not elevate in a unit test');
  }),
  tokenElevationType: () => 3,
}));
// The prompt kind comes from these two, never from the host running the test
// (a CI runner's token is already elevated).
vi.mock('../../../computer/selfElevation', () => ({ isSelfElevated: () => false }));

import * as electron from 'electron';
import type { BrowserWindow } from 'electron';
import { openTarget, registerNetFirewallHandlers } from '../netFirewall.handler';
import { IPC } from '../../../../shared/constants';
import type { DaemonClient } from '../../../DaemonClient';

const handlers = (electron as unknown as { __handlers: Map<string, (...a: unknown[]) => unknown> }).__handlers;
const shell = (electron as unknown as { shell: { openExternal: ReturnType<typeof vi.fn> } }).shell;

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn as (...args: unknown[]) => Promise<unknown>;
}

const mainFrame = {};
const webContents = { mainFrame };
const win = { isDestroyed: () => false, webContents, getNativeWindowHandle: () => Buffer.alloc(8) } as unknown as BrowserWindow;
const fromMain = { sender: webContents, senderFrame: mainFrame };
const fromElsewhere = { sender: {}, senderFrame: {} };

let rpc: ReturnType<typeof vi.fn>;
beforeEach(() => {
  handlers.clear();
  rpc = vi.fn(async () => ({ listener: 'a2a', verdict: 'unknown', applicable: false, platform: 'other' }));
  registerNetFirewallHandlers(() => ({ rpc, isConnected: true }) as unknown as DaemonClient, () => win);
});

describe('netFirewall IPC', () => {
  it('registers its channels', () => {
    for (const c of [IPC.NET_FIREWALL_STATUS, IPC.NET_FIREWALL_FIX, IPC.NET_FIREWALL_REMOVE, IPC.NET_FIREWALL_OPEN, IPC.NET_LISTEN_PROBLEM]) {
      expect(handlers.has(c), c).toBe(true);
    }
  });

  it('status passes through to the daemon probe; fresh asks for a probe that starts now', async () => {
    const s = (await handler(IPC.NET_FIREWALL_STATUS)(fromMain, 'a2a')) as { elevation: string };
    expect(rpc).toHaveBeenCalledWith('net.inboundStatus', { listener: 'a2a' }, { timeoutMs: 12_000 });
    expect(s.elevation).toBe('consent');
    await handler(IPC.NET_FIREWALL_STATUS)(fromMain, 'a2a', true);
    expect(rpc).toHaveBeenLastCalledWith('net.inboundStatus', { listener: 'a2a', fresh: true }, { timeoutMs: 12_000 });
  });

  it('status and the listen problem answer only the main window\'s top frame', async () => {
    await expect(handler(IPC.NET_FIREWALL_STATUS)(fromElsewhere, 'a2a')).rejects.toThrow(/main window/);
    await expect(handler(IPC.NET_LISTEN_PROBLEM)(fromElsewhere, 'a2a')).rejects.toThrow(/main window/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('an unknown listener never reaches the daemon', async () => {
    await expect(handler(IPC.NET_FIREWALL_STATUS)(fromMain, 'ssh')).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('Fix, Remove and Open answer only the main window\'s top frame', async () => {
    expect(await handler(IPC.NET_FIREWALL_FIX)(fromElsewhere, 'a2a')).toEqual({ outcome: { kind: 'refused', refusal: 'changed' }, status: null });
    expect(await handler(IPC.NET_FIREWALL_REMOVE)(fromElsewhere, 'a2a')).toEqual({ outcome: { kind: 'refused', refusal: 'changed' }, status: null });
    expect(await handler(IPC.NET_FIREWALL_OPEN)(fromElsewhere, 'network')).toEqual({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a Fix with no check shown first is refused before any elevation', async () => {
    expect(await handler(IPC.NET_FIREWALL_FIX)(fromMain, 'web')).toEqual({ outcome: { kind: 'refused', refusal: 'changed' }, status: null });
  });

  it('Open accepts only the two targets', async () => {
    expect(await handler(IPC.NET_FIREWALL_OPEN)(fromMain, 'https://example.com')).toEqual({ ok: false });
    expect(shell.openExternal).not.toHaveBeenCalledWith('https://example.com');
  });

  it('Open refuses any page that is not one of the listed Settings pages, on every platform', async () => {
    shell.openExternal.mockClear();
    for (const page of ['https://example.com', 'ms-settings:windowsupdate', 'ms-settings:network-wifi?x=1', 'MS-SETTINGS:network-wifi', 'file:///C:/Windows/System32/cmd.exe', null, 7]) {
      expect(await handler(IPC.NET_FIREWALL_OPEN)(fromMain, 'network', page), String(page)).toEqual({ ok: false });
    }
    // A page belongs to network settings only.
    expect(await handler(IPC.NET_FIREWALL_OPEN)(fromMain, 'firewall', 'ms-settings:network-status')).toEqual({ ok: false });
    expect(await handler(IPC.NET_FIREWALL_OPEN)(fromElsewhere, 'network', 'ms-settings:network-wifi')).toEqual({ ok: false });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe('openTarget', () => {
  it('on Windows, exactly the three Settings pages', () => {
    for (const page of ['ms-settings:network-status', 'ms-settings:network-wifi', 'ms-settings:network-ethernet']) {
      expect(openTarget('network', page, 'win32')).toEqual({ kind: 'network', page });
    }
    for (const page of ['ms-settings:windowsupdate', 'ms-settings:network-wifi ', 'https://example.com', '', null]) {
      expect(openTarget('network', page, 'win32'), String(page)).toBeNull();
    }
  });

  it('a page is Windows only; the two plain targets stay as they were', () => {
    expect(openTarget('network', 'ms-settings:network-wifi', 'darwin')).toBeNull();
    expect(openTarget('network', 'ms-settings:network-wifi', 'linux')).toBeNull();
    expect(openTarget('network', undefined, 'darwin')).toEqual({ kind: 'network' });
    expect(openTarget('firewall', undefined, 'win32')).toEqual({ kind: 'firewall' });
    expect(openTarget('firewall', 'ms-settings:network-status', 'win32')).toBeNull();
    expect(openTarget('ms-settings:network-wifi', undefined, 'win32')).toBeNull();
  });
});
