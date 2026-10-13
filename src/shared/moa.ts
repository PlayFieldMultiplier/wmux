// Moa (the legacy HQ main bot) — the shapes that outlive its brain: the HQ
// view earlier versions served, the pending decisions Fleet and the phone
// list, and the mascot's states.

import type { MoaAskMode } from './moaAsk';

/** Moa's autonomy level as an earlier version stored it. */
export type MoaLevel = 0 | 1 | 2 | 3;

export type MoaHqState = 'unset' | 'ok' | 'hq-missing' | 'hq-unknown' | 'hq-store-corrupt';

/** The Moa settings an earlier version kept in deck-hq.json. Nothing acts on
 *  them now: the renderer's view carries `enabled` only, always false. */
export interface MoaConfig {
  enabled: boolean;
  /** The operator has been through the first-run card. */
  onboarded: boolean;
  level: MoaLevel;
  maxTurnsPerHour: number;
  bubbles: boolean;
  reduceMotion: boolean;
  /** How the switch got its first value, when it was decided automatically. */
  defaultReason: 'new-install' | 'existing-brain' | null;
  /** Opt-in: main presses fan-out workers' small permission approvals by rule
   *  (owner in danger, not critical) and tells Moa afterwards. Absent = off. */
  approvalPress?: boolean;
  /** Moa may propose precedents and skills ("Remember this?"); nothing is
   *  saved without the operator's click. Absent = on. */
  memoryProposals?: boolean;
  /** Opt-in: propose new issues and outside PRs of open repos as decision
   *  cards. Absent = off. */
  issueProposals?: boolean;
  /** GitHub logins (lowercase) whose `wmux:auto` items may be handed off
   *  without a card. Absent = none. */
  trustedAuthors?: string[];
  /** Minutes between proposal scans. Absent = the default. */
  issuePollMinutes?: number;
  /** Repos (host/owner/repo, lowercase) Moa no longer proposes from. */
  ignoredRepos?: string[];
  /** Moa may hand off to a workspace in danger mode without a card, while the
   *  HQ is in danger mode too. Never applies to any other target. Absent = on. */
  autoHandoff?: boolean;
  /** Moa reads files (Read, Grep, Glob) in the repos it delegated to without a
   *  permission prompt. Absent = on. */
  readWithoutAsking?: boolean;
  /** Opt-in: Moa's shadow judge records what it would answer agents' questions
   *  from the policy book, and whether the owner agreed. It answers nothing.
   *  Absent = off. */
  shadowJudge?: boolean;
  /** moa_ask: off, records only, suggests in the panel, or may answer by
   *  itself where a rule is auto-eligible. Absent = 'off'. */
  askMode?: MoaAskMode;
  /** Policy rule ids the owner allowed to settle by themselves. Absent = none. */
  autoRules?: string[];
  /** Most decisions Moa may settle by itself per local day (auto mode).
   *  Absent = MOA_AUTO_DAILY_CAP_DEFAULT. */
  autoDailyCap?: number;
  /** The kill switch: true stops every automatic answer and merge at once,
   *  whatever the mode and the per-rule toggles say. Absent = off. */
  autoPaused?: boolean;
}

export interface MoaState {
  config: MoaConfig;
  hq: { workspaceId: string | null; state: MoaHqState };
  /** Decisions the HQ migration archived; `unacked` drives the one-time notice. */
  archive: { unacked: number; total: number };
}

/** The decision-store key Moa's "Remember this?" cards are raised under. Not a
 *  workspace: a card on the HQ's own key would block Moa's wakes. */
export const MOA_MEMORY_DECISION_KEY = '_moa-memory';

/** A pending decision in any workspace (Fleet's tickets, the phone sidebar). */
export interface MoaPendingDecision {
  workspaceId: string;
  /** The workspace's display name when the desktop knows it. */
  workspaceName?: string;
  decision: {
    id: string;
    question: string;
    options: string[];
    context: string;
    raisedAt: number;
  };
  /** Present on a hand-off Moa proposed (origin 'moa-handoff'). */
  handoff?: import('./moaHandoff').MoaHandoffCardInfo;
  /** A brain's own card: the operator may close it as not needed. */
  dismissible?: true;
}

/** Moa's mascot states. */
export type MoaMascotState = 'idle' | 'working' | 'needs-you' | 'done';
