import type { StoreApi } from 'zustand';
import type { StoreState } from './index';
import type { PaneLeaf, Surface } from '../../shared/types';
import { findLeaf, findLeafBySurfaceId } from '../../shared/paneUtils';

/** The tab a close-tab confirm is for (the tab x or the close-tab shortcut). */
export interface CloseTabTarget {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}

/**
 * Where the target's surface is now: the pane it names, or, when it moved to
 * another pane or workspace, the one that holds it. Null once it is gone.
 */
export function resolveCloseTabTarget(
  state: Pick<StoreState, 'workspaces'>,
  target: CloseTabTarget,
): { workspaceId: string; pane: PaneLeaf; surface: Surface } | null {
  const named = state.workspaces.find((w) => w.id === target.workspaceId);
  const namedPane = named ? findLeaf(named.rootPane, target.paneId) : null;
  const here = namedPane?.surfaces.find((s) => s.id === target.surfaceId);
  if (named && namedPane && here) return { workspaceId: named.id, pane: namedPane, surface: here };
  for (const ws of state.workspaces) {
    const pane = findLeafBySurfaceId(ws.rootPane, target.surfaceId);
    const surface = pane?.surfaces.find((s) => s.id === target.surfaceId);
    if (pane && surface) return { workspaceId: ws.id, pane, surface };
  }
  return null;
}

const registered = new WeakSet<object>();

/**
 * Keep the close-tab confirm on its tab, whichever way the store changes:
 * a tab that moved to another pane or workspace keeps its confirm, which
 * follows it; a tab that is gone (a closed surface or pane, a removed
 * workspace, a loaded session, a shell that exited) dismisses it. Many store
 * actions move or remove surfaces; one check covers all of them, and any
 * added later. Registered once per store.
 */
export function registerCloseTabConfirmInvariant(store: StoreApi<StoreState>): void {
  if (registered.has(store)) return;
  registered.add(store);
  store.subscribe((state, prev) => {
    // Only a change to the workspaces or to the confirm itself can move or
    // remove its tab; nothing open, nothing to do.
    if (state.workspaces === prev.workspaces && state.closeTabConfirm === prev.closeTabConfirm) return;
    const target = state.closeTabConfirm;
    if (!target) return;
    const found = resolveCloseTabTarget(state, target);
    // The set below runs inside this notification, once, on the change that
    // moved or removed the tab; the next pass finds nothing to do.
    if (!found) {
      state.dismissCloseTab();
    } else if (found.workspaceId !== target.workspaceId || found.pane.id !== target.paneId) {
      store.setState({ closeTabConfirm: { workspaceId: found.workspaceId, paneId: found.pane.id, surfaceId: target.surfaceId } });
    }
  });
}
