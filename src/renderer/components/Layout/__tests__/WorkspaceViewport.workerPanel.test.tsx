// @vitest-environment jsdom
//
// A bot worker's terminal shows in the Bots page's worker panel (owner
// decision 2026-10-14). A PTY has one xterm, so while that page shows it the
// Workspaces viewport must not mount the same workspace's panes, and it
// mounts them again once the page goes. The active workspace never changes.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { Workspace } from '../../../../shared/types';

const mounted = new Set<string>();
vi.mock('../../Pane/PaneContainer', async () => {
  const { useEffect } = await import('react');
  return {
    default: function PaneContainerMock({ workspace }: { workspace: Workspace }) {
      useEffect(() => {
        mounted.add(workspace.id);
        return () => { mounted.delete(workspace.id); };
      }, [workspace.id]);
      return null;
    },
  };
});

import { WorkspaceViewport } from '../WorkspaceViewport';
import { useStore } from '../../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ws(id: string): Workspace {
  return {
    id,
    name: id,
    rootPane: { type: 'leaf', id: `${id}-root`, surfaces: [], activeSurfaceId: '' } as unknown as Workspace['rootPane'],
    activePaneId: `${id}-root`,
  } as Workspace;
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); mounted.clear(); });

describe('WorkspaceViewport and the Bots worker panel', () => {
  it('leaves the hosted workspace unmounted while Bots shows it, and mounts it again after', () => {
    act(() => useStore.setState({
      workspaces: [ws('w1'), ws('t1')],
      activeWorkspaceId: 'w1',
      multiviewIds: [],
      parkedWorkspaceIds: {},
      paneGate: 'ready',
      appRoute: 'workspaces',
      botsWorkerPanel: { workspaceId: 't1', conversationId: 'bot:b1' },
    } as never));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<WorkspaceViewport />));
    cleanups.push(() => { act(() => root.unmount()); el.remove(); });

    // On Workspaces the panel is not shown, so the viewport mounts it.
    expect([...mounted].sort()).toEqual(['t1', 'w1']);
    act(() => useStore.setState({ appRoute: 'bots' } as never));
    expect([...mounted]).toEqual(['w1']);
    expect(useStore.getState().activeWorkspaceId).toBe('w1');
    // The panel closes: the viewport mounts it again.
    act(() => useStore.getState().setBotsWorkerPanel(null));
    expect([...mounted].sort()).toEqual(['t1', 'w1']);
  });

  it('keeps a worker holding a browser mounted here: its state would not survive the move', () => {
    const browserWs = { ...ws('t2'), rootPane: { type: 'leaf', id: 't2-root', surfaces: [{ id: 'b', surfaceType: 'browser' }], activeSurfaceId: 'b' } } as unknown as Workspace;
    act(() => useStore.setState({
      workspaces: [ws('w1'), browserWs],
      activeWorkspaceId: 'w1',
      multiviewIds: [],
      parkedWorkspaceIds: {},
      paneGate: 'ready',
      appRoute: 'bots',
      botsWorkerPanel: { workspaceId: 't2', conversationId: 'bot:b1' },
    } as never));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<WorkspaceViewport />));
    cleanups.push(() => { act(() => root.unmount()); el.remove(); });
    expect([...mounted].sort()).toEqual(['t2', 'w1']);
  });
});
