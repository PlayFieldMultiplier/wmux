// `rpc:invoke` answers only the main window's top frame: a subframe of the
// main window, another window, a destroyed or missing window, or an event
// with no frame is refused and nothing is dispatched.
import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { createRpcInvokeHandler, RPC_INVOKE_NOT_MAIN_WINDOW } from '../rpcInvoke';

function setup(opts: { destroyed?: boolean; noWindow?: boolean; wired?: boolean } = {}) {
  const mainFrame = { name: 'top' };
  const webContents = { id: 1, mainFrame };
  const win = { isDestroyed: () => opts.destroyed === true, webContents } as unknown as BrowserWindow;
  const run = vi.fn(async (method: string, params: Record<string, unknown>) => ({ ok: true, method, params }));
  const handler = createRpcInvokeHandler(() => (opts.noWindow ? null : win), () => (opts.wired === false ? undefined : run));
  return { handler, run, webContents, mainFrame };
}

describe('rpc:invoke', () => {
  it('dispatches for the main window\'s top frame, with object params only', async () => {
    const { handler, run, webContents, mainFrame } = setup();
    expect(await handler({ sender: webContents, senderFrame: mainFrame }, 'workspace.list', { a: 1 }))
      .toEqual({ ok: true, method: 'workspace.list', params: { a: 1 } });
    await handler({ sender: webContents, senderFrame: mainFrame }, 'workspace.list', 'not-an-object');
    expect(run).toHaveBeenLastCalledWith('workspace.list', {});
  });

  it('refuses a subframe, another window, a missing frame, or no main window, and dispatches nothing', async () => {
    const { handler, run, webContents, mainFrame } = setup();
    const otherContents = { id: 2, mainFrame: { name: 'other-top' } };
    for (const event of [
      { sender: webContents, senderFrame: { name: 'plugin-iframe' } },
      { sender: otherContents, senderFrame: otherContents.mainFrame },
      { sender: otherContents, senderFrame: mainFrame },
      { sender: webContents },
      {},
    ]) {
      expect(await handler(event, 'workspace.list', {})).toEqual(RPC_INVOKE_NOT_MAIN_WINDOW);
    }
    expect(await setup({ noWindow: true }).handler({ sender: webContents, senderFrame: mainFrame }, 'workspace.list', {}))
      .toEqual(RPC_INVOKE_NOT_MAIN_WINDOW);
    const destroyed = setup({ destroyed: true });
    expect(await destroyed.handler({ sender: destroyed.webContents, senderFrame: destroyed.mainFrame }, 'workspace.list', {}))
      .toEqual(RPC_INVOKE_NOT_MAIN_WINDOW);
    expect(destroyed.run).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('still refuses a missing method and an unwired bridge', async () => {
    const { handler, webContents, mainFrame } = setup();
    expect(await handler({ sender: webContents, senderFrame: mainFrame }, '', {})).toMatchObject({ ok: false, error: /missing method/ });
    const unwired = setup({ wired: false });
    expect(await unwired.handler({ sender: unwired.webContents, senderFrame: unwired.mainFrame }, 'x', {})).toMatchObject({ ok: false, error: /not wired/ });
  });
});
