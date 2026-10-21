// One promote attempt per suspended session at a time (daemon.promoteSession,
// the boot background start of exec units and supervised sessions, and an
// attach that promotes all share it).

/** What a promote attempt answers — see `promoteSession` in index.ts. */
export type PromoteResult = {
  ok: boolean;
  alreadyActive?: boolean;
  /**
   * #2398 — this caller joined an attempt already in flight (another caller's,
   * or the boot background start) instead of starting one: the session it
   * gets back was started by someone else. Only the daemon knows which, and a
   * stop key must never land in a session its own call just started.
   */
  joined?: boolean;
  error?: { code: string; message: string };
};

export function createPromoteOnce(
  promoteSession: (params: { id: string; fresh: boolean }) => Promise<PromoteResult>,
): (id: string, startFresh?: boolean) => Promise<PromoteResult> {
  const promotionInFlight = new Map<string, { operation: Promise<PromoteResult>; startFresh: boolean }>();
  return (id, startFresh = false) => {
    const existing = promotionInFlight.get(id);
    // Same intent → one attempt, as before. A DIFFERENT intent must not be
    // answered by the one already running: start-fresh exists because the
    // ordinary promote fails, so handing back that promote's result would
    // answer a question the user did not ask (#1305). Queue behind it instead —
    // and if the one in flight happens to succeed, the idempotent
    // already-active check makes the second a no-op.
    if (existing && existing.startFresh === startFresh) return existing.operation.then((r) => ({ ...r, joined: true }));
    const run = () => promoteSession({ id, fresh: startFresh });
    const operation: Promise<PromoteResult> = (existing ? existing.operation.catch(() => undefined).then(run) : run())
      .finally(() => {
        if (promotionInFlight.get(id)?.operation === operation) promotionInFlight.delete(id);
      });
    promotionInFlight.set(id, { operation, startFresh });
    return operation;
  };
}
