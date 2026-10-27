// @vitest-environment jsdom
//
// The close-tab confirm follows its tab: it goes away when the tab does, by
// whatever path, and a confirm whose tab is gone never swallows the next
// close-tab request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspace, type PaneLeaf, type Surface, type Workspace } from '../../../shared/types';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { getLeafPanes } from '../../../shared/paneUtils';
import { useStore, type StoreState } from '../index';
import { createUISlice } from '../slices/uiSlice';
import CloseTabConfirm from '../../components/Pane/CloseTabConfirm';

function surface(id: string): Surface {
  return { id, ptyId: `pty-${id}`, title: id, shell: 'zsh', cwd: '/tmp', surfaceType: 'terminal' };
}

/** Two workspaces; the first has two panes, the first of those two tabs. */
function seed(): { ws: Workspace; other: Workspace; paneA: PaneLeaf; paneB: PaneLeaf } {
  const ws = createWorkspace('Confirm');
  const other = createWorkspace('Other');
  act(() => {
    useStore.setState((state) => {
      state.workspaces = [ws, other];
      state.activeWorkspaceId = ws.id;
      state.closeTabConfirm = null;
    });
  });
  act(() => useStore.getState().splitPane(ws.rootPane.id, 'horizontal'));
  act(() => {
    useStore.setState((state) => {
      const [a, b] = getLeafPanes(state.workspaces[0].rootPane);
      a.surfaces = [surface('a1'), surface('a2')];
      a.activeSurfaceId = 'a1';
      b.surfaces = [surface('b1')];
      b.activeSurfaceId = 'b1';
    });
  });
  const live = useStore.getState().workspaces;
  const [paneA, paneB] = getLeafPanes(live[0].rootPane);
  return { ws: live[0], other: live[1], paneA, paneB };
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { dispose: vi.fn() } };
});

afterEach(() => {
  act(() => useStore.getState().dismissCloseTab());
});

describe('a close-tab confirm whose tab goes away', () => {
  it('is dismissed when its surface is closed', () => {
    const { ws, paneA } = seed();
    act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneA.id, surfaceId: 'a1' }));
    expect(useStore.getState().closeTabConfirm).not.toBeNull();
    act(() => useStore.getState().closeSurface(paneA.id, 'a1', ws.id));
    expect(useStore.getState().closeTabConfirm).toBeNull();
  });

  it('is dismissed when its pane is closed', () => {
    const { ws, paneB } = seed();
    act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneB.id, surfaceId: 'b1' }));
    act(() => useStore.getState().closePane(paneB.id, ws.id));
    expect(useStore.getState().closeTabConfirm).toBeNull();
  });

  it('is dismissed when its workspace is removed', () => {
    const { ws, paneA } = seed();
    act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneA.id, surfaceId: 'a2' }));
    act(() => useStore.getState().removeWorkspace(ws.id));
    expect(useStore.getState().workspaces.some((w) => w.id === ws.id)).toBe(false);
    expect(useStore.getState().closeTabConfirm).toBeNull();
  });

  it('is dismissed when a loaded session replaces the workspaces', () => {
    const { ws, paneA } = seed();
    act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneA.id, surfaceId: 'a1' }));
    const fresh = createWorkspace('Loaded');
    act(() => useStore.getState().loadSession({ workspaces: [fresh], activeWorkspaceId: fresh.id, sidebarVisible: true }));
    expect(useStore.getState().closeTabConfirm).toBeNull();
  });

  it('stays while its tab is still there', () => {
    const { ws, paneA } = seed();
    const target = { workspaceId: ws.id, paneId: paneA.id, surfaceId: 'a1' };
    act(() => useStore.getState().requestCloseTab(target));
    act(() => useStore.getState().closeSurface(paneA.id, 'a2', ws.id));
    expect(useStore.getState().closeTabConfirm).toEqual(target);
  });
});

describe('requestCloseTab', () => {
  it('replaces a confirm whose tab is gone, so the shortcut is not swallowed', () => {
    // The UI slice alone, with no store-level dismiss: a confirm whose tab is
    // already gone when the next request arrives (the same tick).
    const ws = createWorkspace('Alone');
    const pane = ws.rootPane as PaneLeaf;
    pane.surfaces = [surface('s1')];
    const store = create<StoreState>()(
      immer((...args) => ({
        ...createUISlice(...args),
        workspaces: [ws],
        closeTabConfirm: { workspaceId: ws.id, paneId: pane.id, surfaceId: 'gone' },
      }) as unknown as StoreState),
    );
    const next = { workspaceId: ws.id, paneId: pane.id, surfaceId: 's1' };
    store.getState().requestCloseTab(next);
    expect(store.getState().closeTabConfirm).toEqual(next);
  });

  it('never retargets a confirm whose tab is still there', () => {
    const { ws, paneA, paneB } = seed();
    const first = { workspaceId: ws.id, paneId: paneA.id, surfaceId: 'a1' };
    act(() => useStore.getState().requestCloseTab(first));
    act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneB.id, surfaceId: 'b1' }));
    expect(useStore.getState().closeTabConfirm).toEqual(first);
  });
});

describe('the confirm dialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('leaves the screen when its pane is closed by another path', () => {
    const { ws, paneB } = seed();
    act(() => root.render(React.createElement(CloseTabConfirm)));
    act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneB.id, surfaceId: 'b1' }));
    expect(document.querySelector('[data-testid="close-tab-confirm"]')).not.toBeNull();
    act(() => useStore.getState().closePane(paneB.id, ws.id));
    expect(document.querySelector('[data-testid="close-tab-confirm"]')).toBeNull();
  });
});
