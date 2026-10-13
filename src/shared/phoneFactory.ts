// ─── The agent factory in the phone's sidebar snapshot ─────────────────────
//
// Main folds the factory into the sidebar snapshot the renderer produced
// (main/phone/PhoneFactory.ts reads the stores; this file is the pure rule),
// so `/api/config` and `/api/workspaces` answer from one snapshot:
//
//   factory on   `moa` iff an HQ bot is enabled; `moaWakeBlocked: 'no-hq-bot'`
//                without one; `moaDelegations` = the dispatch handoffs;
//                per-workspace `bots` and `openQuestions`.
//   factory off  the renderer's legacy Moa fields stand; with no legacy Moa
//                on, `moaWakeBlocked: 'factory-off'`.
//
// No store state here: inputs in, snapshot out.

import type { Handoff } from './handoff';
import {
  PHONE_MOA_DELEGATION_RECENT_MS,
  PHONE_SIDEBAR_LIMITS,
  clampSidebarString,
  isSidebarId,
  type PhoneMoaDelegation,
  type PhoneMoaDelegationState,
  type PhoneSidebarBot,
  type PhoneSidebarSnapshot,
} from './phoneFleetSidebar';

export interface PhoneFactoryState {
  enabled: boolean;
  /** The HQ bot (oldest enabled `moa` bot) and its engine session, when one exists. */
  hq: { botId: string; workspaceId: string; sessionId?: string } | null;
  /** Projected bots per workspace, oldest first. */
  bots: ReadonlyMap<string, readonly PhoneSidebarBot[]>;
  /** Open questions per workspace room (only the rooms main counted). */
  openQuestions: ReadonlyMap<string, number>;
  /** Dispatch handoffs as delegations; null when they could not be read. */
  delegations: PhoneMoaDelegation[] | null;
}

/**
 * The snapshot with the factory folded in. A factory that is off changes
 * nothing but `factory` itself and, with no legacy Moa on, `moaWakeBlocked`.
 */
export function applyFactoryToSidebar(sidebar: PhoneSidebarSnapshot, f: PhoneFactoryState): PhoneSidebarSnapshot {
  if (!f.enabled) {
    const out: PhoneSidebarSnapshot = { ...sidebar, factory: { enabled: false } };
    if (out.moa !== true) out.moaWakeBlocked = 'factory-off';
    return out;
  }
  const {
    moa: _moa, moaWakeBlocked: _blocked, moaDelegations: _delegations, ...rest
  } = sidebar;
  const hq = f.hq && isSidebarId(f.hq.botId) ? f.hq : null;
  const out: PhoneSidebarSnapshot = {
    ...rest,
    factory: {
      enabled: true,
      ...(hq ? { hqBotId: hq.botId } : {}),
      ...(hq && isSidebarId(hq.workspaceId) ? { hqWorkspaceId: hq.workspaceId } : {}),
      ...(hq?.sessionId !== undefined && isSidebarId(hq.sessionId) ? { hqSessionId: hq.sessionId } : {}),
    },
    ...(hq ? { moa: true as const } : { moaWakeBlocked: 'no-hq-bot' as const }),
    ...(f.delegations ? { moaDelegations: f.delegations } : {}),
    workspaces: sidebar.workspaces.map((row) => {
      const bots = f.bots.get(row.id);
      const open = f.openQuestions.get(row.id);
      if ((!bots || bots.length === 0) && open === undefined) return row;
      return {
        ...row,
        ...(bots && bots.length > 0 ? { bots: bots.slice(0, PHONE_SIDEBAR_LIMITS.botsPerWorkspace) } : {}),
        ...(open !== undefined ? { openQuestions: open } : {}),
      };
    }),
  };
  return out;
}

/** What a delegation needs to know about the bot a handoff went to. */
export interface DelegationBotInfo { name: string; }

/**
 * Moa's delegated jobs from the factory: every `dispatch` handoff to a bot
 * that is still open (`queued` / `delivered` → `working`, or `blocked` while
 * its thread holds an open question), plus those that ended within
 * PHONE_MOA_DELEGATION_RECENT_MS (`answered` → `done`, `refused` /
 * `expired` → `failed`); newest first, bounded. `taskId` is the handoff id.
 */
export function delegationsFromHandoffs(
  handoffs: readonly Handoff[],
  bot: (botId: string) => DelegationBotInfo | null,
  threadBlocked: (workspaceId: string, threadId: string) => boolean,
  now: number,
): PhoneMoaDelegation[] {
  const out: PhoneMoaDelegation[] = [];
  for (const h of handoffs) {
    if (h.kind !== 'dispatch' || h.to.kind !== 'bot') continue;
    const target = h.to;
    const open = h.status === 'queued' || h.status === 'delivered';
    if (!open && now - h.updatedAt > PHONE_MOA_DELEGATION_RECENT_MS) continue;
    if (!isSidebarId(h.id) || !isSidebarId(target.workspaceId)) continue;
    if (!Number.isSafeInteger(h.updatedAt) || h.updatedAt <= 0) continue;
    let state: PhoneMoaDelegationState;
    if (h.status === 'answered') state = 'done';
    else if (!open) state = 'failed';
    else state = threadBlocked(target.workspaceId, h.threadId) ? 'blocked' : 'working';
    const info = bot(target.botId);
    out.push({
      taskId: h.id,
      workspaceId: target.workspaceId,
      agentName: clampSidebarString(info?.name, PHONE_SIDEBAR_LIMITS.moaDelegationAgentName) ?? 'Bot',
      title: clampSidebarString(h.payload.title, PHONE_SIDEBAR_LIMITS.moaDelegationTitle) ?? 'Untitled task',
      state,
      since: h.updatedAt,
    });
  }
  return out.sort((a, b) => b.since - a.since).slice(0, PHONE_SIDEBAR_LIMITS.moaDelegations);
}
