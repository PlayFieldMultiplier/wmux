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

/** Requests within this window share one pass (panes ask together after a stall). */
export const RECONCILE_REQUEST_COALESCE_MS = 300;

let requester: ((reason: string) => void) | null = null;

/** Register the requester; returns the unregister function. */
export function setReconcileRequester(fn: (reason: string) => void): () => void {
  requester = fn;
  return () => {
    if (requester === fn) requester = null;
  };
}

/** Ask for a pass. False when nothing is registered to run one. */
export function requestReconcile(reason: string): boolean {
  if (!requester) return false;
  requester(reason);
  return true;
}
