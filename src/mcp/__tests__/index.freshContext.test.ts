import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FRESH_CONTEXT_LOCK_WAIT_MS,
  FRESH_CONTEXT_TIMEOUT_MS,
  NEW_TASK_SEND_CLIENT_TIMEOUT_MS,
  NEW_TASK_SEND_MAIN_TIMEOUT_MS,
  TERMINAL_SEND_NEW_TASK_TIMEOUT_MS,
} from '../../shared/freshContext';

// #1680 — terminal_send `new_task` and the new-task timeouts. Source-level,
// like the other invariants over src/mcp/index.ts: the shapes and handlers are
// module-private.
describe('MCP fresh context per task (#1680)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
  const between = (from: string, to: string): string => {
    const start = src.indexOf(from);
    expect(start, from).toBeGreaterThan(0);
    return src.slice(start, src.indexOf(to, start));
  };

  it('terminal_send takes new_task, described as a new-task-only signal that needs submit', () => {
    const shape = between('const TERMINAL_SEND_SHAPE', 'const TERMINAL_SEND_KEY_SHAPE');
    expect(shape).toMatch(/new_task: z\.boolean\(\)\.optional\(\)/);
    expect(shape).toMatch(/with submit/);
    expect(shape).toMatch(/never for a follow-up/);
    expect(shape).toMatch(/NOT sent/);
  });

  it('terminal_send forwards newTask and waits out the fresh-context step', () => {
    const handler = between("'terminal_send',", "'terminal_send_key',");
    expect(handler).toMatch(/base\.newTask = true/);
    // #2398: within the MCP write deadline (terminalWriteBudget.ts), which
    // main's start window gives the fresh-context step its delivery out of.
    expect(handler).toMatch(/if \(new_task\) base\.newTask = true;/);
    expect(handler).toMatch(/callRpc\('input\.send', base, MCP_WRITE_DEADLINE_MS\)/);
  });

  it('send_message gets no new param; a new task (no task_id) gets the longer client budget', () => {
    const shape = between('const SEND_MESSAGE_SHAPE', 'export function createWmuxServer');
    expect(shape).not.toMatch(/new_task/);
    expect(src).toMatch(/!task_id\s*\?\s*callRpc\('a2a\.task\.send', params, NEW_TASK_SEND_CLIENT_TIMEOUT_MS\)/);
  });

  it('every layer outwaits the one below it', () => {
    // The step itself plus the reads around it and the paste after it.
    expect(NEW_TASK_SEND_MAIN_TIMEOUT_MS).toBeGreaterThan(FRESH_CONTEXT_TIMEOUT_MS + 5_000);
    expect(NEW_TASK_SEND_CLIENT_TIMEOUT_MS).toBeGreaterThan(NEW_TASK_SEND_MAIN_TIMEOUT_MS);
    // input.send: the step plus the ordinary 2 s submit receipt.
    expect(TERMINAL_SEND_NEW_TASK_TIMEOUT_MS).toBeGreaterThan(FRESH_CONTEXT_TIMEOUT_MS + 5_000);
    // Worst cases with every read at its own timeout (review N3): lock wait,
    // the a2a task-store read (2 s), the echo wait (1.5 s), the step, and a
    // few seconds of gates, reads, paste or submit receipt.
    const slack = 4_000;
    expect(NEW_TASK_SEND_MAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(
      FRESH_CONTEXT_LOCK_WAIT_MS + 2_000 + 1_500 + FRESH_CONTEXT_TIMEOUT_MS + slack,
    );
    expect(TERMINAL_SEND_NEW_TASK_TIMEOUT_MS).toBeGreaterThanOrEqual(
      FRESH_CONTEXT_LOCK_WAIT_MS + 1_500 + FRESH_CONTEXT_TIMEOUT_MS + 2_000 + slack,
    );
  });
});

// #2398 — a raw write may first start the pane's terminal (up to a WSL
// create's budget). The client's 10 s default ran out first: it reported a
// timeout while main went on and wrote, and the caller's retry wrote twice.
describe('terminal_send / terminal_send_key wait for the terminal start (#2398)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
  const between = (from: string, to: string): string => {
    const start = src.indexOf(from);
    expect(start, from).toBeGreaterThan(0);
    return src.slice(start, src.indexOf(to, start));
  };
  // CodeRabbit: the full start budget plus the delivery (90 s) outlasted
  // Codex's 60 s tool timeout; the MCP deadline stays inside it.
  it('both raw-write tools wait the MCP write deadline', () => {
    const send = between("'terminal_send',", "'terminal_send_key',");
    expect(send).toMatch(/callRpc\('input\.send', base, MCP_WRITE_DEADLINE_MS\)/);
    expect(send).not.toMatch(/terminalWriteClientTimeoutMs/);
    const key = between("'terminal_send_key',", 'server.tool(');
    expect(key).toMatch(/callRpc\('input\.sendKey', params, MCP_WRITE_DEADLINE_MS\)/);
  });

  // #2398 review item 3 — main is told each deadline and starts a pane only
  // within it, so a write it completes never lands after the client gave up.
  it('both tell main the deadline they wait', () => {
    const send = between("'terminal_send',", "'terminal_send_key',");
    expect(send).toMatch(/base\.clientTimeoutMs = MCP_WRITE_DEADLINE_MS;/);
    const key = between("'terminal_send_key',", 'server.tool(');
    expect(key).toMatch(/params\.clientTimeoutMs = MCP_WRITE_DEADLINE_MS;/);
  });

  it('both route a pane that has not started by its surface, through the commander route too', () => {
    for (const handler of [between("'terminal_send',", "'terminal_send_key',"), between("'terminal_send_key',", 'server.tool(')]) {
      expect(handler).toMatch(/resolveTerminalRouteBound\(ref\.ptyId, ref\.surfaceId\)/);
    }
    const bound = between('async function resolveTerminalRouteBound(', '// === Browser tools');
    expect(bound).toMatch(/resolveCommanderRoute\(\{[\s\S]*?explicitSurfaceId,/);
  });
});
