// ─── moa_ask — the shapes its records keep ───────────────────────────────────
//
// moa_ask let an agent pane ask Moa instead of the owner and track the ticket
// (moa_ask_status). The tools and the judge are gone; what remains are the
// shapes the delegate's record files and the merge lane's effect records
// (src/shared/moaDecision.ts, src/main/deck/moaEffectStore.ts) are written in.

/** How long a caller should wait before polling a pending ticket again. */
export const MOA_ASK_POLL_MS = 3_000;

export type MoaTicketStatus = 'pending' | 'answered' | 'escalated' | 'refused';

/** The ask switch: off (default), records only, suggests in the panel, or may
 *  answer by itself where a rule is auto-eligible. */
export type MoaAskMode = 'off' | 'shadow' | 'suggest' | 'auto';

export interface MoaAskOption {
  key: string;
  label: string;
  description?: string;
}

/** A validated request body. `type` is the decision's kind. */
export type MoaAskBody =
  | { type: 'question'; question: string; options: MoaAskOption[]; topic?: string; context?: string }
  | { type: 'merge'; prNumber: number; expectHead: string; context?: string };

export type MoaAskKind = MoaAskBody['type'];

/** The asker, stamped by main from the verified pipe identity. */
export interface MoaAsker {
  ptyId: string;
  workspaceId: string;
  agent: string;
}

export type MoaResolvedBy = 'owner' | 'moa-auto' | 'expired' | 'refused';

/** A settled answer. Exactly one of choiceKey / actionVerdict is set. */
export interface MoaAskAnswer {
  choiceKey?: string;
  actionVerdict?: 'go' | 'no-go';
  /** The policy rule it rests on; null when the owner answered. */
  ruleId: string | null;
  reasonCode: string;
  why: string;
  resolvedBy: 'owner' | 'moa-auto';
}

export type MergeEffectStatus = 'pending' | 'inFlight' | 'done' | 'refused' | 'uncertain';

/** A merge action's execution, as the asker may see it. */
export interface MoaAskEffectView {
  status: MergeEffectStatus;
  reason?: string;
}

/** A ticket as its asker saw it. */
export interface MoaTicketView {
  ticketId: string;
  kind: MoaAskKind;
  status: MoaTicketStatus;
  /** Set when answered. */
  answer?: MoaAskAnswer;
  /** Why it is escalated or refused (or the answer's code). */
  reasonCode: string;
  why: string;
  /** A merge action's execution, once an effect exists. */
  effect?: MoaAskEffectView;
  pollAfterMs?: number;
  /** With `escalated`: what the asker should do now. */
  next?: string;
  createdAt: number;
  resolvedAt: number | null;
}
