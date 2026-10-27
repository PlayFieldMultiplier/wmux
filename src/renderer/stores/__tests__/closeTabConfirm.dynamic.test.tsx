// @vitest-environment jsdom
//
// The close-tab confirm stays on its tab: it follows the tab to another pane,
// goes away when the tab does (by whatever path, giving the keyboard back to
// the active terminal), and so never swallows the next close-tab request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspace, type PaneLeaf, type Surface, type Workspace } from '../../../shared/types';
import { getLeafPanes } from '../../../shared/paneUtils';
import { useStore } from '../index';
import CloseTabConfirm from '../../components/Pane/CloseTabConfirm';
import { terminalRegistry } from '../../hooks/useTerminal';

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

  it('follows its tab to another pane instead of going away', () => {
    const { ws, paneA, paneB } = seed();
    act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneA.id, surfaceId: 'a2' }));
    act(() => {
      useStore.setState((state) => {
        const [a, b] = getLeafPanes(state.workspaces[0].rootPane);
        const moved = a.surfaces.splice(a.surfaces.findIndex((s) => s.id === 'a2'), 1)[0];
        b.surfaces.push(moved);
      });
    });
    expect(useStore.getState().closeTabConfirm).toEqual({ workspaceId: ws.id, paneId: paneB.id, surfaceId: 'a2' });
  });

  it('follows its tab to another workspace', () => {
    const { ws, other, paneA } = seed();
    act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneA.id, surfaceId: 'a2' }));
    act(() => {
      useStore.setState((state) => {
        const [a] = getLeafPanes(state.workspaces[0].rootPane);
        const moved = a.surfaces.splice(a.surfaces.findIndex((s) => s.id === 'a2'), 1)[0];
        (state.workspaces[1].rootPane as PaneLeaf).surfaces.push(moved);
      });
    });
    expect(useStore.getState().closeTabConfirm).toEqual({ workspaceId: other.id, paneId: other.rootPane.id, surfaceId: 'a2' });
  });
});

describe('requestCloseTab', () => {
  it('opens a confirm for the next tab once the last one\'s tab went away, so the shortcut is not swallowed', () => {
    const { ws, paneA, paneB } = seed();
    act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneB.id, surfaceId: 'b1' }));
    act(() => useStore.getState().closePane(paneB.id, ws.id));
    const next = { workspaceId: ws.id, paneId: paneA.id, surfaceId: 'a1' };
    act(() => useStore.getState().requestCloseTab(next));
    expect(useStore.getState().closeTabConfirm).toEqual(next);
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

  it('hands the keyboard back to the active terminal when it leaves that way', async () => {
    const { ws, paneA, paneB } = seed();
    act(() => {
      useStore.setState((state) => {
        state.workspaces[0].activePaneId = paneA.id;
      });
    });
    const term = { focus: vi.fn() };
    terminalRegistry.set('pty-a1', term as never);
    try {
      act(() => root.render(React.createElement(CloseTabConfirm)));
      act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneB.id, surfaceId: 'b1' }));
      act(() => useStore.getState().closePane(paneB.id, ws.id));
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      });
      expect(term.focus).toHaveBeenCalled();
    } finally {
      terminalRegistry.delete('pty-a1');
    }
  });

  it('hands the keyboard back once after Cancel', async () => {
    const { ws, paneA } = seed();
    act(() => {
      useStore.setState((state) => {
        state.workspaces[0].activePaneId = paneA.id;
      });
    });
    const term = { focus: vi.fn() };
    terminalRegistry.set('pty-a1', term as never);
    try {
      act(() => root.render(React.createElement(CloseTabConfirm)));
      act(() => useStore.getState().requestCloseTab({ workspaceId: ws.id, paneId: paneA.id, surfaceId: 'a2' }));
      const cancel = document.querySelector<HTMLButtonElement>('[data-close-tab-cancel]');
      if (!cancel) throw new Error('missing cancel');
      act(() => cancel.click());
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      });
      expect(term.focus).toHaveBeenCalledTimes(1);
    } finally {
      terminalRegistry.delete('pty-a1');
    }
  });
});
