/**
 * Late-reconcile trigger for `daemon:connected`.
 *
 * Extracted from AppLayout's inline listener as a pure, dependency-injected
 * factory (no zustand / electron import) so the gating decision can be
 * unit-tested in isolation — mirroring reconcileWithReQuery.ts.
 *
 * Two layers of protection live here:
 *
 * 1. paneGate gate (S-A Step 1). With the renderer now loading in parallel
 *    with the daemon bootstrap, the INITIAL daemon:connected can arrive
 *    while the startup reconcile is still pending (under the old serialized
 *    boot it was emitted before this listener existed and was simply lost).
 *    The startup path owns that first reconcile — it is serialized behind
 *    daemon.whenReady() and flips paneGate when done. This listener is
 *    strictly for LATE connects (respawn/reconnect), so it bails while the
 *    gate is still pending.
 *
 *    Skipping is information-lossless only because a daemon respawn cannot
 *    complete inside the startup window: DaemonRespawnController enforces a
 *    ≥1 s minimum backoff, far longer than the pty.list → gate-flip gap, so
 *    a skipped connect during startup is always the INITIAL connect whose
 *    state the startup reconcile is about to read anyway. If that backoff
 *    floor is ever tuned below the reconcile gap, revisit this gate.
 *
 * 2. RCA A1/A3 guards. The late reconcile previously ran as a bare
 *    reconcilePtys() with NO abort, timeout, or catch (unlike the startup
 *    path's 5 guards). A pty.list rejection escaped as an unhandled
 *    rejection, and the call could outlive a fresher reconcile. Failures
 *    are swallowed by PRESERVING ptyIds — never fall through to
 *    clearAllPtyState here (that destructive fallback is startup-only).
 */

export interface LateReconcileDeps {
  /** Read the current pane gate ('pending' until the startup reconcile resolves). */
  getPaneGate: () => 'pending' | 'ready';
  /** The shared reconcile entry point (AppLayout's reconcilePtys). */
  reconcile: (signal: AbortSignal) => Promise<void>;
  /** Abort budget per attempt (RECONCILE_TIMEOUT_MS in production). */
  timeoutMs: number;
  /** Optional structured logger. Defaults to console. */
  log?: (level: 'log' | 'warn', message: string, err?: unknown) => void;
}

export function createLateReconcileOnConnect(deps: LateReconcileDeps): {
  /** Wire this to electronAPI.daemon.onConnected. */
  onConnected: () => void;
  /**
   * #2398 — run the same guarded reconcile for another reason than a connect:
   * the startup reconcile timed out and kept every binding unconfirmed, and
   * no daemon:connected is coming (the daemon never disconnected); or a pane
   * found its unconfirmed binding gone. Unlike a connect it never aborts a
   * pass in flight: it runs once more after that pass settles, so a stream of
   * requests cannot keep restarting a reconcile before it finishes.
   */
  rerun: (reason: string) => void;
  /** Abort any in-flight late reconcile (effect cleanup). */
  dispose: () => void;
} {
  let activeCtl: AbortController | null = null;
  let running = false;
  let rerunAfter: string | null = null;
  const log =
    deps.log ??
    ((level: 'log' | 'warn', message: string, err?: unknown) => {
      // eslint-disable-next-line no-console
      if (err === undefined) console[level](message);
      // eslint-disable-next-line no-console
      else console[level](message, err);
    });

  const run = (startMessage: string) => {
    log('log', startMessage);
    // A newer connect supersedes any still-running late reconcile.
    activeCtl?.abort();
    const ctl = new AbortController();
    activeCtl = ctl;
    running = true;
    const timer = setTimeout(() => ctl.abort(), deps.timeoutMs);
    void deps
      .reconcile(ctl.signal)
      .catch((err: unknown) => {
        log('warn', '[lifecycle] late reconcile failed — preserving ptyIds (no clear):', err);
      })
      .finally(() => {
        clearTimeout(timer);
        if (activeCtl !== ctl) return;
        running = false;
        const reason = rerunAfter;
        rerunAfter = null;
        if (reason !== null && !ctl.signal.aborted && deps.getPaneGate() === 'ready') {
          run(`[lifecycle] ${reason} — re-reconciling PTYs`);
        }
      });
  };

  return {
    onConnected: () => {
      if (deps.getPaneGate() !== 'ready') {
        log('log', '[lifecycle] daemon connected during startup — skipping late reconcile (startup path owns it)');
        return;
      }
      run('[lifecycle] daemon connected late — re-reconciling PTYs');
    },
    rerun: (reason) => {
      if (deps.getPaneGate() !== 'ready') return;
      if (running) {
        rerunAfter ??= reason;
        return;
      }
      run(`[lifecycle] ${reason} — re-reconciling PTYs`);
    },
    dispose: () => {
      rerunAfter = null;
      activeCtl?.abort();
    },
  };
}
