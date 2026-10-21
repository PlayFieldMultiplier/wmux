// #2398 — how long a raw terminal write (input.send / input.sendKey, MCP
// terminal_send / terminal_send_key) may take, as one budget main and the MCP
// client both read.
//
// A write to a pane whose shell has not started starts it first (owner
// decision §6-6), and a WSL create can take its whole RPC budget. The client
// used to give the write its 10 s per-call default while main waited up to
// the create's budget: the client reported a timeout, main went on, started
// the shell and wrote — and the caller's retry of the "failed" write ran the
// command a second time. Now the start phase has its own budget, main stops
// the write (nothing written) once that budget is spent, and the client waits
// for the start budget plus the delivery budget it always had, so a write main
// completes always lands inside the client's wait.
//
// An MCP host keeps a tool-call timeout of its own over that wait, and a host
// that gives up does not cancel the call, so an MCP write keeps its whole
// deadline inside the strictest host's timeout (MCP_WRITE_DEADLINE_MS). A
// start that takes longer than its window is not cancelled: main answers
// "still starting, nothing written", and the caller's retry joins the start
// still in flight (the renderer runs one start per pane) and writes once.

import { WSL_RPC_TIMEOUT_MS } from './wslTimeouts';

/**
 * The start phase of a raw write: a WSL create's budget plus the
 * main→renderer hop. Main gives every start it waits on only what is left of
 * it, and writes nothing once it is spent.
 */
export const TERMINAL_START_BUDGET_MS = WSL_RPC_TIMEOUT_MS + 5_000;

/** The delivery a raw write always had: the MCP client's per-call default. */
export const TERMINAL_WRITE_DELIVERY_BUDGET_MS = 10_000;

/**
 * The strictest tool-call timeout of an MCP host wmux supports: Codex's
 * default `tool_timeout_sec` (60 s).
 */
export const STRICTEST_MCP_TOOL_TIMEOUT_MS = 60_000;

/**
 * An MCP raw write's whole deadline (terminal_send, terminal_send_key): the
 * start window and the delivery together, 10 s inside
 * STRICTEST_MCP_TOOL_TIMEOUT_MS for the host's transport and the server's
 * routing before the write. The MCP server waits this long and sends it as
 * `clientTimeoutMs`, so main's start window is this minus the delivery: 40 s,
 * or 25 s for a new task (TERMINAL_SEND_NEW_TASK_TIMEOUT_MS). A start that
 * takes longer goes on, and a retry writes once it is up.
 */
export const MCP_WRITE_DEADLINE_MS = 50_000;

/**
 * A deadline for a raw write by a caller with no host timeout over it (the
 * CLI) that lets a terminal start in full: the start phase, then the delivery
 * (`deliveryBudgetMs`: a new-task send's is longer). Sent as the write's
 * `clientTimeoutMs`. An MCP write uses MCP_WRITE_DEADLINE_MS instead.
 */
export function terminalWriteClientTimeoutMs(deliveryBudgetMs: number = TERMINAL_WRITE_DELIVERY_BUDGET_MS): number {
  return TERMINAL_START_BUDGET_MS + deliveryBudgetMs;
}

/**
 * How long main may spend starting a pane for one raw write: the start
 * budget, cut to what the caller's own deadline (`clientTimeoutMs`, sent with
 * the write) leaves after the delivery. Main stops there with nothing written,
 * so whatever deadline a caller keeps (MCP, CLI, any later one), a write main
 * completes still lands inside it. A caller that sends none gets the start
 * budget.
 */
export function terminalStartWindowMs(clientTimeoutMs: unknown, deliveryBudgetMs: number): number {
  if (typeof clientTimeoutMs !== 'number' || !Number.isFinite(clientTimeoutMs) || clientTimeoutMs <= 0) {
    return TERMINAL_START_BUDGET_MS;
  }
  return Math.min(TERMINAL_START_BUDGET_MS, clientTimeoutMs - deliveryBudgetMs);
}
