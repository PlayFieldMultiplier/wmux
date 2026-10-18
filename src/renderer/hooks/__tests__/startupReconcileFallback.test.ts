import { describe, it, expect, vi } from 'vitest';
import { applyStartupReconcileFallback, collectBoundPtyIds } from '../startupReconcileFallback';
import { useStore } from '../../stores';
import { createWorkspace, type PaneLeaf, type Workspace } from '../../../shared/types';

// #2398 — a startup reconcile that times out (or aborts) must not blank the
// panes: with a daemon, their sessions may well be alive, and clearing the ids
// self-created a duplicate shell beside each one.

function workspaceWith(ptyIds: string[], stashedPtyId?: string): Workspace {
  const ws = createWorkspace('ws');
  const leaf = ws.rootPane as PaneLeaf;
  leaf.surfaces = ptyIds.map((ptyId, i) => ({ id: `${ws.id}-s${i}`, ptyId, title: 't', shell: 'pwsh', cwd: '' }));
  leaf.activeSurfaceId = leaf.surfaces[0]?.id ?? '';
  if (stashedPtyId) {
    ws.stashedPanes = [{
      pane: { id: `${ws.id}-stash`, type: 'leaf', activeSurfaceId: 'st', surfaces: [{ id: `${ws.id}-st`, ptyId: stashedPtyId, title: 't', shell: 'pwsh', cwd: '' }] },
      stashedAt: 1,
    }];
  }
  return ws;
}

describe('collectBoundPtyIds', () => {
  it('collects every bound surface, stashed panes included, and skips blank ones', () => {
    expect(collectBoundPtyIds([workspaceWith(['pty-a', '', 'pty-b'], 'pty-stashed')])).toEqual(['pty-a', 'pty-b', 'pty-stashed']);
  });
});

describe('applyStartupReconcileFallback', () => {
  it('with a daemon: keeps every binding and marks it unconfirmed', () => {
    const markUnconfirmed = vi.fn();
    const clearAll = vi.fn();
    const outcome = applyStartupReconcileFallback({
      daemonMode: true,
      workspaces: [workspaceWith(['pty-a', 'pty-b'], 'pty-c')],
      markUnconfirmed,
      clearAll,
      log: () => undefined,
    });
    expect(outcome).toBe('kept');
    expect(clearAll).not.toHaveBeenCalled();
    expect(markUnconfirmed).toHaveBeenCalledWith(['pty-a', 'pty-b', 'pty-c']);
  });

  it('without a daemon: clears, as before (no local pty outlives the app)', () => {
    const markUnconfirmed = vi.fn();
    const clearAll = vi.fn();
    const outcome = applyStartupReconcileFallback({
      daemonMode: false,
      workspaces: [workspaceWith(['pty-a'])],
      markUnconfirmed,
      clearAll,
      log: () => undefined,
    });
    expect(outcome).toBe('cleared');
    expect(clearAll).toHaveBeenCalledTimes(1);
    expect(markUnconfirmed).not.toHaveBeenCalled();
  });

  it('against the real store: the ptyIds stay bound and read as unconfirmed', () => {
    const ws = workspaceWith(['pty-live-1', 'pty-live-2']);
    useStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, ptyUnconfirmedById: {} });
    applyStartupReconcileFallback({
      daemonMode: true,
      workspaces: useStore.getState().workspaces,
      markUnconfirmed: (ids) => useStore.getState().setPtysUnconfirmed(ids, true),
      clearAll: useStore.getState().clearAllPtyState,
      log: () => undefined,
    });
    const leaf = useStore.getState().workspaces[0].rootPane as PaneLeaf;
    expect(leaf.surfaces.map((s) => s.ptyId)).toEqual(['pty-live-1', 'pty-live-2']);
    expect(useStore.getState().ptyUnconfirmedById).toEqual({ 'pty-live-1': true, 'pty-live-2': true });
    // A reconcile that later lists them live confirms them.
    useStore.getState().setPtysUnconfirmed(new Set(['pty-live-1']), false);
    expect(useStore.getState().ptyUnconfirmedById).toEqual({ 'pty-live-2': true });
    // An authoritative clear drops the mark with the binding.
    useStore.getState().clearSurfacePtyIdByPty('pty-live-2');
    expect(useStore.getState().ptyUnconfirmedById).toEqual({});
  });
});
