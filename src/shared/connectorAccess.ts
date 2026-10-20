/** Ordinary terminal access is independent of Bots access. Unknown means denied. */
export type ConnectorTerminalAccess = {
  mode: 'none' | 'all' | 'workspaces' | 'panes';
  workspaceIds: string[];
  paneIds: string[];
  excludedWorkspaceIds: string[];
  excludedPaneIds: string[];
};

export const noTerminalAccess = (): ConnectorTerminalAccess => ({
  mode: 'none', workspaceIds: [], paneIds: [], excludedWorkspaceIds: [], excludedPaneIds: [],
});

const idList = (raw: unknown, prefix: string): string[] | null => {
  if (!Array.isArray(raw) || raw.length > 256 || raw.some((id) => typeof id !== 'string'
    || id.length > 128 || !id.startsWith(prefix) || !/^[a-zA-Z0-9-]+$/.test(id))) return null;
  return [...new Set(raw as string[])];
};

export function parseTerminalAccess(raw: unknown): ConnectorTerminalAccess | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.mode !== 'none' && r.mode !== 'all' && r.mode !== 'workspaces' && r.mode !== 'panes') return null;
  const workspaceIds = idList(r.workspaceIds, 'ws-');
  const paneIds = idList(r.paneIds, 'pane-');
  const excludedWorkspaceIds = idList(r.excludedWorkspaceIds, 'ws-');
  const excludedPaneIds = idList(r.excludedPaneIds, 'pane-');
  if (!workspaceIds || !paneIds || !excludedWorkspaceIds || !excludedPaneIds) return null;
  return { mode: r.mode, workspaceIds, paneIds, excludedWorkspaceIds, excludedPaneIds };
}

export interface ConnectorTerminalTarget {
  workspaceId: string;
  paneId: string;
  botWorker: boolean;
}

/** Complete live owner-state sets, never target IDs supplied by an agent. */
export interface ConnectorAccessInventory {
  workspaceIds: ReadonlySet<string>;
  paneIds: ReadonlySet<string>;
}

export function terminalAccessAllows(
  policy: ConnectorTerminalAccess | undefined,
  target: ConnectorTerminalTarget,
  inventory: ConnectorAccessInventory,
): boolean {
  if (!policy || policy.mode === 'none' || target.botWorker
    || !inventory.workspaceIds.has(target.workspaceId) || !inventory.paneIds.has(target.paneId)) return false;
  // A missing exclusion must never turn an all grant into broader access after
  // restore, deletion or identity replacement. The owner must revise the policy.
  if (policy.excludedWorkspaceIds.some((id) => !inventory.workspaceIds.has(id))
    || policy.excludedPaneIds.some((id) => !inventory.paneIds.has(id))) return false;
  if (policy.excludedWorkspaceIds.includes(target.workspaceId) || policy.excludedPaneIds.includes(target.paneId)) return false;
  return policy.mode === 'all'
    || (policy.mode === 'workspaces' && policy.workspaceIds.includes(target.workspaceId))
    || (policy.mode === 'panes' && policy.paneIds.includes(target.paneId));
}
