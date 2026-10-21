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
  /**
   * #2398 — a join-only call (a stop key, a repaint) found no attempt in
   * flight to join, and started none: the session was left as it was.
   */
  notInFlight?: boolean;
  error?: { code: string; message: string };
};

/** Who started an attempt: the boot background start, or an RPC caller. */
export type PromoteOrigin = 'background' | 'rpc';

export function createPromoteOnce(
  promoteSession: (params: { id: string; fresh: boolean }) => Promise<PromoteResult>,
): (id: string, startFresh?: boolean, origin?: PromoteOrigin, joinOnly?: boolean) => Promise<PromoteResult> {
  const promotionInFlight = new Map<string, { operation: Promise<PromoteResult>; startFresh: boolean; origin: PromoteOrigin }>();
  const joinOf = (existing: { operation: Promise<PromoteResult>; origin: PromoteOrigin }) =>
    (existing.origin === 'background' ? existing.operation.then((r) => ({ ...r, joined: true })) : existing.operation);
  return (id, startFresh = false, origin = 'rpc', joinOnly = false) => {
    const existing = promotionInFlight.get(id);
    // #2398 — a join-only caller (a stop key) never starts the session: it
    // joins whatever attempt is in flight, and with none it is answered so.
    if (joinOnly) return existing ? joinOf(existing) : Promise.resolve({ ok: false, notInFlight: true });
    // Same intent → one attempt, as before. A DIFFERENT intent must not be
    // answered by the one already running: start-fresh exists because the
    // ordinary promote fails, so handing back that promote's result would
    // answer a question the user did not ask (#1305). Queue behind it instead —
    // and if the one in flight happens to succeed, the idempotent
    // already-active check makes the second a no-op.
    if (existing && existing.startFresh === startFresh) return joinOf(existing);
    const run = () => promoteSession({ id, fresh: startFresh });
    const operation: Promise<PromoteResult> = (existing ? existing.operation.catch(() => undefined).then(run) : run())
      .finally(() => {
        if (promotionInFlight.get(id)?.operation === operation) promotionInFlight.delete(id);
      });
    promotionInFlight.set(id, { operation, startFresh, origin });
    return operation;
  };
}
