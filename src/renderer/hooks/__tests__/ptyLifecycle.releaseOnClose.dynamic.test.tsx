// @vitest-environment jsdom
//
// #2398 (review P3) — the empty-leaf funnel creates under the leaf's id, and
// nothing cancels that key when the leaf closes: its refusal (store entry and
// the held request) outlived the pane, one per refused leaf ever closed. While
// the funnel is mounted, a refusal is forgotten once its owner leaves the
// workspaces.
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../stores';
import { ptyLifecycle, useReleaseOrphanedRefusals } from '../ptyLifecycle';
import { createWorkspace, type PaneLeaf } from '../../../shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Funnel() {
  useReleaseOrphanedRefusals();
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('useReleaseOrphanedRefusals', () => {
  it('keeps a leaf’s refusal while the leaf exists, drops it once the leaf is gone', async () => {
    const ws = createWorkspace('ws');
    const leaf = ws.rootPane as PaneLeaf;
    leaf.surfaces = [];
    useStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, ptyCreateByKey: {} });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(Funnel)));

    await act(async () => {
      await ptyLifecycle.ensure(leaf.id, {
        create: async () => ({ ok: false, error: { code: 'RESOURCE_EXHAUSTED', message: 'cap' } }),
        bind: () => true,
      });
    });
    expect(useStore.getState().ptyCreateByKey[leaf.id]).toEqual({ state: 'createFailed', error: 'cap' });

    // An unrelated workspace change keeps it.
    act(() => useStore.setState({ workspaces: [{ ...ws, name: 'renamed' }] }));
    expect(useStore.getState().ptyCreateByKey[leaf.id]?.state).toBe('createFailed');

    // The leaf closes (here: its workspace goes).
    act(() => useStore.setState({ workspaces: [createWorkspace('other')] }));
    expect(useStore.getState().ptyCreateByKey[leaf.id]).toBeUndefined();
    expect(ptyLifecycle.retry(leaf.id)).toBe(false);
  });
});
