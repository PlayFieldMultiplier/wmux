import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../../DaemonClient';
import { noTerminalAccess } from '../../../shared/connectorAccess';
const mocks = vi.hoisted(() => ({ context: vi.fn(), get: vi.fn(), bot: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: mocks.context }));
vi.mock('../../agents/botWorkerMergeGuard', () => ({ isBotWorkerSession: mocks.bot, isBotWorkerWorkspace: () => false }));
vi.mock('../../factory/connectorStore', () => ({ getConnectorStore: () => ({ get: mocks.get }) }));
vi.mock('../../workspace/WorkspaceMirror', () => ({ getWorkspaceMirror: () => ({ onSnapshot: mocks.snapshot, peekPaneForPty: () => undefined, getPaneWorkspaces: () => new Map() }) }));
import { bindTerminalSession } from '../terminalSession';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({ workspaces: [{ id: 'ws-a' }], panes: [{ id: 'pane-a', workspaceId: 'ws-a', ptyIds: ['daemon-a'] }] });
  mocks.get.mockReturnValue({ enabled: true, terminalAccess: { ...noTerminalAccess(), mode: 'all' } });
  mocks.bot.mockReturnValue(false);
  mocks.snapshot.mockReturnValue(() => undefined);
});
function fixture() {
  const row = { id: 'daemon-a', pid: 123, cmd: '/bin/zsh', state: 'attached', createdAt: 'one' };
  const state = { incarnationId: 'incarnation-a', agentName: null as string | null, inputQuiet: true, hasDraft: false };
  const daemon = Object.assign(new EventEmitter(), {
    isConnected: true,
    rpc: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async (method) => {
      if (method === 'daemon.listSessions') return [row];
      if (method === 'daemon.readPromptEvents') return { events: [{ type: 'prompt_end', byteOffset: 10 }], eventCount: 1, totalBytesWritten: 10, keyInputRevision: 0, incarnationId: state.incarnationId, emptyShellPrompt: true };
      if (method === 'daemon.writeIfUnchanged') return { written: true };
      return { presence: 'absent', reason: 'idle-shell', incarnationId: state.incarnationId, outputBytes: 10 };
    }),
    getAgentState: vi.fn(async () => state), writeToSession: vi.fn(() => true),
  });
  let current: DaemonClient | null = daemon as unknown as DaemonClient;
  return { daemon, row, state, bind: () => bindTerminalSession('con-12345678', 'daemon-a', () => null, () => current), disconnect: () => { current = null; } };
}
it.skipIf(process.platform === 'win32')('requires host-resolved ownership and independently excludes bot workers', async () => {
  const f = fixture();
  mocks.bot.mockReturnValue(true);
  await expect(f.bind()).rejects.toThrow();
  expect(f.daemon.writeToSession).not.toHaveBeenCalled();
  mocks.bot.mockReturnValue(false);
  mocks.context.mockResolvedValue({ workspaces: [], panes: [] });
  await expect(f.bind()).rejects.toThrow();
});
it.skipIf(process.platform === 'win32')('requires positive idle-shell proof and refuses a running agent', async () => {
  const f = fixture(); const lease = await f.bind();
  await lease.ready();
  f.daemon.getAgentState.mockResolvedValue({ ...f.state, agentName: 'Claude Code' });
  await expect(lease.ready()).rejects.toThrow();
  f.daemon.getAgentState.mockResolvedValue(f.state);
  f.daemon.rpc.mockImplementation(async (method) => method === 'daemon.listSessions' ? [f.row] : { presence: 'unknown', reason: 'not-probed' });
  await expect(lease.ready()).rejects.toThrow();
  expect(f.daemon.writeToSession).not.toHaveBeenCalled();
});
it.skipIf(process.platform === 'win32')('revokes on session incarnation, shell process and workspace replacement', async () => {
  for (const mutation of ['incarnation', 'pid', 'workspace', 'policy', 'daemon']) {
    const f = fixture(); const lease = await f.bind(); await lease.ready(); await lease.write('private-launch'); await lease.authorize();
    if (mutation === 'incarnation') f.state.incarnationId = 'replacement';
    if (mutation === 'pid') f.row.pid++;
    if (mutation === 'workspace') mocks.context.mockResolvedValue({ workspaces: [{ id: 'ws-b' }], panes: [{ id: 'pane-a', workspaceId: 'ws-b', ptyIds: ['daemon-a'] }] });
    if (mutation === 'policy') mocks.get.mockReturnValue({ enabled: true, terminalAccess: noTerminalAccess() });
    if (mutation === 'daemon') f.disconnect();
    await expect(lease.authorize()).rejects.toThrow();
    mocks.context.mockResolvedValue({ workspaces: [{ id: 'ws-a' }], panes: [{ id: 'pane-a', workspaceId: 'ws-a', ptyIds: ['daemon-a'] }] });
    mocks.get.mockReturnValue({ enabled: true, terminalAccess: { ...noTerminalAccess(), mode: 'all' } });
  }
});
it.skipIf(process.platform === 'win32')('closes on daemon disconnect or destruction of the bound session', async () => {
  const f = fixture(); const lease = await f.bind(); const close = vi.fn(); const stop = lease.watch(close);
  f.daemon.emit('session:destroyed', { sessionId: 'daemon-other' }); expect(close).not.toHaveBeenCalled();
  f.daemon.emit('session:died', { sessionId: 'daemon-a' }); expect(close).toHaveBeenCalledTimes(1);
  f.daemon.emit('disconnected'); expect(close).toHaveBeenCalledTimes(2);
  stop(); f.daemon.emit('disconnected'); expect(close).toHaveBeenCalledTimes(2);
});
it.skipIf(process.platform === 'win32')('revokes a launched lease when its shell resumes and removes the prompt listener', async () => {
  const f = fixture(); const lease = await f.bind(); const close = vi.fn(); const stop = lease.watch(close);
  const prompt = (sessionId: string, type: string) => f.daemon.emit('session:prompt', { sessionId, event: { type } });
  prompt('daemon-a', 'prompt_start'); expect(close).not.toHaveBeenCalled();
  await lease.ready(); await lease.write('private-launch');
  prompt('daemon-other', 'command_end'); prompt('daemon-a', 'command_start');
  expect(close).not.toHaveBeenCalled();
  prompt('daemon-a', 'command_end'); expect(close).toHaveBeenCalledTimes(1);
  stop(); prompt('daemon-a', 'prompt_start'); expect(close).toHaveBeenCalledTimes(1);
});
it.skipIf(process.platform === 'win32')('refuses the final write if ownership moved after launch preparation', async () => {
  const f = fixture(); const lease = await f.bind(); await lease.ready();
  mocks.context.mockResolvedValue({ workspaces: [{ id: 'ws-b' }], panes: [{ id: 'pane-a', workspaceId: 'ws-b', ptyIds: ['daemon-a'] }] });
  expect(await lease.write('private-launch')).toBe(false);
  expect(f.daemon.rpc.mock.calls.some(([method]) => method === 'daemon.writeIfUnchanged')).toBe(false);
  mocks.context.mockResolvedValue({ workspaces: [{ id: 'ws-a' }], panes: [{ id: 'pane-a', workspaceId: 'ws-a', ptyIds: ['daemon-a'] }] });
  await expect(lease.authorize()).rejects.toThrow('revoked');
});
it.skipIf(process.platform === 'win32')('blocks dispatch while a mirror-triggered ownership check is pending', async () => {
  const f = fixture(); const lease = await f.bind(); await lease.ready();
  const stop = lease.watch(vi.fn());
  let resolveOwner!: (value: unknown) => void;
  mocks.context.mockReturnValue(new Promise((resolve) => { resolveOwner = resolve; }));
  mocks.snapshot.mock.calls[0][0]();
  expect(await lease.write('private-launch')).toBe(false);
  expect(f.daemon.rpc.mock.calls.some(([method]) => method === 'daemon.writeIfUnchanged')).toBe(false);
  resolveOwner({ workspaces: [], panes: [] }); await Promise.resolve(); stop();
});
it.skipIf(process.platform === 'win32')('blocks gateway authorization while ownership is being revalidated', async () => {
  const f = fixture(); const lease = await f.bind(); await lease.ready(); await lease.write('private-launch');
  const stop = lease.watch(vi.fn());
  let resolveOwner!: (value: unknown) => void;
  mocks.context.mockReturnValue(new Promise((resolve) => { resolveOwner = resolve; }));
  mocks.snapshot.mock.calls[0][0]();
  await expect(lease.authorize()).rejects.toThrow('Ownership check pending');
  resolveOwner({ workspaces: [], panes: [] }); await Promise.resolve(); stop();
});
