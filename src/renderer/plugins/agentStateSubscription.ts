import { parsePluginAgentSnapshot, type PluginAgentSnapshot } from '../../shared/pluginAgentState';

import type { BridgeAgentState } from '../../shared/pluginHost';
type AgentStateEvent = BridgeAgentState;
let nextEpoch = 0;
/** One mounted frame owns this loop. No history or daemon state is retained. */
export function subscribeAgentState(options: {
  workspaceId: string | undefined;
  read: () => Promise<unknown>;
  post: (event: AgentStateEvent) => void;
  isCurrent: () => boolean;
}): () => void {
  const epoch = `${Date.now()}-${++nextEpoch}`;
  let revision = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: string | undefined;
  const live = () => !stopped && options.isCurrent();
  const emit = (status: AgentStateEvent['status'], snapshot?: PluginAgentSnapshot) => {
    if (live()) options.post({ v: 1, id: null, kind: 'agent-state', epoch, revision: ++revision,
      workspaceId: options.workspaceId ?? null, status, ...(snapshot ? { snapshot } : {}) });
  };
  const poll = async () => {
    if (!live() || !options.workspaceId) return;
    try {
      const raw = await options.read() as { ok?: boolean; result?: unknown; retryable?: boolean } | null;
      if (!live()) return;
      if (raw?.ok !== true) {
        if (raw?.retryable === true) {
          previous = undefined;
          emit('reset');
          timer = setTimeout(() => { void poll(); }, 1000);
          return;
        }
        throw new Error('Agent state unavailable');
      }
      const snapshot = parsePluginAgentSnapshot(raw.result, options.workspaceId, false);
      const serialized = JSON.stringify(snapshot);
      if (serialized !== previous) { previous = serialized; emit('ready', snapshot); }
      if (live()) timer = setTimeout(() => { void poll(); }, 1000);
    } catch {
      emit('unavailable');
      stopped = true;
    }
  };
  emit('reset');
  void poll();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
