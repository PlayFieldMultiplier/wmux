export const CONNECTOR_TERMINAL_IPC = 'connectors:terminal';
export type ConnectorTerminalResult = { ok: true } | { ok: false };
export interface ConnectorTerminalContext {
  workspaces: Array<{ id: string; name: string }>;
  panes: Array<{ id: string; name?: string; workspaceId: string; ptyIds: string[] }>;
}
