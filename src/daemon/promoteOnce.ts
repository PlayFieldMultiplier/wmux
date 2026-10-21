// One promote attempt per suspended session at a time (daemon.promoteSession,
// the boot background start of exec units and supervised sessions, and an
// attach that promotes all share it).

/** What a promote attempt answers — see `promoteSession` in index.ts. */
export type PromoteResult = {
  ok: boolean;
  alreadyActive?: boolean;
  /**
   * #2398 — this caller joined the boot background start already in flight
   * instead of starting the session: that start runs whatever any caller
   * does, so a stop key to the session is a real stop request. Not set for a
   * join of another caller's promote (a raw write, a shown pane): that caller
   * just started it, and a stop key must not land in it. Only the daemon
   * knows which.
   */
  joined?: boolean;
  error?: { code: string; message: string };
};

/** Who started an attempt: the boot background start, or an RPC caller. */
export type PromoteOrigin = 'background' | 'rpc';

export function createPromoteOnce(
  promoteSession: (params: { id: string; fresh: boolean }) => Promise<PromoteResult>,
): (id: string, startFresh?: boolean, origin?: PromoteOrigin) => Promise<PromoteResult> {
  const promotionInFlight = new Map<string, { operation: Promise<PromoteResult>; startFresh: boolean; origin: PromoteOrigin }>();
  return (id, startFresh = false, origin = 'rpc') => {
    const existing = promotionInFlight.get(id);
    // Same intent → one attempt, as before. A DIFFERENT intent must not be
    // answered by the one already running: start-fresh exists because the
    // ordinary promote fails, so handing back that promote's result would
    // answer a question the user did not ask (#1305). Queue behind it instead —
    // and if the one in flight happens to succeed, the idempotent
    // already-active check makes the second a no-op.
    if (existing && existing.startFresh === startFresh) {
      return existing.origin === 'background' ? existing.operation.then((r) => ({ ...r, joined: true })) : existing.operation;
    }
    const run = () => promoteSession({ id, fresh: startFresh });
    const operation: Promise<PromoteResult> = (existing ? existing.operation.catch(() => undefined).then(run) : run())
      .finally(() => {
        if (promotionInFlight.get(id)?.operation === operation) promotionInFlight.delete(id);
      });
    promotionInFlight.set(id, { operation, startFresh, origin });
    return operation;
  };
}
