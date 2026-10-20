// #2398 (owner decision §6-6) — a raw terminal write to a pane whose shell
// has not started starts it (surface.ensurePty, in the renderer) and then
// writes; a read never starts it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { PTYManager } from '../../../pty/PTYManager';
import { WSL_RPC_TIMEOUT_MS } from '../../../../shared/wsl';
import { TERMINAL_START_BUDGET_MS, TERMINAL_WRITE_DELIVERY_BUDGET_MS, terminalWriteClientTimeoutMs } from '../../../../shared/terminalWriteBudget';
import { mintCommanderToken, __resetCommanderTrustForTesting } from '../../../deck/commanderTrust';

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

// A daemon session main holds no writable pipe to (a hidden pane's session
// left suspended, or one whose pane is not mounted at all) cannot take a
// write: a raw write by ptyId attaches it first, after the access check,
// through the renderer, and is written only once the pipe is open.
describe('a raw write by ptyId to a session with no pipe (#2398)', () => {
  beforeEach(() => vi.clearAllMocks());

  /** A daemon client whose pipe opens when the renderer attaches the session. */
  function setupDaemon(opts: { pipeOpen: boolean; attachOpensPipe?: boolean; writeReturns?: boolean }) {
    let pipeOpen = opts.pipeOpen;
    const writeToSession = vi.fn(() => opts.writeReturns ?? pipeOpen);
    const dc = { isConnected: true, isSessionPipeWritable: vi.fn(() => pipeOpen), writeToSession };
    const pty = { get: vi.fn(() => undefined), write: vi.fn() } as unknown as PTYManager;
    const router = new RpcRouter();
    registerInputRpc(router, pty, () => fakeWindow, () => dc as never);
    const attach = () => {
      if (opts.attachOpensPipe !== false) pipeOpen = true;
      return { ptyId: 'pty-suspended' };
    };
    return { router, writeToSession, attach };
  }

  it('attaches it through the renderer, after the ownership check, then sends the key', async () => {
    const { router, writeToSession, attach } = setupDaemon({ pipeOpen: false });
    renderer(attach);
    const res = await router.dispatch({ id: '8', method: 'input.sendKey', params: { key: 'ctrl+l', ptyId: 'pty-suspended', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(true);
    const methods = sendToRendererMock.mock.calls.map((c: unknown[]) => c[1]);
    expect(methods.indexOf('input.findOwnerWorkspace')).toBeLessThan(methods.indexOf('surface.ensurePty'));
    expect(ensureCalls()[0][2]).toEqual({ ptyId: 'pty-suspended' });
    expect(writeToSession).toHaveBeenCalledWith('pty-suspended', '\x0c');
  });

  it('a session with a live pipe is written as before, with no renderer start', async () => {
    const { router, writeToSession } = setupDaemon({ pipeOpen: true });
    renderer();
    const res = await router.dispatch({ id: '9', method: 'input.sendKey', params: { key: 'ctrl+l', ptyId: 'pty-live', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(true);
    expect(ensureCalls()).toHaveLength(0);
    expect(writeToSession).toHaveBeenCalledWith('pty-live', '\x0c');
  });

  // Review P2: the renderer answered without attaching (no pane mounted, no
  // mark), the pipe stayed shut, writeToSession returned false — and the tool
  // reported success for input that was dropped.
  it('a session still without a pipe after the attach is refused with nothing written', async () => {
    const { router, writeToSession, attach } = setupDaemon({ pipeOpen: false, attachOpensPipe: false });
    renderer(attach);
    const calls: Array<['input.send' | 'input.sendKey', Record<string, unknown>]> = [
      ['input.sendKey', { key: 'ctrl+l', ptyId: 'pty-suspended', workspaceId: 'ws-ext' }],
      ['input.send', { text: 'echo hi', ptyId: 'pty-suspended', workspaceId: 'ws-ext' }],
    ];
    for (const [method, params] of calls) {
      const res = await router.dispatch({ id: method, method, params });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain('nothing was written');
    }
    expect(writeToSession).not.toHaveBeenCalled();
  });

  it('a write no pipe takes is never answered as delivered', async () => {
    const { router } = setupDaemon({ pipeOpen: true, writeReturns: false });
    renderer();
    const key = await router.dispatch({ id: '10', method: 'input.sendKey', params: { key: 'ctrl+l', ptyId: 'pty-gone', workspaceId: 'ws-ext' } });
    expect(key.ok).toBe(false);
    expect(JSON.stringify(key)).toContain('not delivered');
    const text = await router.dispatch({ id: '11', method: 'input.send', params: { text: 'echo hi', ptyId: 'pty-gone', workspaceId: 'ws-ext' } });
    expect(text.ok).toBe(false);
    expect(JSON.stringify(text)).toContain('not delivered');
  });
});

// Review P2: the MCP client gave a write its 10 s default while main waited up
// to a WSL create's budget for the pane to start; main then wrote after the
// client had reported a timeout, and a retry ran the command twice.
describe('the start phase of a raw write has one budget (#2398)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('gives the start only the shared budget, and the client waits for it plus the delivery', async () => {
    renderer();
    const { router } = setup();
    await router.dispatch({ id: '12', method: 'input.send', params: { text: 'x', workspaceId: 'ws-ext' } });
    const startWait = (ensureCalls()[0][3] as { timeoutMs: number }).timeoutMs;
    expect(startWait).toBeLessThanOrEqual(TERMINAL_START_BUDGET_MS);
    expect(startWait).toBeGreaterThan(WSL_RPC_TIMEOUT_MS);
    expect(terminalWriteClientTimeoutMs()).toBeGreaterThanOrEqual(TERMINAL_START_BUDGET_MS + TERMINAL_WRITE_DELIVERY_BUDGET_MS);
  });

  it("a start that outlasts the budget writes nothing, so the caller's retry is the only write", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    renderer(() => {
      vi.setSystemTime(Date.now() + TERMINAL_START_BUDGET_MS + 1);
      return { ptyId: 'pty-started' };
    });
    const { router, writeMock } = setup();
    const res = await router.dispatch({ id: '13', method: 'input.send', params: { text: 'echo once', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('nothing was written');
    expect(writeMock).not.toHaveBeenCalled();
  });
});

// Review P2: a commander's or bot's write to a named pane that has not started
// in one of its open task workspaces: authorized by the surface's owner under
// the same lanes as a pty, before anything starts.
describe('a raw write by surface follows the pty lanes (#2398)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => __resetCommanderTrustForTesting());

  /** The surface (and the pty it starts) live in `owner`. */
  function rendererOwning(owner: string) {
    sendToRendererMock.mockImplementation((_w: unknown, method: string, params?: { ptyId?: string }) => {
      if (method === 'surface.ensurePty') return Promise.resolve({ ptyId: 'pty-task' });
      if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: owner });
      if (method === 'input.readScreen') return Promise.resolve({ ptyId: params?.ptyId ?? '', text: '' });
      return Promise.resolve(null);
    });
  }

  function setupWithLedger(taskWorkspaces: string[]) {
    const writeMock = vi.fn();
    const pty = { get: vi.fn(() => ({ id: 'x' })), write: writeMock } as unknown as PTYManager;
    const router = new RpcRouter();
    const ledger = { list: () => taskWorkspaces.map((taskWorkspaceId) => ({ ownerWorkspaceId: 'ws-commander', taskWorkspaceId, status: 'working' })) };
    registerInputRpc(router, pty, () => fakeWindow, undefined, undefined, undefined, { getLedger: () => ledger as never });
    return { router, writeMock };
  }

  it('a commander starts a surface of its open task workspace, in that workspace, then writes', async () => {
    rendererOwning('ws-task');
    const { router, writeMock } = setupWithLedger(['ws-task']);
    const token = mintCommanderToken('ws-commander');
    const res = await router.dispatch({ id: '14', method: 'input.sendKey', params: { key: 'ctrl+c', surfaceId: 'surf-task', workspaceId: 'ws-commander' }, commanderToken: token } as never);
    expect(res.ok).toBe(true);
    expect(ensureCalls()[0][2]).toEqual({ surfaceId: 'surf-task', workspaceId: 'ws-task' });
    expect(writeMock).toHaveBeenCalledWith('pty-task', '\x03');
  });

  it('a surface of a workspace the caller has no lane to is refused before anything starts', async () => {
    rendererOwning('ws-other');
    const { router, writeMock } = setupWithLedger([]);
    const res = await router.dispatch({ id: '15', method: 'input.send', params: { text: 'x', surfaceId: 'surf-other', workspaceId: 'ws-ext' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain('Cross-workspace terminal access is not allowed');
    expect(ensureCalls()).toHaveLength(0);
    expect(writeMock).not.toHaveBeenCalled();
  });
});
