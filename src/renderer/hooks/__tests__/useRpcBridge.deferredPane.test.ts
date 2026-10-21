// @vitest-environment jsdom
//
// #2398 — a pane whose shell has not started (its workspace was never shown)
// is not running and not dead. Reads report it as `deferred` and never start
// it; agent deliveries treat it as a pane with no agent; only a raw terminal
// write starts it (surface.ensurePty, asked by main before the write).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';
import { formatBracketedPastePayload } from '../../../shared/ptyMessageDelivery';

const LIVE_PTY = 'pty-2398-live';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: 'D:\\proj', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

const SENDER: Workspace = { id: 'ws-2398-sender', name: 'Sender', rootPane: leaf('pane-sender', 'pty-2398-sender'), activePaneId: 'pane-sender' } as Workspace;
/**
 * Never shown since the restart: its active pane is blank, a second pane has a
 * live shell, and the workspace metadata (carried over) still says an agent ran.
 */
const TARGET: Workspace = {
  id: 'ws-2398-target',
  name: 'Target',
  rootPane: {
    id: 'split-2398',
    type: 'branch',
    direction: 'horizontal',
    children: [leaf('pane-blank', ''), leaf('pane-live', LIVE_PTY)],
    sizes: [50, 50],
  },
  activePaneId: 'pane-blank',
  metadata: { agentName: 'Claude Code', agentStatus: 'running' },
} as unknown as Workspace;

let create: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn<(ptyId: string, data: string) => void>>;
let resolveCreate: (value: { id: string; cwd?: string }) => void;

beforeEach(() => {
  create = vi.fn().mockImplementation(() => new Promise((r) => { resolveCreate = r; }));
  write = vi.fn<(ptyId: string, data: string) => void>();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { create, write, dispose: vi.fn(), cancelCreate: vi.fn() },
    rpc: {
      gatedSubmit: async (ptyId: string, text: string) => {
        write(ptyId, formatBracketedPastePayload(text));
        return { ok: true };
      },
    },
  };
  const s = useStore.getState();
  s.hydrateAgentAlive({});
  s.hydrateCommandRunning({});
  useStore.setState({
    workspaces: JSON.parse(JSON.stringify([SENDER, TARGET])) as Workspace[],
    activeWorkspaceId: SENDER.id,
    paneGate: 'ready',
    ptyCreateByKey: {},
    ptyDeferredById: {},
    defaultShell: '',
    startupDirectory: '',
  });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const blankSurface = () => {
  const root = useStore.getState().workspaces[1].rootPane as unknown as { children: PaneLeaf[] };
  return root.children[0].surfaces[0];
};

describe('reads of a pane that has not started', () => {
  it('input.readScreen reports it deferred and starts nothing', async () => {
    const read = await handleRpcMethod('input.readScreen', { workspaceId: TARGET.id });
    expect(read).toEqual({ ptyId: '', text: '', deferred: true, deferredSurfaceId: 'surf-pane-blank' });
    expect(create).not.toHaveBeenCalled();
  });

  it('pane.list marks it deferred and starts nothing', async () => {
    const rows = await handleRpcMethod('pane.list', { workspaceId: TARGET.id }) as Array<{ id: string; deferred?: boolean }>;
    expect(rows.find((r) => r.id === 'pane-blank')?.deferred).toBe(true);
    expect(rows.find((r) => r.id === 'pane-live')?.deferred).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('surface.ensurePty (a raw write to a pane that has not started)', () => {
  it('starts it once, binds it, and answers its ptyId to every caller', async () => {
    const first = handleRpcMethod('surface.ensurePty', { surfaceId: 'surf-pane-blank', workspaceId: TARGET.id });
    const second = handleRpcMethod('surface.ensurePty', { surfaceId: 'surf-pane-blank', workspaceId: TARGET.id });
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ workspaceId: TARGET.id, surfaceId: 'surf-pane-blank', cwd: 'D:\\proj', spawnKind: 'user-shell' });
    resolveCreate({ id: 'pty-2398-started', cwd: 'D:\\proj' });
    expect(await first).toEqual({ ptyId: 'pty-2398-started' });
    expect(await second).toEqual({ ptyId: 'pty-2398-started' });
    expect(blankSurface().ptyId).toBe('pty-2398-started');
  });

  it('refuses a surface outside the caller workspace without starting it', async () => {
    const res = await handleRpcMethod('surface.ensurePty', { surfaceId: 'surf-pane-blank', workspaceId: SENDER.id });
    expect(res).toMatchObject({ error: expect.stringContaining('not found') });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('agent deliveries to a pane that has not started', () => {
  it('an unaddressed A2A send answers no_agent_pane and starts nothing', async () => {
    const result = await handleRpcMethod('a2a.task.send', { workspaceId: SENDER.id, to: TARGET.id, message: 'hello' }) as { delivery?: Record<string, unknown> };
    expect(result.delivery).toMatchObject({ stored: true, notified: false, reason: 'no_agent_pane' });
    expect(create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('an A2A send addressed to it says its terminal has not started', async () => {
    const result = await handleRpcMethod('a2a.task.send', { workspaceId: SENDER.id, to: TARGET.id, message: 'hello', paneId: 'pane-blank' }) as { error?: string };
    expect(result.error).toMatch(/has not started yet/);
    expect(create).not.toHaveBeenCalled();
  });
});

// A pane bound to a suspended session its hidden pane attached without
// promoting (pty.reconnect answered `deferred`) is not started either.
describe('a bound pane whose suspended session was left suspended', () => {
  beforeEach(() => {
    const ws = useStore.getState().workspaces;
    const root = ws[1].rootPane as unknown as { children: PaneLeaf[] };
    root.children[0].surfaces[0].ptyId = 'pty-2398-suspended';
    useStore.setState({ workspaces: [...ws], ptyDeferredById: { 'pty-2398-suspended': true } });
  });

  it('reads as deferred, by the active pane and by its ptyId', async () => {
    expect(await handleRpcMethod('input.readScreen', { workspaceId: TARGET.id }))
      .toEqual({ ptyId: 'pty-2398-suspended', text: '', deferred: true, deferredSurfaceId: 'surf-pane-blank' });
    expect(await handleRpcMethod('input.readScreen', { workspaceId: TARGET.id, ptyId: 'pty-2398-suspended' }))
      .toEqual({ ptyId: 'pty-2398-suspended', text: '', deferred: true });
    const rows = await handleRpcMethod('pane.list', { workspaceId: TARGET.id }) as Array<{ id: string; deferred?: boolean }>;
    expect(rows.find((r) => r.id === 'pane-blank')?.deferred).toBe(true);
  });

  it('a raw write starts it: promoted and attached, then answered', async () => {
    const reconnect = vi.fn(async () => ({ success: true }));
    (window.electronAPI.pty as unknown as { reconnect: typeof reconnect }).reconnect = reconnect;
    expect(await handleRpcMethod('surface.ensurePty', { ptyId: 'pty-2398-suspended' })).toEqual({ ptyId: 'pty-2398-suspended' });
    expect(reconnect).toHaveBeenCalledWith('pty-2398-suspended', { promote: true });
    expect(useStore.getState().ptyDeferredById['pty-2398-suspended']).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  // Review P2: a pane whose workspace is not mounted (outside the multiview
  // grid, or cold-parked) never reconnected, so nothing marked its held
  // session; the attach was skipped and the write dropped.
  it('main asks by the missing pipe, not the mark: an unmarked session with no mounted pane is attached too', async () => {
    useStore.setState({ ptyDeferredById: {} });
    const reconnect = vi.fn(async () => ({ success: true }));
    (window.electronAPI.pty as unknown as { reconnect: typeof reconnect }).reconnect = reconnect;
    expect(await handleRpcMethod('surface.ensurePty', { ptyId: 'pty-2398-held' })).toEqual({ ptyId: 'pty-2398-held' });
    expect(reconnect).toHaveBeenCalledWith('pty-2398-held', { promote: true });
  });

  // Re-review P2: a stop key (ctrl+c, escape) to a session main has no pipe
  // to asks without promote. A live session (detached since an app restart,
  // its pane never mounted) is attached and answered; a suspended or dead one
  // has nothing running to stop and is never started for the key.
  it('a stop key attaches a live session without promoting, and answers a suspended or dead one not running', async () => {
    useStore.setState({ ptyDeferredById: {} });
    const reconnect = vi.fn(async (_id: string, _opts: { promote: boolean }) => ({ success: true } as Record<string, unknown>));
    (window.electronAPI.pty as unknown as { reconnect: typeof reconnect }).reconnect = reconnect;
    expect(await handleRpcMethod('surface.ensurePty', { ptyId: 'pty-2398-live', promote: false })).toEqual({ ptyId: 'pty-2398-live' });
    reconnect.mockResolvedValueOnce({ success: false, deferred: true });
    expect(await handleRpcMethod('surface.ensurePty', { ptyId: 'pty-2398-held', promote: false })).toEqual({ notRunning: true });
    reconnect.mockResolvedValueOnce({ success: false, code: 'session-dead', transient: false, error: 'Session not found or dead' });
    expect(await handleRpcMethod('surface.ensurePty', { ptyId: 'pty-2398-gone', promote: false })).toEqual({ notRunning: true });
    expect(reconnect.mock.calls.map(([, opts]) => opts)).toEqual([{ promote: false }, { promote: false }, { promote: false }]);
    expect(create).not.toHaveBeenCalled();
  });

  it('an attach the daemon refuses is answered as a refusal', async () => {
    const reconnect = vi.fn(async () => ({ success: false, error: 'session cap reached' }));
    (window.electronAPI.pty as unknown as { reconnect: typeof reconnect }).reconnect = reconnect;
    expect(await handleRpcMethod('surface.ensurePty', { ptyId: 'pty-2398-suspended' }))
      .toEqual({ error: expect.stringContaining('session cap reached') });
  });

  // Review P2: the bound pane keeps its ptyId, so the unstarted check missed
  // it and the carried-over workspace metadata (or a stale per-pane agent)
  // authorized a write into a session with no pipe.
  it('an unaddressed A2A send to it answers no_agent_pane and writes nothing', async () => {
    // Its only terminal: the carried-over workspace metadata alone stands in
    // for an agent there.
    const ws = useStore.getState().workspaces;
    (ws[1].rootPane as unknown as { children: PaneLeaf[] }).children[1].surfaces[0].ptyId = '';
    useStore.setState({ workspaces: [...ws] });
    const result = await handleRpcMethod('a2a.task.send', { workspaceId: SENDER.id, to: TARGET.id, message: 'hello' }) as { delivery?: Record<string, unknown> };
    expect(result.delivery).toMatchObject({ stored: true, notified: false, reason: 'no_agent_pane' });
    expect(write).not.toHaveBeenCalled();
  });

  it('an A2A send addressed to it answers no_agent_pane even with an agent on record for it', async () => {
    useStore.getState().setSurfaceAgent('pty-2398-suspended', 'Claude Code', 'waiting', 'claude');
    useStore.getState().hydrateAgentAlive({ 'pty-2398-suspended': true });
    try {
      const result = await handleRpcMethod('a2a.task.send', { workspaceId: SENDER.id, to: TARGET.id, message: 'hello', paneId: 'pane-blank' }) as { delivery?: Record<string, unknown> };
      expect(result.delivery).toMatchObject({ stored: true, notified: false, reason: 'no_agent_pane' });
      expect(write).not.toHaveBeenCalled();
    } finally {
      useStore.getState().clearSurfaceAgent('pty-2398-suspended');
    }
  });
});
