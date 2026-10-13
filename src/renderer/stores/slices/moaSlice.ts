/**
 * What the renderer kept of Moa's state: nothing live. `moa` is always null
 * (the legacy HQ workspace is an ordinary workspace now); it stays on the
 * store, with the helpers below, for the reader that still asks
 * (Settings › Factory).
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { MoaHqState } from '../../../shared/moa';
import { isShadowWorkspaceId } from '../../../shared/pcRail';

/** Main's answer about the HQ workspace, as earlier versions gave it. */
export interface MoaHqView {
  config: { enabled: boolean };
  hq: { workspaceId: string | null; state: MoaHqState };
}

export interface MoaSlice {
  /** Always null. */
  moa: MoaHqView | null;
}

type HqView = Pick<StoreState, 'moa'>;

/** The HQ workspace id: always null now. */
export function moaHqId(state: HqView): string | null {
  return state.moa?.hq.workspaceId ?? null;
}

/** True when `workspaceId` is the HQ: never now. */
export function isMoaHqWorkspace(state: HqView, workspaceId: string): boolean {
  const hq = moaHqId(state);
  return !!hq && hq === workspaceId;
}

/**
 * The workspaces the operator sees (and Ctrl+N counts): all but the PC rail's
 * shadow workspaces, which belong to another computer.
 */
export function listedWorkspaces<T extends { id: string }>(list: readonly T[]): T[] {
  return list.filter((w) => !isShadowWorkspaceId(w.id));
}

export const createMoaSlice: StateCreator<StoreState, [['zustand/immer', never]], [], MoaSlice> = () => ({
  moa: null,
});
