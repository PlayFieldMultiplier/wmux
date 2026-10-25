import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopPhoneBridge, keepAwakeRpc } from '../DesktopPhoneBridge';

afterEach(() => vi.useRealTimers());
describe('desktop phone request ownership', () => {
  it('accepts only the registered owner and consumes a receipt once', async () => {
    const send = vi.fn(() => true);
    const bridge = new DesktopPhoneBridge(send);
    expect(bridge.register('main')).toBe(true);
    expect(bridge.register('other')).toBe(false);
    const pending = bridge.request('accounts.list', { workspaceId: 'ws-1' });
    const event = send.mock.calls[0] as unknown as [string, { data: { requestId: string } }];
    const response = { requestId: event[1].data.requestId, ok: true, result: { accounts: [] } };
    expect(bridge.complete('other', response)).toBe(false);
    expect(bridge.complete('main', response)).toBe(true);
    expect(bridge.complete('main', response)).toBe(false);
    await expect(pending).resolves.toEqual({ accounts: [] });
  });
  it('rejects pending requests on owner disconnect and permits a replacement', async () => {
    const bridge = new DesktopPhoneBridge(() => true);
    bridge.register('main');
    const pending = bridge.request('accounts.bind', {});
    const rejected = expect(pending).rejects.toThrow('desktop-disconnected');
    bridge.disconnect('other');
    expect(bridge.available).toBe(true);
    bridge.disconnect('main');
    await rejected;
    expect(bridge.available).toBe(false);
    expect(bridge.register('replacement')).toBe(true);
  });
  it('bounds concurrency and expires requests without retries', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => true);
    const bridge = new DesktopPhoneBridge(send, 100);
    bridge.register('main');
    const requests = Array.from({ length: 16 }, () => bridge.request('accounts.list', {}).catch(e => e.message));
    await expect(bridge.request('accounts.list', {})).rejects.toThrow('desktop-busy');
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all(requests)).toEqual(Array(16).fill('desktop-timeout'));
    expect(send).toHaveBeenCalledTimes(16);
  });
  it('fails closed without a desktop owner', async () => {
    await expect(new DesktopPhoneBridge(() => true).request('accounts.list', {})).rejects.toThrow('desktop-unavailable');
  });
});
describe('keep the computer awake', () => {
  it('holds the registered desktop\'s report only, and forgets it with the desktop', () => {
    const bridge = new DesktopPhoneBridge(() => true);
    expect(bridge.setKeepAwake('main', { mode: 'working', active: true })).toBe(false);
    bridge.register('main');
    expect(bridge.keepAwake).toBeNull();
    expect(bridge.setKeepAwake('other', { mode: 'always', active: true })).toBe(false);
    expect(bridge.setKeepAwake('main', { mode: 'sometimes', active: true })).toBe(false);
    expect(bridge.setKeepAwake('main', { mode: 'working', active: 'yes' })).toBe(false);
    expect(bridge.setKeepAwake('main', { mode: 'working', active: true, extra: 1 })).toBe(true);
    expect(bridge.keepAwake).toEqual({ mode: 'working', active: true });
    bridge.disconnect('main');
    expect(bridge.keepAwake).toBeNull();
    bridge.register('next');
    expect(bridge.keepAwake).toBeNull();
  });
  it('tells only the registered desktop whether a phone is attached', () => {
    const send = vi.fn(() => true);
    const bridge = new DesktopPhoneBridge(send);
    expect(bridge.notifyPhonePresence(true)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    bridge.register('main');
    expect(bridge.notifyPhonePresence(true)).toBe(true);
    expect(send).toHaveBeenCalledWith('main', { type: 'phone.presence', sessionId: '', data: { attached: true } });
  });
  it('daemon.phone.keepAwake is first-party only', async () => {
    const bridge = new DesktopPhoneBridge(() => true);
    bridge.register('main');
    const firstParty = new Set<string>();
    const rpc = keepAwakeRpc(bridge, (id) => firstParty.has(id));
    // The registered owner, but not classified first-party (an MCP server or CLI on the same pipe).
    expect(await rpc({ mode: 'always', active: true }, { clientId: 'main' })).toEqual({ ok: false });
    expect(bridge.keepAwake).toBeNull();
    firstParty.add('main');
    expect(await rpc({ mode: 'always', active: true }, { clientId: 'main' })).toEqual({ ok: true });
    expect(bridge.keepAwake).toEqual({ mode: 'always', active: true });
  });
});
