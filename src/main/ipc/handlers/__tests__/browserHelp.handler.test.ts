import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { IPC } from '../../../../shared/constants';
import { registerBrowserHelpIpc } from '../browserHelp.handler';
import { UNTRUSTED_SENDER_ERROR } from '../browserPolicy.handler';

function setup() {
  const mainFrame = { id: 'main-frame' };
  const webContents = { mainFrame, isDestroyed: () => false };
  const win = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
  const requests = { resolveFromRenderer: vi.fn(async () => true) };
  registerBrowserHelpIpc({ handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never, {
    getWindow: () => win,
    requests,
  });
  const trusted = { sender: webContents, senderFrame: mainFrame };
  const guest = { sender: { mainFrame: { id: 'g' } }, senderFrame: { id: 'g' } };
  const call = (event: unknown, payload?: unknown) => handlers.get(IPC.BROWSER_HELP_RESOLVE)?.(event, payload);
  return { call, trusted, guest, requests };
}

describe('browser help resolve IPC', () => {
  it('settles a request from the main window and ignores any other sender', async () => {
    const { call, trusted, guest, requests } = setup();
    await expect(call(guest, { requestId: 'req-1', outcome: 'continued' }))
      .resolves.toEqual({ ok: false, error: UNTRUSTED_SENDER_ERROR });
    expect(requests.resolveFromRenderer).not.toHaveBeenCalled();

    await expect(call(trusted, { requestId: 'req-1', outcome: 'continued' })).resolves.toEqual({ ok: true });
    expect(requests.resolveFromRenderer).toHaveBeenCalledWith('req-1', 'continued');
  });
});
