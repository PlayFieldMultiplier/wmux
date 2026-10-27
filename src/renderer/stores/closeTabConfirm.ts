import type { StoreApi } from 'zustand';
import type { StoreState } from './index';
import { findLeaf } from '../../shared/paneUtils';

export interface CloseTabConfirmTarget {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}

/** True while the tab a close-tab confirm names is still in the store: its
 *  workspace, that pane, and that surface in it. */
export function closeTabTargetLive(state: Pick<StoreState, 'workspaces'>, target: CloseTabConfirmTarget): boolean {
  const ws = state.workspaces.find((w) => w.id === target.workspaceId);
  const pane = ws ? findLeaf(ws.rootPane, target.paneId) : null;
  return !!pane?.surfaces.some((s) => s.id === target.surfaceId);
}

const registered = new WeakSet<object>();

/**
 * Dismiss the close-tab confirm once its tab is gone, whichever way it went:
 * a closed surface or pane, a removed workspace, a loaded session, a shell
 * that exited. Many store actions remove surfaces; one check after every
 * change covers all of them, and any added later. Registered once per store.
 */
export function registerCloseTabConfirmInvariant(store: StoreApi<StoreState>): void {
  if (registered.has(store)) return;
  registered.add(store);
  store.subscribe((state) => {
    // Nothing open, or its own dismiss just ran: no work, no loop.
    const target = state.closeTabConfirm;
    if (!target || closeTabTargetLive(state, target)) return;
    state.dismissCloseTab();
  });
}
