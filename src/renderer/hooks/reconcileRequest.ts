/**
 * #2398 — how a pane asks AppLayout for a reconcile pass.
 *
 * A binding kept unconfirmed through a failed startup reconcile must not be
 * cleared by the pane's own reattach when the daemon says the id is gone: the
 * surface's session may live on under another id, and only the reconcile can
 * rebind it (reconnectPtyWithRetry). AppLayout owns the reconcile and
 * registers the requester; the panes reach it through this module, the same
 * way they read the daemon-mode flag, without a React path between them.
 */

import type { Workspace } from '../../shared/types';
import { findWorkspaceSurfaceByPtyId } from '../utils/paneTraversal';

/** Requests within this window share one pass (panes ask together after a stall). */
export const RECONCILE_REQUEST_COALESCE_MS = 300;

let requester: ((reason: string) => void) | null = null;
/** Whether a requester was ever registered: this renderer runs reconciles. */
let registeredOnce = false;
/** A request made while AppLayout was remounting (HMR, StrictMode). */
let pending: string | null = null;

/** Register the requester; returns the unregister function. */
export function setReconcileRequester(fn: (reason: string) => void): () => void {
  requester = fn;
  registeredOnce = true;
  if (pending !== null) {
    const reason = pending;
    pending = null;
    fn(reason);
  }
  return () => {
    if (requester === fn) requester = null;
  };
}

/**
 * Ask for a pass. False when this renderer never registered a requester (no
 * AppLayout runs reconciles here). Between an unregister and the next
 * register — AppLayout remounting — the request is held for the next one:
 * answering false there made the pane clear a binding the reconcile could
 * still have rebound.
 */
export function requestReconcile(reason: string): boolean {
  if (requester) {
    requester(reason);
    return true;
  }
  if (!registeredOnce) return false;
  pending ??= reason;
  return true;
}

/**
 * Whether a pane's binding should wait on a reconcile when the daemon reports
 * it gone: it is kept unconfirmed, and it is a workspace surface's binding —
 * the reconcile walks surfaces only, so anything else (the floating pane)
 * would wait on passes that never look at it, and clears at once instead.
 */
export function awaitsReconcile(
  state: { ptyUnconfirmedById?: Record<string, number>; workspaces: readonly Workspace[] },
  ptyId: string,
): boolean {
  if (!state.ptyUnconfirmedById?.[ptyId]) return false;
  return state.workspaces.some((ws) => findWorkspaceSurfaceByPtyId(ws, ptyId) !== null);
}
