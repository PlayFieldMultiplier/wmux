// @vitest-environment jsdom
//
// A workspace another PC started (remote spawn) says so in its panes' header:
// one neutral chip "Started remotely by {name}". It is provenance, not state,
// so it carries no colour (DESIGN.md: colour carries state only), and it is
// counted in the header's extra chrome so it cannot push the ⋮ off a narrow
// pane.
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs, { paneHeaderExtraChromeWidth, REMOTE_SPAWN_CHIP_MIN_WIDTH } from '../SurfaceTabs';
import { useStore } from '../../../stores';
import type { Surface, Workspace } from '../../../../shared/types';
import type { A2aRemoteSpawnedBy } from '../../../../shared/a2aSpawn';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const BY: A2aRemoteSpawnedBy = {
  hostId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  name: 'DESK',
  spawnId: 'sp-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  agent: 'claude',
};

const surface: Surface = { id: 'surf-1', ptyId: 'pty-1', title: 'WMUX', shell: 'bash', cwd: 'D:/repo' };

function activeWs(): Workspace {
  return useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

function mount(workspace: Workspace): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces: [surface],
        activeSurfaceId: 'surf-1',
        workspace,
        paneId: workspace.rootPane.id,
        paneActive: true,
        onSelect: () => undefined,
        onClose: () => undefined,
        onSplitHorizontal: () => undefined,
        onSplitVertical: () => undefined,
        onAddTerminal: () => undefined,
        onAddBrowser: () => undefined,
      }),
    );
  });
}

const chip = () => container.querySelector<HTMLElement>('[data-pane-remote-spawn]');

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SurfaceTabs — started remotely chip', () => {
  it('is absent on an ordinary workspace', () => {
    mount(activeWs());
    expect(chip()).toBeNull();
  });

  it('names the PC, in neutral tones only', () => {
    mount({ ...activeWs(), remoteSpawnedBy: BY } as Workspace);
    const el = chip();
    expect(el?.textContent).toBe('Started remotely by DESK');
    expect(el?.title).toBe('Started remotely by DESK');
    expect(el?.className).toContain('text-[var(--text-muted)]');
    expect(el?.className).not.toMatch(/accent|attention|warning|danger/);
    expect(el?.getAttribute('style')).toBeNull();
  });

  it('is counted in the header chrome', () => {
    const base = { chatToggle: false, enforcedModelBadge: false };
    expect(paneHeaderExtraChromeWidth({ ...base, remoteSpawnChip: true }) - paneHeaderExtraChromeWidth(base)).toBe(
      REMOTE_SPAWN_CHIP_MIN_WIDTH,
    );
  });
});
