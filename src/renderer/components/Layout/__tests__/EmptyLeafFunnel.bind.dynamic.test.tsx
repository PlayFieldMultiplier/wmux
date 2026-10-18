// @vitest-environment jsdom
//
// #2398 — what the funnel does with a create once it settles: adopt it into
// the leaf that asked, or dispose it when the leaf is gone or already filled.
// Pinned for the visible (active-workspace) case so moving the create into
// the per-leaf lifecycle cannot change the order or the count.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmptyLeafFunnel } from '../EmptyLeafFunnel';
import { useStore } from '../../../stores';
import { createWorkspace } from '../../../../shared/types';
import { ptyLifecycle } from '../../../hooks/ptyLifecycle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Created = { id: string; shell?: string; cwd?: string };
let container: HTMLDivElement;
let root: Root;
let create: ReturnType<typeof vi.fn>;
let dispose: ReturnType<typeof vi.fn>;
let settle: ((value: Created) => void)[];
let paneId: string;
let wsId: string;

function emptyWorkspace(): void {
  const ws = createWorkspace('ws');
  if (ws.rootPane.type !== 'leaf') throw new Error('fixture expects a leaf root');
  ws.rootPane.surfaces = [];
  paneId = ws.rootPane.id;
  wsId = ws.id;
  act(() => useStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, paneGate: 'ready', projectPaneSeed: {}, splitCwdSeed: {} }));
}

const leaf = () => {
  const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
  return ws?.rootPane.type === 'leaf' ? ws.rootPane : null;
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  settle = [];
  create = vi.fn().mockImplementation(() => new Promise<Created>((r) => { settle.push(r); }));
  dispose = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { create, dispose } };
  emptyWorkspace();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('EmptyLeafFunnel — binding the created pty', () => {
  it('adopts the pty into the leaf that asked for it, once', async () => {
    act(() => root.render(createElement(EmptyLeafFunnel)));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ workspaceId: wsId, spawnKind: 'user-shell' });
    await act(async () => { settle[0]({ id: 'pty-a', shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', cwd: 'D:\\proj' }); });
    const surfaces = leaf()?.surfaces ?? [];
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({ ptyId: 'pty-a', cwd: 'D:\\proj' });
    expect(useStore.getState().workspaces.find((w) => w.id === wsId)?.metadata?.cwd).toBe('D:\\proj');
    expect(dispose).not.toHaveBeenCalled();
  });

  it('a re-run while the create is in flight does not ask again', async () => {
    act(() => root.render(createElement(EmptyLeafFunnel)));
    // An unrelated store write that re-renders the funnel and re-runs its effect.
    act(() => useStore.setState({ paneGate: 'pending' }));
    act(() => useStore.setState({ paneGate: 'ready' }));
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => { settle[0]({ id: 'pty-a' }); });
    expect(leaf()?.surfaces.map((s) => s.ptyId)).toEqual(['pty-a']);
  });

  it('disposes the pty when the leaf was filled meanwhile', async () => {
    act(() => root.render(createElement(EmptyLeafFunnel)));
    act(() => useStore.getState().addSurface(paneId, 'pty-other', 'Terminal', ''));
    await act(async () => { settle[0]({ id: 'pty-late' }); });
    expect(dispose).toHaveBeenCalledWith('pty-late');
    expect(leaf()?.surfaces.map((s) => s.ptyId)).toEqual(['pty-other']);
  });

  it('a refused create is not fired again by a re-run, only after Retry (#2398)', async () => {
    create.mockImplementationOnce(() => Promise.reject(new Error('[RESOURCE_EXHAUSTED] session cap reached')));
    act(() => root.render(createElement(EmptyLeafFunnel)));
    await act(async () => { await Promise.resolve(); });
    expect(useStore.getState().ptyCreateByKey[paneId]?.state).toBe('createFailed');
    act(() => useStore.setState({ paneGate: 'pending' }));
    act(() => useStore.setState({ paneGate: 'ready' }));
    expect(create).toHaveBeenCalledTimes(1);
    // The pane's Retry.
    act(() => ptyLifecycle.clearRefusal(paneId));
    expect(create).toHaveBeenCalledTimes(2);
    await act(async () => { settle[0]({ id: 'pty-retried' }); });
    expect(leaf()?.surfaces.map((s) => s.ptyId)).toEqual(['pty-retried']);
  });

  it('Retry on a refused project pane repeats its seeded command and directory (Codex P2)', async () => {
    act(() => useStore.setState({ projectPaneSeed: { [paneId]: { command: 'npm run dev', cwd: 'D:/proj' } as never } }));
    create.mockImplementationOnce(() => Promise.reject(new Error('[RESOURCE_EXHAUSTED] session cap reached')));
    act(() => root.render(createElement(EmptyLeafFunnel)));
    await act(async () => { await Promise.resolve(); });
    expect(useStore.getState().ptyCreateByKey[paneId]?.state).toBe('createFailed');
    // The seed was used up by the first attempt.
    expect(useStore.getState().projectPaneSeed[paneId]).toBeUndefined();
    act(() => { ptyLifecycle.retry(paneId); });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toMatchObject({ initialCommand: 'npm run dev', cwd: 'D:/proj' });
  });
});
