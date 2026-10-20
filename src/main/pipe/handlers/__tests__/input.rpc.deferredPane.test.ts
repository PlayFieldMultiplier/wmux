// #2398 (owner decision §6-6) — a raw terminal write to a pane whose shell
// has not started starts it (surface.ensurePty, in the renderer) and then
// writes; a read never starts it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { PTYManager } from '../../../pty/PTYManager';
import { WSL_RPC_TIMEOUT_MS } from '../../../../shared/wsl';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;
const DEFERRED_READ = { ptyId: '', text: '', deferred: true, deferredSurfaceId: 'surf-blank' };

function setup(): { router: RpcRouter; writeMock: ReturnType<typeof vi.fn> } {
  const writeMock = vi.fn();
  const pty = { get: vi.fn(() => ({ id: 'x' })), write: writeMock } as unknown as PTYManager;
  const router = new RpcRouter();
  registerInputRpc(router, pty, () => fakeWindow);
  return { router, writeMock };
}

/** The renderer: the caller's active pane has not started; ensurePty starts it. */
function renderer(ensure: () => unknown = () => ({ ptyId: 'pty-started' })): void {
  sendToRendererMock.mockImplementation((_w: unknown, method: string, params?: { ptyId?: string }) => {
    if (method === 'input.readScreen') return Promise.resolve(params?.ptyId ? { ptyId: params.ptyId, text: '' } : DEFERRED_READ);
    if (method === 'surface.ensurePty') return Promise.resolve(ensure());
    if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-ext' });
    return Promise.resolve(null);
  });
}

const ensureCalls = () => sendToRendererMock.mock.calls.filter((c: unknown[]) => c[1] === 'surface.ensurePty');

describe('a raw write to a pane that has not started (#2398)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('input.send to the active pane starts it once, then writes to the new pty', async () => {
    renderer();
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '1', method: 'input.send', params: { text: 'echo hi', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(true);
    expect(ensureCalls()).toHaveLength(1);
    expect(ensureCalls()[0][2]).toEqual({ surfaceId: 'surf-blank', workspaceId: 'ws-ext' });
    // A WSL create may take its whole budget: the ask must not time out first.
    expect((ensureCalls()[0][3] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(WSL_RPC_TIMEOUT_MS);
    expect(writeMock).toHaveBeenCalledWith('pty-started', expect.any(String));
    expect(writeMock.mock.calls.every(([id]) => id === 'pty-started')).toBe(true);
  });

  it('input.sendKey to the active pane starts it once, then sends the key', async () => {
    renderer();
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '2', method: 'input.sendKey', params: { key: 'ctrl+l', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(true);
    expect(ensureCalls()).toHaveLength(1);
    expect(writeMock).toHaveBeenCalledWith('pty-started', '\x0c');
  });

  it('input.send with a surfaceId (a pane name that has not started) starts that surface', async () => {
    renderer();
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '3', method: 'input.send', params: { text: 'x', surfaceId: 'surf-named', workspaceId: 'ws-ext', senderPtyId: 'pty-self' } });
    expect(res.ok).toBe(true);
    expect(ensureCalls()[0][2]).toEqual({ surfaceId: 'surf-named', workspaceId: 'ws-ext' });
    expect(writeMock).toHaveBeenCalledWith('pty-started', expect.any(String));
  });

  it('a surfaceId without the caller workspace is refused before anything starts', async () => {
    renderer();
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '4', method: 'input.send', params: { text: 'x', surfaceId: 'surf-named' } });
    expect(res.ok).toBe(false);
    expect(ensureCalls()).toHaveLength(0);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('a refused start writes nothing and says why', async () => {
    renderer(() => ({ error: 'the terminal could not start: session cap reached' }));
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '5', method: 'input.send', params: { text: 'x', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('session cap reached');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('terminal.readEvents on it reads nothing and starts nothing', async () => {
    renderer();
    const { router } = setup();
    const res = await router.dispatch({ id: '6', method: 'terminal.readEvents', params: { workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('has not started yet');
    expect(ensureCalls()).toHaveLength(0);
  });

  it('input.readScreen passes the deferred report through and starts nothing', async () => {
    renderer();
    const { router } = setup();
    const res = await router.dispatch({ id: '7', method: 'input.readScreen', params: { workspaceId: 'ws-ext' } });
    expect(res).toMatchObject({ ok: true, result: DEFERRED_READ });
    expect(ensureCalls()).toHaveLength(0);
  });
});
