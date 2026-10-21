// #2398 — what happens to a suspended session (a WSL placeholder, or one the
// recovery cap left on disk) that nobody has shown: shared by the daemon's
// boot-time background promote and main's pty:reconnect, so the two never
// disagree about which sessions start on their own.

/**
 * Owner decision §6-4: the daemon promotes a pending recovery in the
 * background right after boot only for an exec unit or a supervised session,
 * which must run whether or not anyone looks at it. A plain shell starts when
 * its pane is first shown.
 */
export function recoversInBackground(session: { exec?: unknown; supervision?: unknown }): boolean {
  return !!session.exec || !!session.supervision;
}

/**
 * What pty:reconnect does with a suspended session: 'promote' — the caller
 * asks for that explicitly (a shown pane, a raw write, a resume on start),
 * and this call starts it; 'join' — the caller did not ask, but the daemon
 * is starting it in the background anyway (an exec unit or supervised
 * session), so the call promotes only to join that start and starts nothing
 * itself; 'hold' — otherwise: attached to nothing, kept in use, and answered
 * `deferred`. A reconnect that does not say (a repaint fallback, a read)
 * never starts a session.
 */
export function suspendedReconnectAction(
  session: { exec?: unknown; supervision?: unknown },
  opts: { promote?: boolean } | undefined,
): 'promote' | 'join' | 'hold' {
  if (opts?.promote === true) return 'promote';
  return recoversInBackground(session) ? 'join' : 'hold';
}
