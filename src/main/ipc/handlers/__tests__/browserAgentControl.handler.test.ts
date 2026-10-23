import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { BROWSER_AGENT_CONTROL_IPC } from '../../../../shared/browserAgentControl';
import { registerBrowserAgentControlIpc } from '../browserAgentControl.handler';
import { UNTRUSTED_SENDER_ERROR } from '../browserPolicy.handler';
import { BrowserAgentControl } from '../../../browser-session/BrowserAgentControl';

function setup() {
  const mainFrame = { id: 'main-frame' };
  const webContents = { mainFrame, isDestroyed: () => false };
  const win = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
  const cancelInFlight = vi.fn();
  const control = new BrowserAgentControl({ emit: () => undefined, cancelInFlight });
  const live = {
    list: vi.fn(async () => [{ surfaceId: 'T1', title: 'Mail', url: 'https://mail.test/' }]),
    returnTab: vi.fn(() => true),
  };
  registerBrowserAgentControlIpc({ handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never, {
    getWindow: () => win,
    control,
    live,
  });
  const trusted = { sender: webContents, senderFrame: mainFrame };
  const guest = { sender: { mainFrame: { id: 'g' } }, senderFrame: { id: 'g' } };
  const call = (channel: string, event: unknown, payload?: unknown) => handlers.get(channel)!(event, payload);
  return { call, trusted, guest, control, live, cancelInFlight };
}

describe('browser agent control IPC', () => {
  it('applies the user\'s intents and lists the held tabs', async () => {
    const { call, trusted, cancelInFlight } = setup();
    await expect(call(BROWSER_AGENT_CONTROL_IPC.intent, trusted, { surfaceId: 's1', intent: 'stop' }))
      .resolves.toEqual({ ok: true, changed: true, state: { surfaceId: 's1', active: false, mode: 'paused' } });
    expect(cancelInFlight).toHaveBeenCalledWith('s1', expect.any(Error));
    await expect(call(BROWSER_AGENT_CONTROL_IPC.list, trusted)).resolves.toEqual([
      { surfaceId: 's1', active: false, mode: 'paused' },
    ]);
    await expect(call(BROWSER_AGENT_CONTROL_IPC.intent, trusted, { surfaceId: 's1', intent: 'resume' }))
      .resolves.toMatchObject({ ok: true, state: { mode: 'agent' } });
  });

  it('answers only the main window: a page cannot lift a pause or a take-over', async () => {
    const { call, trusted, guest, control } = setup();
    await call(BROWSER_AGENT_CONTROL_IPC.intent, trusted, { surfaceId: 's1', intent: 'takeOver' });
    await expect(call(BROWSER_AGENT_CONTROL_IPC.intent, guest, { surfaceId: 's1', intent: 'handBack' }))
      .resolves.toEqual({ ok: false, error: UNTRUSTED_SENDER_ERROR });
    expect(control.get('s1').mode).toBe('user');
    await expect(call(BROWSER_AGENT_CONTROL_IPC.list, guest)).resolves.toEqual([]);
  });

  it('refuses a malformed intent', async () => {
    const { call, trusted } = setup();
    await expect(call(BROWSER_AGENT_CONTROL_IPC.intent, trusted, { surfaceId: 's1', intent: 'grant' }))
      .resolves.toEqual({ ok: false, error: 'invalid payload' });
  });

  it('Return to me hands the lent tab back through returnTab, for the main window only', async () => {
    const { call, trusted, guest, live } = setup();
    await expect(call(BROWSER_AGENT_CONTROL_IPC.lentTabs, trusted, { workspaceId: 'ws-1' }))
      .resolves.toEqual({ ok: true, tabs: [{ surfaceId: 'T1', title: 'Mail', url: 'https://mail.test/' }] });
    await expect(call(BROWSER_AGENT_CONTROL_IPC.returnTab, trusted, { workspaceId: 'ws-1', surfaceId: 'T1' }))
      .resolves.toEqual({ ok: true, returned: true });
    expect(live.returnTab).toHaveBeenCalledWith('ws-1', 'T1');
    await expect(call(BROWSER_AGENT_CONTROL_IPC.returnTab, guest, { workspaceId: 'ws-1', surfaceId: 'T1' }))
      .resolves.toEqual({ ok: false, error: UNTRUSTED_SENDER_ERROR });
    expect(live.returnTab).toHaveBeenCalledTimes(1);
  });
});
