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
export const PLUGIN_AGENT_MAX_BYTES = 1024 * 1024;
export const PLUGIN_AGENT_MAX_PANES = 512;
export const PLUGIN_AGENT_MAX_SURFACES = 32;
export function pluginAgentText(value: string): string {
  return Array.from(value).slice(0, 512).join('');
}

/** Rebuild the response from allowed fields; never forward renderer extras. */
export function parsePluginAgentSnapshot(raw: unknown, workspaceId: string, activity: boolean): PluginAgentSnapshot {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid agent snapshot');
  const value = raw as Record<string, unknown>;
  if (value.workspaceId !== workspaceId || !Array.isArray(value.panes)
    || value.panes.length > PLUGIN_AGENT_MAX_PANES || typeof value.truncated !== 'boolean') throw new Error('Invalid agent snapshot');
  const str = (v: unknown): string => {
    if (typeof v !== 'string' || Array.from(v).length > 512) throw new Error('Invalid agent snapshot field');
    return v;
  };
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
  const result = { workspaceId, panes, truncated: value.truncated };
  if (new TextEncoder().encode(JSON.stringify(result)).length > PLUGIN_AGENT_MAX_BYTES) throw new Error('Agent snapshot exceeds limit');
  return result;
}
