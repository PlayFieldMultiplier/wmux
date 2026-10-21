import { describe, it, expect } from 'vitest';
import {
  MCP_WRITE_DEADLINE_MS,
  STRICTEST_MCP_TOOL_TIMEOUT_MS,
  TERMINAL_START_BUDGET_MS,
  TERMINAL_WRITE_DELIVERY_BUDGET_MS,
  terminalStartWindowMs,
  terminalWriteClientTimeoutMs,
} from '../terminalWriteBudget';
import { TERMINAL_SEND_NEW_TASK_TIMEOUT_MS } from '../freshContext';

// #2398 CodeRabbit: the MCP write deadline was the full start budget plus the
// delivery (90 s, 105 s for a new task), past Codex's 60 s tool timeout. Codex
// reported a timeout, main went on, started the shell and wrote, and the
// agent's retry ran the text twice.
describe('the MCP raw-write deadline', () => {
  it('stays inside the strictest MCP host tool timeout, with margin', () => {
    expect(STRICTEST_MCP_TOOL_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(MCP_WRITE_DEADLINE_MS).toBeLessThanOrEqual(STRICTEST_MCP_TOOL_TIMEOUT_MS - 5_000);
  });

  it('still leaves main a start window, for a plain write and a new task', () => {
    expect(terminalStartWindowMs(MCP_WRITE_DEADLINE_MS, TERMINAL_WRITE_DELIVERY_BUDGET_MS)).toBe(40_000);
    expect(terminalStartWindowMs(MCP_WRITE_DEADLINE_MS, TERMINAL_SEND_NEW_TASK_TIMEOUT_MS)).toBe(25_000);
  });

  it('the CLI, with no host timeout over it, keeps the full start budget', () => {
    expect(terminalStartWindowMs(terminalWriteClientTimeoutMs(), TERMINAL_WRITE_DELIVERY_BUDGET_MS)).toBe(TERMINAL_START_BUDGET_MS);
    expect(terminalWriteClientTimeoutMs()).toBeGreaterThan(MCP_WRITE_DEADLINE_MS);
  });
});
