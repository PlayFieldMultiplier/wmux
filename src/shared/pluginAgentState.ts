/** Bounded, workspace-scoped UI plugin projection. Never a terminal transcript. */
export interface PluginAgentPane {
  paneId: string;
  label: string;
  state: 'working' | 'needsYou' | 'finished' | 'resting';
  stashed: boolean;
  surfaces: { surfaceId: string; agentName: string }[];
  /** Only returned after an explicit terminal.read grant. */
  activity?: string;
}
export interface PluginAgentSnapshot {
  workspaceId: string;
  panes: PluginAgentPane[];
  truncated: boolean;
}
/** One workspace's snapshot inside the all-workspaces projection. */
export interface PluginWorkspaceAgentSnapshot extends PluginAgentSnapshot {
  /** The workspace's display name, clipped like every other text field. */
  name: string;
}
/**
 * `agent.state.all`: every local workspace, in sidebar order. `truncated`
 * means whole workspaces were left out by the size limit; a workspace's own
 * `truncated` means some of its panes were.
 */
export interface PluginAllAgentSnapshot {
  workspaces: PluginWorkspaceAgentSnapshot[];
  truncated: boolean;
}
export const PLUGIN_AGENT_MAX_BYTES = 1024 * 1024;
export const PLUGIN_AGENT_MAX_PANES = 512;
export const PLUGIN_AGENT_MAX_SURFACES = 32;
export const PLUGIN_AGENT_MAX_WORKSPACES = 128;
export function pluginAgentText(value: string): string {
  return Array.from(value).slice(0, 512).join('');
}

const str = (v: unknown): string => {
  if (typeof v !== 'string' || Array.from(v).length > 512) throw new Error('Invalid agent snapshot field');
  return v;
};

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Rebuild the response from allowed fields; never forward renderer extras. */
export function parsePluginAgentSnapshot(raw: unknown, workspaceId: string, activity: boolean): PluginAgentSnapshot {
  const result = rebuildSnapshot(raw, workspaceId, activity);
  if (encodedSize(result) > PLUGIN_AGENT_MAX_BYTES) throw new Error('Agent snapshot exceeds limit');
  return result;
}

/**
 * The all-workspaces counterpart: each workspace is rebuilt by the same rules
 * as a single snapshot, plus its name. Activity is never part of it.
 */
export function parsePluginAllAgentSnapshot(raw: unknown): PluginAllAgentSnapshot {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid agent snapshot');
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.workspaces) || value.workspaces.length > PLUGIN_AGENT_MAX_WORKSPACES
    || typeof value.truncated !== 'boolean') throw new Error('Invalid agent snapshot');
  const seen = new Set<string>();
  const workspaces = value.workspaces.map((item: unknown): PluginWorkspaceAgentSnapshot => {
    if (!item || typeof item !== 'object') throw new Error('Invalid agent workspace');
    const w = item as Record<string, unknown>;
    const workspaceId = str(w.workspaceId);
    if (!workspaceId || seen.has(workspaceId)) throw new Error('Invalid agent workspace');
    seen.add(workspaceId);
    const { panes, truncated } = rebuildSnapshot(w, workspaceId, false);
    return { workspaceId, name: str(w.name), panes, truncated };
  });
  const result = { workspaces, truncated: value.truncated };
  if (encodedSize(result) > PLUGIN_AGENT_MAX_BYTES) throw new Error('Agent snapshot exceeds limit');
  return result;
}

function rebuildSnapshot(raw: unknown, workspaceId: string, activity: boolean): PluginAgentSnapshot {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid agent snapshot');
  const value = raw as Record<string, unknown>;
  if (value.workspaceId !== workspaceId || !Array.isArray(value.panes)
    || value.panes.length > PLUGIN_AGENT_MAX_PANES || typeof value.truncated !== 'boolean') throw new Error('Invalid agent snapshot');
  const panes = value.panes.map((item: unknown): PluginAgentPane => {
    if (!item || typeof item !== 'object') throw new Error('Invalid agent pane');
    const p = item as Record<string, unknown>;
    if (!['working', 'needsYou', 'finished', 'resting'].includes(String(p.state))
      || typeof p.stashed !== 'boolean' || !Array.isArray(p.surfaces)
      || p.surfaces.length > PLUGIN_AGENT_MAX_SURFACES) throw new Error('Invalid agent pane');
    return { paneId: str(p.paneId), label: str(p.label), state: p.state as PluginAgentPane['state'], stashed: p.stashed,
      surfaces: p.surfaces.map((s: unknown) => {
        if (!s || typeof s !== 'object') throw new Error('Invalid agent surface');
        const surface = s as Record<string, unknown>;
        return { surfaceId: str(surface.surfaceId), agentName: str(surface.agentName) };
      }), ...(activity && p.activity !== undefined ? { activity: str(p.activity) } : {}) };
  });
  return { workspaceId, panes, truncated: value.truncated };
}
