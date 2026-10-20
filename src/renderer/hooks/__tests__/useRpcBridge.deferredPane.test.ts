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
