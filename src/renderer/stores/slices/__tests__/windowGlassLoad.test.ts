// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';

// The saved glass level must be restored even from a session with no
// workspaces: main builds the window from that saved level, and the glass
// sync sends the store's level once the session is loaded, so a skipped
// restore would switch a saved Off back to the default Soft.
// Same combo-store harness as shortcutOverrides.load.test.ts.
type ComboState = WorkspaceSlice & PaneSlice & {
  zoomedPaneId: string | null;
  pushToast: ReturnType<typeof vi.fn>;
  multiviewIds: string[];
  sidebarVisible: boolean;
  windowGlass: string;
};

function createComboStore() {
  const seed: Workspace[] = [createWorkspace('Test', 1)];
  return create<ComboState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
      workspaces: seed,
      activeWorkspaceId: seed[0].id,
      nextWorkspaceOrdinal: 2,
      zoomedPaneId: null,
      pushToast: vi.fn(),
      multiviewIds: [],
      sidebarVisible: false,
      windowGlass: 'soft',
    })),
  );
}

afterEach(() => {
  document.documentElement.removeAttribute('data-glass-level');
});

describe('loadSession — window glass', () => {
  it('restores a saved Off from a session with no workspaces', () => {
    const store = createComboStore();
    store.getState().loadSession({ workspaces: [], activeWorkspaceId: '', sidebarVisible: false, windowGlass: 'off' });
    expect(store.getState().windowGlass).toBe('off');
    expect(document.documentElement.getAttribute('data-glass-level')).toBe('off');
  });

  it('restores the level from a session with workspaces', () => {
    const store = createComboStore();
    store.getState().loadSession({
      workspaces: [createWorkspace('Loaded', 1)],
      activeWorkspaceId: '',
      sidebarVisible: false,
      windowGlass: 'clear',
    });
    expect(store.getState().windowGlass).toBe('clear');
    expect(document.documentElement.getAttribute('data-glass-level')).toBe('clear');
  });
});
