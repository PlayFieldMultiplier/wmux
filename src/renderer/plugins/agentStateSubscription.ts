import { parsePluginAgentSnapshot, parsePluginAllAgentSnapshot, type PluginAgentSnapshot, type PluginAllAgentSnapshot } from '../../shared/pluginAgentState';

import type { BridgeAgentState } from '../../shared/pluginHost';
type AgentStateEvent = BridgeAgentState;
let nextEpoch = 0;
/**
 * One mounted frame owns this loop. No history or daemon state is retained.
 * `scope: 'all'` reads `agent.state.all` and posts `allWorkspaces`; main
 * checks that grant on every read, so a revoked one ends the stream.
 */
export function subscribeAgentState(options: {
  /** The bound workspace: fixed for a workspace stream, read live for 'all'. */
  workspaceId: string | undefined | (() => string | undefined);
  scope?: 'workspace' | 'all';
  read: () => Promise<unknown>;
  post: (event: AgentStateEvent) => void;
  isCurrent: () => boolean;
}): () => void {
  const all = options.scope === 'all';
  const epoch = `${Date.now()}-${++nextEpoch}`;
  let revision = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: string | undefined;
  const live = () => !stopped && options.isCurrent();
  const boundWorkspace = () => typeof options.workspaceId === 'function' ? options.workspaceId() : options.workspaceId;
  const emit = (status: AgentStateEvent['status'], snapshot?: PluginAgentSnapshot | PluginAllAgentSnapshot) => {
    if (live()) options.post({ v: 1, id: null, kind: 'agent-state', epoch, revision: ++revision,
      workspaceId: boundWorkspace() ?? null, status,
      ...(snapshot ? (all ? { allWorkspaces: snapshot as PluginAllAgentSnapshot } : { snapshot: snapshot as PluginAgentSnapshot }) : {}) });
  };
  const poll = async () => {
    const workspaceId = boundWorkspace();
    if (!live()) return;
    if (!workspaceId) {
      // A workspace stream is restarted by its owner on every switch, so an
      // unbound one simply ends. The 'all' stream is never restarted: with no
      // workspace bound for now it skips this read (main would refuse an
      // unbound caller) and keeps its own cadence until one is bound again.
      if (all) timer = setTimeout(() => { void poll(); }, 1000);
      return;
    }
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
      const snapshot = all ? parsePluginAllAgentSnapshot(raw.result) : parsePluginAgentSnapshot(raw.result, workspaceId, false);
      // In 'all' the bound workspace can change under one stream: a switch
      // alone is news to the page, so it is part of what counts as a change.
      const serialized = JSON.stringify(all ? [boundWorkspace(), snapshot] : snapshot);
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
