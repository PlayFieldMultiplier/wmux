/**
 * WEB_TAILSCALE_CHECK / WEB_TAILSCALE_OPEN — the Remote page's Tailscale
 * checklist and its buttons.
 *
 * The check is read-only (one `tailscale status --json`), and the open action
 * takes a target name, never a path or URL from the renderer: it opens
 * Tailscale's download page or brings the app forward, and nothing else.
 */
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
  return { ipcMain, __handlers: handlers };
});

import * as electron from 'electron';
import { registerWebHandlers, type TailscaleOpener } from '../web.handler';
import { IPC } from '../../../../shared/constants';
import { TAILSCALE_DOWNLOAD_URL, type TailscaleChecklist, type TailscaleExec } from '../../../../cli/tailscale';
import type { WebTailscaleOpenResult } from '../../../../shared/web';

const handlers = (electron as unknown as { __handlers: Map<string, (...a: unknown[]) => unknown> }).__handlers;

let calls: string[][];
let opener: { openExternal: ReturnType<typeof vi.fn>; launch: ReturnType<typeof vi.fn>; exists: ReturnType<typeof vi.fn> };

const exec: TailscaleExec = async (_cmd, args) => {
  calls.push(args);
  return { stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' };
};

function register(launchOk = true): void {
  opener = {
    openExternal: vi.fn(async () => undefined),
    launch: vi.fn(async () => launchOk),
    exists: vi.fn(async () => true),
  };
  registerWebHandlers(() => null, exec, opener as unknown as TailscaleOpener);
}

const invoke = <T>(channel: string, arg?: unknown) => handlers.get(channel)!({}, arg) as Promise<T>;

beforeEach(() => {
  calls = [];
});

describe('WEB_TAILSCALE_CHECK', () => {
  it('reads `status --json` once and opens nothing', async () => {
    register();
    const list = await invoke<TailscaleChecklist>(IPC.WEB_TAILSCALE_CHECK, { peer: 'desk.tail1.ts.net' });
    expect(list.items.find((i) => i.state === 'fail')).toMatchObject({ id: 'signed-in', fix: 'sign-in' });
    expect(calls).toEqual([['status', '--json']]);
    expect(opener.openExternal).not.toHaveBeenCalled();
    expect(opener.launch).not.toHaveBeenCalled();
  });
});

describe('WEB_TAILSCALE_OPEN', () => {
  it('download opens the official download page, and runs no tailscale command', async () => {
    register();
    expect(await invoke<WebTailscaleOpenResult>(IPC.WEB_TAILSCALE_OPEN, 'download')).toEqual({ ok: true, opened: 'download' });
    expect(opener.openExternal).toHaveBeenCalledWith(TAILSCALE_DOWNLOAD_URL);
    expect(calls).toEqual([]);
  });

  it('app brings the app forward; with no app to open, the download page instead', async () => {
    if (process.platform === 'linux') return; // no app on Linux: covered by tailscaleAppLaunch's test
    register(true);
    expect(await invoke<WebTailscaleOpenResult>(IPC.WEB_TAILSCALE_OPEN, 'app')).toEqual({ ok: true, opened: 'app' });
    expect(opener.launch).toHaveBeenCalledTimes(1);
    expect(opener.launch.mock.calls[0][0]).not.toMatch(/^tailscale(\.exe)?$/);
    expect(opener.openExternal).not.toHaveBeenCalled();

    register(false);
    expect(await invoke<WebTailscaleOpenResult>(IPC.WEB_TAILSCALE_OPEN, 'app')).toEqual({ ok: true, opened: 'download' });
    expect(opener.openExternal).toHaveBeenCalledWith(TAILSCALE_DOWNLOAD_URL);
    expect(calls).toEqual([]);
  });

  it('refuses anything but the two target names (no path, no URL, no command)', async () => {
    register();
    for (const bad of ['up', 'https://example.invalid', '/Applications/Other.app', { target: 'app' }, null]) {
      expect(await invoke<WebTailscaleOpenResult>(IPC.WEB_TAILSCALE_OPEN, bad)).toEqual({ ok: false, opened: null });
    }
    expect(opener.openExternal).not.toHaveBeenCalled();
    expect(opener.launch).not.toHaveBeenCalled();
  });
});
