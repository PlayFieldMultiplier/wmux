// Agent sign-in slice — renderer mirror of main's lost sign-ins
// (shared/agentAuthLost), one entry per agent and account. Drives the
// sidebar's "Signed out" and the [Sign in again] toast (utils/agentAuthLost).
//
// TRANSIENT: never enters buildSessionData. main owns the entries; this is
// hydrated from `agentAuth.list()` on mount, then replaced on every change.

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { getLeafPanes } from '../../../shared/paneUtils';
import type { AuthLostEntry } from '../../../shared/agentAuthLost';

/** Whether any terminal surface of the workspace runs an agent whose sign-in was lost. */
export function workspaceHasAuthLost(
  state: Pick<StoreState, 'workspaces' | 'agentAuthLost'>,
  workspaceId: string,
): boolean {
  if (state.agentAuthLost.length === 0) return false;
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return false;
  const lost = new Set(state.agentAuthLost.flatMap((e) => e.ptyIds));
  return getLeafPanes(ws.rootPane).some((leaf) => leaf.surfaces.some((s) => !!s.ptyId && lost.has(s.ptyId)));
}

export interface AgentAuthSlice {
  agentAuthLost: AuthLostEntry[];
  setAgentAuthLost: (entries: readonly AuthLostEntry[]) => void;
}

export const createAgentAuthSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  AgentAuthSlice
> = (set) => ({
  agentAuthLost: [],
  setAgentAuthLost: (entries) => set((draft: StoreState) => {
    draft.agentAuthLost = entries.map((e) => ({ ...e, ptyIds: [...e.ptyIds] }));
  }),
});
