import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import type { StoreState } from '../stores';
import { ownerFleetState } from '../components/Sidebar/botTasks';
import { selectFleetBoard, fleetRow } from '../stores/selectors/fleet';
import { selectWorkspaceAgentRoster } from '../stores/selectors/workspaceAgentRoster';
import { isShadowWorkspaceId } from '../../shared/pcRail';
import { PLUGIN_AGENT_MAX_BYTES, PLUGIN_AGENT_MAX_PANES, PLUGIN_AGENT_MAX_SURFACES, PLUGIN_AGENT_MAX_WORKSPACES, pluginAgentText,
  type PluginAgentPane, type PluginAgentSnapshot, type PluginAllAgentSnapshot, type PluginWorkspaceAgentSnapshot } from '../../shared/pluginAgentState';

/** ownerFleetState keeps the store's shape, with bot workers dropped. */
type FleetState = StoreState;
type FleetBoard = ReturnType<typeof selectFleetBoard>;
/** Bytes left in one response, shared by every workspace written into it. */
interface ByteBudget { bytes: number }

const size = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** Project the same final Fleet board that fleet.triage and the owner see. */
export function pluginAgentSnapshot(store: StoreState, workspaceId: string, includeActivity: boolean): PluginAgentSnapshot {
  const state = ownerFleetState(store);
  const result: PluginAgentSnapshot = { workspaceId, panes: [], truncated: false };
  if (!state.workspaces.some((w) => w.id === workspaceId)) return result;
  const board = selectFleetBoard(state, { now: store.agentClockMs, sortMode: 'attention' });
  fillWorkspace(store, state, board, result, includeActivity, { bytes: size(result) });
  return result;
}

/**
 * `agent.state.all`: the same per-workspace projection for every local
 * workspace, in sidebar order, from ONE board read. Bot workers are already
 * dropped by ownerFleetState and remote PC mirrors are skipped here, so this
 * covers exactly the owner's local workspaces. Never carries activity.
 */
export function pluginAllAgentSnapshot(store: StoreState): PluginAllAgentSnapshot {
  const state = ownerFleetState(store);
  const result: PluginAllAgentSnapshot = { workspaces: [], truncated: false };
  const board = selectFleetBoard(state, { now: store.agentClockMs, sortMode: 'attention' });
  const budget: ByteBudget = { bytes: size(result) };
  for (const workspace of state.workspaces) {
    if (isShadowWorkspaceId(workspace.id)) continue;
    const entry: PluginWorkspaceAgentSnapshot = { workspaceId: workspace.id, name: pluginAgentText(workspace.name), panes: [], truncated: false };
    const empty = size(entry) + 1;
    if (result.workspaces.length === PLUGIN_AGENT_MAX_WORKSPACES || budget.bytes + empty > PLUGIN_AGENT_MAX_BYTES - 64) { result.truncated = true; break; }
    budget.bytes += empty;
    fillWorkspace(store, state, board, entry, false, budget);
    result.workspaces.push(entry);
  }
  return result;
}

function fillWorkspace(store: StoreState, state: FleetState, board: FleetBoard, result: PluginAgentSnapshot,
  includeActivity: boolean, budget: ByteBudget): void {
  const { workspaceId } = result;
  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return;
  // A mixed pane's canonical attention may belong to a remote tab. Keep the
  // local-only projection exact by excluding the whole mixed pane.
  const remotePanes = new Set(getWorkspaceLeafPanes(workspace).filter((p) => p.surfaces.some((s) => s.surfaceType === 'remote-terminal')).map((p) => p.id));
  const roster = selectWorkspaceAgentRoster(store, workspaceId).rows.filter((r) => !r.remote && r.agentName);
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
    const recordSize = size(record) + 1;
    if (result.panes.length === PLUGIN_AGENT_MAX_PANES || budget.bytes + recordSize > PLUGIN_AGENT_MAX_BYTES - 64) { result.truncated = true; break; }
    if (agents.length > PLUGIN_AGENT_MAX_SURFACES) result.truncated = true;
    budget.bytes += recordSize;
    result.panes.push(record);
  }
}
