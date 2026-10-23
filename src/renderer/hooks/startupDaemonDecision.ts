/**
 * The first half of AppLayout's startup restore: the saved session, then
 * main's daemon-or-local decision (`daemon.whenReady`).
 *
 * Every path awaits that decision before it returns, a first launch with
 * nothing saved included. The caller opens the pane gate only after this
 * settles, and the gate is what keeps every renderer `pty.create` closed: a
 * pane created before the decision would be a local PTY, minted against the
 * handlers main is about to swap for the daemon's (main/index.ts, "the
 * renderer's first daemon.whenReady() invoke parks...").
 *
 * The saved session is restored before the wait, so the layout shows while
 * main finishes its bootstrap. Pure: every effect is a port.
 */
export interface StartupDaemonDecisionDeps<S> {
  load: () => Promise<S | null | undefined>;
  /** A first launch: nothing was saved. */
  nothingSaved: () => void;
  restore: (saved: S) => void;
  whenReady: () => Promise<{ connected: boolean }>;
  /** Set before the gate opens, so Terminals mount knowing the mode. */
  setDaemonModeActive: (connected: boolean) => void;
}

export async function loadSessionThenDaemonDecision<S>(
  deps: StartupDaemonDecisionDeps<S>,
): Promise<{ saved: S | null; daemonConnected: boolean }> {
  const saved = (await deps.load()) ?? null;
  if (saved === null) deps.nothingSaved();
  else deps.restore(saved);
  const ready = await deps.whenReady();
  deps.setDaemonModeActive(ready.connected);
  return { saved, daemonConnected: ready.connected };
}
