import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  notify: vi.fn(),
  sendToRenderer: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: mocks.sendToRenderer }));
vi.mock('../../notification/dispatchNotification', () => ({ dispatchNotification: mocks.notify }));
vi.mock('../../ipc/handlers/metadata.handler', () => ({
  updateCwd: vi.fn(), removeCwd: vi.fn(), updateBranch: vi.fn(), removeBranch: vi.fn(),
  broadcastMetadataUpdate: mocks.metadata,
  getLastBroadcastAgentStatus: () => undefined,
  clearLastBroadcastAgentStatus: () => undefined,
}));

import { PTYBridge } from '../PTYBridge';
import type { PTYInstance, PTYManager } from '../PTYManager';
import { RpcRouter } from '../../pipe/RpcRouter';
import { registerHooksRpc } from '../../pipe/handlers/hooks.rpc';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';
import type { DaemonClient } from '../../DaemonClient';
import { eventBus } from '../../events/EventBus';
import { CompletionAlarm, DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import type { AgentSignal, HookSignalResponse } from '../../../shared/hooks/signal-types';

const workspaces = [{ id: 'ws-1', name: 'one', metadata: { cwd: '/repo' }, activePtyId: 'pty-1', ptyIds: ['pty-1'] }];
const cleanups: Array<() => void> = [];

function rig(daemon?: DaemonClient) {
  let output: (data: string) => void = () => undefined;
  const instance = {
    id: 'pty-1', workspaceId: 'ws-1', shell: 'bash',
    process: { onData: (cb: typeof output) => { output = cb; }, onExit: () => undefined },
  } as unknown as PTYInstance;
  const instances = new Map([['pty-1', instance]]);
  const manager = {
    get: (id: string) => instances.get(id),
    remove: (id: string) => instances.delete(id),
    onDispose: () => undefined,
  } as unknown as PTYManager;
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  const hookRouter = {
    recordHook: vi.fn(() => 'emit'), recordDetector: vi.fn(() => 'emit'),
    touchAuthority: vi.fn(), notePromptSubmit: vi.fn(), noteSessionStart: vi.fn(), dropPty: vi.fn(),
    isGovernedFor: () => false, governsDetectorStatus: () => false, governsRunningState: () => false,
    getLatencyMeter: () => ({
      recordSignal: vi.fn(), recordWorkspaceMatch: vi.fn(),
      onStatsChange: () => () => undefined, getStats: () => ({}),
    }),
  } as unknown as HookSignalRouter;
  const alarm = new CompletionAlarm({ onConfirmed: (_pane, _slug, _cls, resume) => resume() });
  const bridge = new PTYBridge(manager, () => win, () => hookRouter, () => alarm);
  bridge.setupDataForwarding('pty-1');
  // Hook event time must be strictly after this PTY lifetime began.
  vi.advanceTimersByTime(1);
  const accepted = vi.fn((id: string, signal: AgentSignal) => bridge.noteAcceptedHook(id, signal));
  const rpc = new RpcRouter();
  const off = registerHooksRpc(rpc, () => win, hookRouter, () => daemon ?? null, undefined,
    () => ({ peek: () => ({ entries: workspaces, ageMs: 0 }) }), alarm, accepted);
  cleanups.push(() => { off(); bridge.cleanupInstance('pty-1'); alarm.dispose(); });
  const signal = (overrides: Partial<AgentSignal> = {}): AgentSignal => ({
    kind: 'agent.session_start', agent: 'agy', cwd: '/repo', ptyId: 'pty-1',
    workspaceId: 'ws-1', payload: {}, ts: Date.now(), ...overrides,
  });
  const dispatch = async (overrides: Partial<AgentSignal> = {}) => {
    const response = await rpc.dispatch({
      id: 'identity', method: 'hooks.signal', params: signal(overrides) as unknown as Record<string, unknown>,
    });
    if (!response.ok) throw new Error(response.error);
    return response.result as HookSignalResponse;
  };
  const feed = (text: string) => { output(text); vi.advanceTimersByTime(8); };
  const recreate = () => {
    bridge.cleanupInstance('pty-1');
    instances.set('pty-1', instance);
    bridge.setupDataForwarding('pty-1');
  };
  return { bridge, accepted, dispatch, signal, feed, output, hookRouter, recreate };
}

function detectorEvents() {
  return eventBus.poll(0, { types: ['agent.lifecycle'] }).events.filter((e) => 'source' in e && e.source === 'detector');
}

function expectNoDetectorStatus() {
  expect(detectorEvents()).toEqual([]);
  expect(mocks.metadata.mock.calls.some(([, update]) => update.agentStatus !== undefined)).toBe(false);
}

describe('local hook RPC → PTYBridge trusted screen identity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.clearAllMocks();
    eventBus.reset();
    mocks.sendToRenderer.mockResolvedValue(workspaces);
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.useRealTimers();
  });

  it('an accepted exact-pane session identifies bannerless agy without inventing a turn or alarm', async () => {
    const r = rig();
    r.feed('Do you trust the contents of this project?\n');
    expectNoDetectorStatus();
    expect((await r.dispatch()).ok).toBe(true);
    expect(r.accepted).toHaveBeenCalledOnce();
    expect(r.accepted.mock.results[0].value).toBe(true);
    expectNoDetectorStatus();
    expect(mocks.notify).not.toHaveBeenCalled();

    r.feed('Do you trust the contents of this project?\n');
    expect(mocks.metadata).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ptyId: 'pty-1', agentName: 'Antigravity CLI', agentStatus: 'awaiting_input',
    }));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(detectorEvents()).toHaveLength(1);
    expect(detectorEvents()[0]).toMatchObject({ agent: 'agy', kind: 'agent.awaiting_input', decision: 'emit' });
  });

  it('duplicate accepted identity alone never emits started, running or completion', async () => {
    const r = rig();
    const ts = Date.now();
    await r.dispatch({ ts });
    await r.dispatch({ ts });
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 2);
    expectNoDetectorStatus();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it.each([
    ['cwd fallback', { ptyId: undefined, workspaceId: undefined }],
    ['workspace fallback', { ptyId: undefined }],
    ['child tool', { kind: 'agent.tool_started', payload: { agent_id: 'child', agent_type: 'worker' } }],
    ['internal fork', { kind: 'agent.activity', payload: { agent_id: 'fork' } }],
    ['stop', { kind: 'agent.stop' }],
    ['failure', { kind: 'agent.stop_failure' }],
    ['subagent stop', { kind: 'agent.subagent_stop' }],
    ['answer', { kind: 'agent.input_answered' }],
  ] satisfies Array<[string, Partial<AgentSignal>]>)('%s cannot seed a bannerless profile', async (_name, overrides) => {
    const r = rig();
    await r.dispatch(overrides);
    expect(r.accepted).not.toHaveBeenCalled();
    mocks.metadata.mockClear();
    eventBus.reset();
    r.feed('Do you trust the contents of this project?\n');
    expectNoDetectorStatus();
  });

  it.each(['pty-gone', 'pty-other'])('a refused pane claim %s does not reach the identity callback', async (ptyId) => {
    const r = rig();
    const result = await r.dispatch({ ptyId });
    expect(result.ok).toBe(false);
    expect(r.accepted).not.toHaveBeenCalled();
  });

  it('a daemon-accepted hook is relayed without seeding the local fallback', async () => {
    const daemon = { isConnected: true, rpc: vi.fn(async () => ({ ok: true })) } as unknown as DaemonClient;
    const r = rig(daemon);
    expect((await r.dispatch()).ok).toBe(true);
    expect(daemon.rpc).toHaveBeenCalledOnce();
    expect(r.accepted).not.toHaveBeenCalled();
  });

  it('queued shell return wins over a delayed hook; fresh relaunch evidence can identify again', async () => {
    const r = rig();
    const oldTs = Date.now();
    await r.dispatch({ ts: oldTs });
    vi.advanceTimersByTime(10);
    // Do not advance the 8ms PTY batch: noteAcceptedHook must drain it first.
    r.output('\u001b]133;D;0\u0007\u001b]133;A\u0007');
    await r.dispatch({ ts: oldTs });
    expect(r.accepted.mock.results.at(-1)?.value).toBe(false);
    mocks.metadata.mockClear();
    eventBus.reset();
    r.feed('Do you trust the contents of this project?\n');
    expectNoDetectorStatus();
    // No cached authority is replayed when subsequent chunks arrive.
    r.feed('Do you trust the contents of this project?\n');
    expectNoDetectorStatus();

    await r.dispatch();
    expect(r.accepted.mock.results.at(-1)?.value).toBe(true);
    r.feed('Do you trust the contents of this project?\n');
    expect(mocks.metadata).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentStatus: 'awaiting_input' }));
  });

  it.each([-120_001, 1])('rejects a hook timestamp offset of %s ms without changing normal hook acceptance', async (offset) => {
    const r = rig();
    expect((await r.dispatch({ ts: Date.now() + offset })).ok).toBe(true);
    expect(r.accepted.mock.results.at(-1)?.value).toBe(false);
    mocks.metadata.mockClear();
    r.feed('Do you trust the contents of this project?\n');
    expectNoDetectorStatus();
  });

  it('an identity callback failure cannot fail the accepted hook', async () => {
    const r = rig();
    r.accepted.mockImplementationOnce(() => { throw new Error('detector unavailable'); });
    expect((await r.dispatch()).ok).toBe(true);
    expect(r.hookRouter.noteSessionStart).toHaveBeenCalledOnce();
  });

  it('a disposed local PTY cannot be reseeded by a delayed accepted hook', async () => {
    const r = rig();
    r.bridge.cleanupInstance('pty-1');
    await r.dispatch();
    expect(r.accepted.mock.results.at(-1)?.value).toBe(false);
  });

  it('a reused PTY id rejects the previous lifetime’s hook and accepts a fresh one', async () => {
    const r = rig();
    const oldTs = Date.now();
    await r.dispatch({ ts: oldTs });
    expect(r.accepted.mock.results.at(-1)?.value).toBe(true);
    vi.advanceTimersByTime(10);
    r.recreate();
    // Replacement finished before the callback begins; object equality
    // during flush alone cannot distinguish this old hook from the new PTY.
    await r.dispatch({ ts: oldTs });
    expect(r.accepted.mock.results.at(-1)?.value).toBe(false);
    mocks.metadata.mockClear();
    eventBus.reset();
    r.feed('Do you trust the contents of this project?\n');
    expectNoDetectorStatus();
    await r.dispatch();
    expect(r.accepted.mock.results.at(-1)?.value).toBe(true);
    r.feed('Do you trust the contents of this project?\n');
    expect(mocks.metadata).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentStatus: 'awaiting_input' }));
  });

  it.each(['disposed', 'replaced'] as const)('does not seed a detector %s by a callback while pending output flushes', async (change) => {
    const r = rig();
    r.bridge.addMiddleware('pty-1', () => {
      if (change === 'replaced') r.recreate();
      else r.bridge.cleanupInstance('pty-1');
    });
    r.output('pending output\n');
    await r.dispatch();
    // The callback must not acknowledge seeding the retired detector object.
    expect(r.accepted.mock.results.at(-1)?.value).toBe(false);
    mocks.metadata.mockClear();
    eventBus.reset();
    if (change === 'replaced') r.feed('Do you trust the contents of this project?\n');
    expectNoDetectorStatus();
  });
});
