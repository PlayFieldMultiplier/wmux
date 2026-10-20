// ─── Is a pane free to be typed into? ───────────────────────────────────────
//
// Two writers type a line into a pane's shell on their own: "Continue on
// another account" (the resume line, continueOnAccount.ts) and chat v2 (the
// agent launch). Each first asks whether the pane runs nothing: the agent wmux
// tracked there is no longer running, and the shell has no children at all (a
// tracked agent can miss a TUI that just started or a reused pid).
//
// "No longer running" is a liveness question. ProcessMonitor.isRunning alone
// does not answer it: it only rules out a stopped or zombie process on POSIX,
// and on Windows, which has no such states, it is true for any pid, a pid that
// has exited included. Asked alone, it kept every pane that ever ran an agent
// busy on Windows, so Continue on another account never relaunched there
// (#2507). The pid must first not be proven gone. A probe that cannot tell
// counts as running: the answer decides whether wmux types into the pane.

export interface PaneFreeDeps {
  /** The pane's shell runs nothing (no agent, no children). */
  shellIdle: () => Promise<boolean>;
  /** The pid of the agent wmux tracks in the pane, if any (none for a WSL
   *  agent, whose pid is a Linux one). */
  trackedAgentPid: () => number | undefined;
  /** True only when a probe that worked found no such process; rejects when
   *  the probe itself fails (ProcessMonitor.isDefinitelyDead). */
  isDefinitelyDead: (pid: number) => Promise<boolean>;
  /** False for a stopped or zombie process on POSIX, true on Windows
   *  (ProcessMonitor.isRunning). */
  isRunning: (pid: number) => Promise<boolean>;
}

export async function paneFree(deps: PaneFreeDeps): Promise<boolean> {
  const pid = deps.trackedAgentPid();
  if (pid !== undefined) {
    const gone = await deps.isDefinitelyDead(pid).catch(() => false);
    if (!gone && await deps.isRunning(pid)) return false;
  }
  return deps.shellIdle();
}
