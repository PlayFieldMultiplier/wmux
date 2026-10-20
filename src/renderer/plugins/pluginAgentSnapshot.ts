import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import type { StoreState } from '../stores';
import { ownerFleetState } from '../components/Sidebar/botTasks';
import { selectFleetBoard, fleetRow } from '../stores/selectors/fleet';
import { selectWorkspaceAgentRoster } from '../stores/selectors/workspaceAgentRoster';
import { PLUGIN_AGENT_MAX_BYTES, PLUGIN_AGENT_MAX_PANES, PLUGIN_AGENT_MAX_SURFACES, pluginAgentText,
  type PluginAgentPane, type PluginAgentSnapshot } from '../../shared/pluginAgentState';

/** Project the same final Fleet board that fleet.triage and the owner see. */
export function pluginAgentSnapshot(store: StoreState, workspaceId: string, includeActivity: boolean): PluginAgentSnapshot {
  const state = ownerFleetState(store);
  const result: PluginAgentSnapshot = { workspaceId, panes: [], truncated: false };
  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return result;
  // A mixed pane's canonical attention may belong to a remote tab. Keep the
  // local-only projection exact by excluding the whole mixed pane.
  const remotePanes = new Set(getWorkspaceLeafPanes(workspace).filter((p) => p.surfaces.some((s) => s.surfaceType === 'remote-terminal')).map((p) => p.id));
  const roster = selectWorkspaceAgentRoster(store, workspaceId).rows.filter((r) => !r.remote && r.agentName);
  const board = selectFleetBoard(state, { now: store.agentClockMs, sortMode: 'attention' });
  let bytes = new TextEncoder().encode(JSON.stringify(result)).length;
  for (const pane of board.panes) {
    if (pane.workspaceId !== workspaceId || remotePanes.has(pane.paneId)) continue;
    const agents = roster.filter((r) => r.paneId === pane.paneId);
    if (!agents.length) continue;
    const row = fleetRow(pane, { surfacePendingQuestion: state.surfacePendingQuestion });
    const record: PluginAgentPane = {
      paneId: pane.paneId,
      label: pluginAgentText(store.paneLabel[pane.paneId] || agents[0].paneName || agents[0].agentName),
      state: row.section === 'running' ? 'working' : row.section === 'idle' ? 'resting' : row.section,
      stashed: agents.some((a) => a.stashed),
      surfaces: agents.slice(0, PLUGIN_AGENT_MAX_SURFACES).map((a) => ({ surfaceId: a.surfaceId, agentName: pluginAgentText(a.agentName) })),
      ...(includeActivity && pane.activity ? { activity: pluginAgentText(pane.activity) } : {}),
    };
    const size = new TextEncoder().encode(JSON.stringify(record)).length + 1;
    if (result.panes.length === PLUGIN_AGENT_MAX_PANES || bytes + size > PLUGIN_AGENT_MAX_BYTES - 64) { result.truncated = true; break; }
    if (agents.length > PLUGIN_AGENT_MAX_SURFACES) result.truncated = true;
    bytes += size;
    result.panes.push(record);
  }
  return result;
}
