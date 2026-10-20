/** Read-only MCP discovery. A successful check does not grant tools to a session. */
export const CONNECTOR_CHECK_IPC = 'connectors:check';
export type ConnectorCheckResult =
  | { status: 'ready'; toolCount: number; toolNames?: string[]; checkedAt: number }
  | { status: 'auth-required' | 'missing-key' | 'unsupported' | 'unavailable' | 'timeout' | 'failed' | 'changed' | 'busy' };
