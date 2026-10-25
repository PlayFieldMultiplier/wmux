// ─── Stop the agent in a pane, keep the pane ────────────────────────────────
//
// main asks for this when a factory worker's task has ended (completed or
// cancelled) and the worker's agent should stop holding memory: the agent
// process and everything below it (its MCP servers and tools) stop, while the
// pane's shell, its scrollback and the session record (with the agent's
// resume binding) stay, so the same conversation can be resumed in the same
// folder later.
//
// The agent is asked to exit first (SIGTERM: it closes its MCP servers
// itself). What is still running after the grace — the agent, or a process
// that was below it when the stop began and still has the same pid, image
// name and command line (on Windows also creation time) — is killed. Only
// processes found under the session's own verified agent are ever signalled,
// and a process table that cannot be read fails the stop (it is never read as
// "nothing runs"). A process the tree could not place for sure (`uncertain`),
// or one a later read cannot prove the same, is never signalled, but the stop
// is not confirmed while it still runs.

import type { ProcessTreeEntry } from './AgentProcessTracker';

export const AGENT_STOP_GRACE_MS = 5_000;
const POLL_MS = 200;

export interface AgentStopDeps {
  /** The agent and every process below it, or null when no such agent runs.
   *  `uncertain`: processes that may be below it, never signalled. */
  tree: () => Promise<{ root: ProcessTreeEntry; descendants: ProcessTreeEntry[]; uncertain?: ProcessTreeEntry[] } | null>;
  /** Of these, the ones still running (same pid, image name and command
   *  line). Split, `unsure` are the ones not proven the same process (on
   *  Windows, a creation time missing on either side): never killed. */
  stillRunning: (entries: readonly ProcessTreeEntry[]) => Promise<ProcessTreeEntry[] | { same: ProcessTreeEntry[]; unsure: ProcessTreeEntry[] }>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
  /** A conditional stop (main's idle stop of a reported worker): asked once
   *  the tree is known, right before the first signal; false refuses the
   *  stop (`turn_open`) and nothing is signalled. */
  stillIdle?: () => boolean;
}

export type AgentStopResult =
  | { ok: true; stopped: false }
  | { ok: true; stopped: true; pid: number; killed: number }
  | { ok: false; code: 'still_running'; pid: number }
  | { ok: false; code: 'turn_open' };

/** Whether a pane's turn is over by the daemon's own state: a turn known
 *  closed, no running turn, no prompt waiting. Pure. */
export function paneTurnClosed(state: { agentStatus: string; turnOpen: boolean | undefined }): boolean {
  return state.turnOpen === false && state.agentStatus !== 'running' && state.agentStatus !== 'awaiting_input';
}

export async function stopAgentTree(deps: AgentStopDeps): Promise<AgentStopResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tree = await deps.tree();
  if (!tree) return { ok: true, stopped: false };
  if (deps.stillIdle && !deps.stillIdle()) return { ok: false, code: 'turn_open' };
  const all = [tree.root, ...tree.descendants];
  const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
      deps.kill(pid, sig);
    } catch {
      /* already gone */
    }
  };
  const running = async (entries: readonly ProcessTreeEntry[]) => {
    const r = await deps.stillRunning(entries);
    return Array.isArray(r) ? { same: r, unsure: [] } : r;
  };
  signal(tree.root.pid, 'SIGTERM');
  const graceMs = deps.graceMs ?? AGENT_STOP_GRACE_MS;
  for (let waited = 0; waited < graceMs; waited += POLL_MS) {
    const root = await running([tree.root]);
    if (root.same.length + root.unsure.length === 0) break;
    await sleep(POLL_MS);
  }
  const pending = [...all, ...(tree.uncertain ?? [])];
  let left = await running(pending);
  // Killed: only a process of the tree proven to be the one found then.
  const toKill = left.same.filter((e) => all.some((a) => a.pid === e.pid));
  for (const e of toKill) signal(e.pid, 'SIGKILL');
  if (toKill.length > 0) {
    await sleep(POLL_MS);
    left = await running(pending);
  }
  // Anything of the tree still running (a kill that was refused, a process
  // never signalled because it was uncertain or unsure) is not a stop.
  if (left.same.length + left.unsure.length > 0) return { ok: false, code: 'still_running', pid: tree.root.pid };
  return { ok: true, stopped: true, pid: tree.root.pid, killed: all.length };
}
