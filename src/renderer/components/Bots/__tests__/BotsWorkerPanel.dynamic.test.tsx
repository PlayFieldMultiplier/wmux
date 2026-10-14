// @vitest-environment jsdom
//
// The worker panel beside a bot's chat: it mounts the worker's panes when the
// page hosts them, and otherwise (a worker holding a browser or an editor)
// says why and offers Workspaces, mounting nothing.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { Workspace } from '../../../../shared/types';

const mounted: string[] = [];
vi.mock('../../Pane/PaneContainer', () => ({
  default: ({ workspace }: { workspace: Workspace }) => {
    mounted.push(workspace.id);
    return null;
  },
}));

import BotsWorkerPanel from '../BotsWorkerPanel';
import { useStore } from '../../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${Object.values(vars).join(',')})` : key);
const ws = { id: 't1', name: 'wtask: fix login', rootPane: { type: 'leaf', id: 'p', surfaces: [], activeSurfaceId: '' }, activePaneId: 'p' } as unknown as Workspace;

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); mounted.length = 0; });

function mount(node: React.ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanups.push(() => { act(() => root.unmount()); el.remove(); });
  return el;
}

describe('BotsWorkerPanel', () => {
  it('mounts the worker\'s panes under its name and state; Close calls back', () => {
    act(() => useStore.setState({ workspaces: [ws] } as never));
    const onClose = vi.fn();
    const el = mount(<BotsWorkerPanel workspaceId="t1" hosted name="fix login" state="Worker needs input" attention t={t} onClose={onClose} />);
    expect(mounted).toEqual(['t1']);
    expect(el.querySelector('[data-bots-worker-panel="t1"]')?.getAttribute('aria-label')).toBe('botsPage.chat.workerPanel(fix login)');
    expect(el.querySelector('[data-bots-worker-panel-state]')?.className).toContain('attention-text');
    act(() => (el.querySelector('[data-bots-worker-panel-close]') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('when not hosted, mounts nothing and offers Workspaces', () => {
    act(() => useStore.setState({ workspaces: [ws] } as never));
    const el = mount(<BotsWorkerPanel workspaceId="t1" hosted={false} name="fix login" state={null} attention={false} t={t} onClose={() => undefined} />);
    expect(mounted).toEqual([]);
    expect(el.querySelector('[data-bots-worker-panel-elsewhere]')?.textContent).toContain('botsPage.chat.openInWorkspaces');
  });

  it('its menu opens on the first item and the arrows move between Resume and Open in Workspaces', () => {
    act(() => useStore.setState({ workspaces: [ws] } as never));
    const onResume = vi.fn();
    const el = mount(<BotsWorkerPanel workspaceId="t1" hosted name="fix login" state="Done" attention={false} t={t} onClose={() => undefined} onResume={onResume} />);
    act(() => (el.querySelector('[data-bots-worker-panel-menu]') as HTMLButtonElement).click());
    expect(document.activeElement?.hasAttribute('data-bots-worker-panel-resume')).toBe(true);
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement?.hasAttribute('data-bots-worker-panel-workspaces')).toBe(true);
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(onResume).toHaveBeenCalledTimes(1);
    // The menu closed and focus went back to its ⋯.
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.hasAttribute('data-bots-worker-panel-menu')).toBe(true);
  });

  it('renders nothing once the workspace is gone', () => {
    act(() => useStore.setState({ workspaces: [] } as never));
    const el = mount(<BotsWorkerPanel workspaceId="t1" hosted name="x" state={null} attention={false} t={t} onClose={() => undefined} />);
    expect(el.querySelector('[data-bots-worker-panel]')).toBeNull();
  });
});
