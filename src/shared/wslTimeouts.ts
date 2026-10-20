// The WSL probe and RPC budgets, in a module with no Node imports so the MCP
// bundle can read them too (shared/terminalWriteBudget.ts). Re-exported from
// shared/wsl.ts, where they used to live.

export const WSL_PROBE_TIMEOUT_MS = 60_000;
export const WSL_RPC_TIMEOUT_MS = WSL_PROBE_TIMEOUT_MS + 15_000;
