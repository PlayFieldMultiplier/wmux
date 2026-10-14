// ─── Moa's merge executor — runs the MergeEffect outbox (moaEffectStore.ts) ──
//
//   run(id):  claim (journal inFlight first) → authorize → FRESH lane read
//             (MergeLaneFactsReader, never the TTL cache) → evaluateMergeLane
//             (every predicate for 'moa-auto'; OWNER_APPROVED_PREDICATES for an
//             owner's approval) → GhPrReviewService.merge() unchanged (it reads
//             the head again, applies mergeBlock and passes
//             --match-head-commit) → finish.
//   reconcileAll():  every `uncertain` row is read fresh and settled by
//             reconcileMergeEffect (MERGED with headRefOid === expectHead →
//             done); a row that comes back `pending` runs again from the top.
//
// Nothing stored authorizes a merge. The approver picks the predicates
// (PREDICATES_BY_APPROVER); an approver not in that table is refused. Then an
// authorize port is asked on every try, right after the claim (a refusal then
// ends the claimed row `refused`):
//   owner / moa-auto  `authorize`: the decision behind the effect must read
//                     answered/go NOW (a forged outbox row has no such
//                     decision), and a 'moa-auto' effect must still be
//                     auto-eligible (book attribute, the owner's toggle, the
//                     kill switch).
//   lane              `lane.inputs` (laneAuthorize): the factory is on, the
//                     lane's kill switch is off, and today's lane merges are
//                     under the daily cap. With no lane port nothing merges
//                     as 'lane' (`lane-not-wired`). Lane runs go one at a
//                     time, so the cap is counted with no other lane run
//                     between its read and its merge; an uncertain lane row
//                     counts against it (it may have merged).
//   approval          an effect behind a bot's approval request (its
//                     decisionId is the request's `apr-` id): `approval.
//                     authorize` — the request reads approved NOW, by this
//                     approver, for this head (and for 'rule': the rule still
//                     stands and the request is not tainted). A 'rule' effect
//                     then passes the lane's gate too (ruleAuthorize: the
//                     factory is on and the daily cap has room — the rule is
//                     the owner's consent, so the lane auto-merge switch does
//                     not hold it; its merges count toward the lane's daily
//                     cap and run in the lane's queue) and every lane
//                     predicate; an 'owner' one
//                     head-unchanged (mergeBlock inside merge() refuses failing
//                     or pending checks). Right before the merge the gh login
//                     must be the one the request recorded, and the gate
//                     (lane and approval) is asked once more, and by the
//                     merge itself after its last read. With no approval
//                     port nothing merges for a request (`approval-not-wired`).
// A failure after the claim that may or may not have reached GitHub ends
// `uncertain`, never `done`.
//
// update-branch (lane only): when every predicate passes but GitHub says the
// branch is BEHIND its base, a same-repo `wtask/*` branch is updated
// (`updateBranch`) and the try ends `refused: behind-updated` — the new head
// needs its own checks and verdict, so it is a new effect. Lane runs are
// serialized, so at most one update is in flight (per repo and overall).
// Owner and moa-auto effects, forks and other branches go to the merge as
// before (mergeBlock refuses them as behind).

import type { MergeEffect } from '../../shared/moaDecision';
import type { PrLaneFacts, PrWriteResult } from '../../shared/prReview';
import { isApprovalMergeEffect, reconcileMergeEffect, type MoaEffectStore } from './moaEffectStore';
import {
  LANE_PREDICATES,
  OWNER_APPROVED_PREDICATES,
  evaluateMergeLane,
  type LanePredicate,
  type MergeLaneContext,
  type MergeLaneFactsReader,
} from './moaMergeLane';

/** The predicates each approver's merge re-runs on every try. An approver
 *  missing here is refused (`unknown-approver`), never treated as the owner. */
export const PREDICATES_BY_APPROVER: Readonly<Record<MergeEffect['approvedBy'], readonly LanePredicate[]>> = {
  owner: OWNER_APPROVED_PREDICATES,
  'moa-auto': LANE_PREDICATES,
  lane: LANE_PREDICATES,
  rule: LANE_PREDICATES,
};

/** Effects that run in the lane's one-at-a-time queue and count toward its
 *  daily cap: the lane's own, and those a remembered rule approved. */
function lanePaced(e: Pick<MergeEffect, 'approvedBy'>): boolean {
  return e.approvedBy === 'lane' || e.approvedBy === 'rule';
}

function predicatesFor(approvedBy: unknown): readonly LanePredicate[] | null {
  return typeof approvedBy === 'string' && Object.prototype.hasOwnProperty.call(PREDICATES_BY_APPROVER, approvedBy)
    ? PREDICATES_BY_APPROVER[approvedBy as MergeEffect['approvedBy']]
    : null;
}

/** What the factory host reads now for a lane effect's authorize. */
export interface LaneAuthorizeInputs {
  /** factory.enabled. */
  factoryEnabled: boolean;
  /** The lane's kill switch: true stops every lane merge. */
  killSwitch: boolean;
  /** Most lane merges per local day. */
  dailyCap: number;
}

/** The lane's own gate (not the Moa decision's). Null = may run. Pure.
 *  `mergedToday` counts lane effects done (or uncertain) since local
 *  midnight. */
export function laneAuthorize(inputs: LaneAuthorizeInputs | null, mergedToday: number): string | null {
  if (!inputs) return 'lane-inputs-unreadable';
  if (inputs.factoryEnabled !== true) return 'factory-disabled';
  if (inputs.killSwitch !== false) return 'lane-paused';
  if (!Number.isSafeInteger(inputs.dailyCap) || inputs.dailyCap < 0 || mergedToday >= inputs.dailyCap) return 'lane-daily-cap';
  return null;
}

/** A remembered rule's gate: the lane's, except the lane auto-merge switch.
 *  The rule is the owner's own consent for that bot (or workspace) and
 *  repository, so it holds whatever the switch reads; the factory must be on
 *  and the shared daily cap must have room. Pure. */
export function ruleAuthorize(inputs: LaneAuthorizeInputs | null, mergedToday: number): string | null {
  return laneAuthorize(inputs ? { ...inputs, killSwitch: false } : null, mergedToday);
}

/** The lane's ports, wired by the factory host. */
export interface LaneMergePort {
  /** The authorize inputs, read now; null when they cannot be read. */
  inputs: () => LaneAuthorizeInputs | null;
  /** The lane context for a lane effect (it has no decision or asker), read
   *  now on the executor's fresh read. */
  laneContext: (effect: MergeEffect, facts: PrLaneFacts) => Promise<Omit<MergeLaneContext, 'expectHead'>>;
  /** A refusal from main's own stores on the fresh read (e.g. a bot task on
   *  the head branch started from outside text), or null. Absent: none. */
  refusal?: (effect: MergeEffect, facts: PrLaneFacts) => Promise<string | null>;
}

/** The approvals' ports (the factory's approval store), for effects behind a
 *  bot's approval request. */
export interface ApprovalMergePort {
  /** Null when the request behind the effect allows it now: approved, by the
   *  effect's approver, for the effect's head (a 'rule' one: the rule still
   *  stands and the request is untainted); else the refusal reason. */
  authorize: (effect: MergeEffect) => string | null;
  /** The lane context for a 'rule' effect, read now on the fresh read. */
  laneContext: (effect: MergeEffect, facts: PrLaneFacts) => Promise<Omit<MergeLaneContext, 'expectHead'>>;
  /** A 'rule' effect's refusal from main's own stores on the fresh read
   *  (outside text behind the head branch), or null. */
  refusal?: (effect: MergeEffect, facts: PrLaneFacts) => Promise<string | null>;
  /** Null when the gh login the merge goes out as now is the one the request
   *  recorded, else the refusal reason. Asked right before the merge. */
  identity: (effect: MergeEffect) => Promise<string | null>;
}

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface MoaMergeExecutorPorts {
  effects: MoaEffectStore;
  facts: MergeLaneFactsReader;
  /** The squash merge itself (GhPrReviewService.merge with expectHead).
   *  `authorize` is the executor's gate: the merge asks it after its own
   *  last read, right before the GitHub write, and writes nothing (any
   *  non-ok result) when it returns a reason; the executor then ends the
   *  try refused with that reason. */
  merge: (effect: MergeEffect, authorize: () => string | null) => Promise<PrWriteResult>;
  /** trustedAuthors, askerBranches, the PR's verdicts and its author
   *  workspaces for this effect, read by main now (never cached). */
  laneContext: (effect: MergeEffect, facts: PrLaneFacts) => Promise<Omit<MergeLaneContext, 'expectHead'>>;
  /** Null when an 'owner' or 'moa-auto' effect may run now, else the refusal
   *  reason. Never asked for a 'lane' effect. */
  authorize: (effect: MergeEffect) => string | null;
  /** The lane's authorize inputs and context. Absent: a 'lane' effect is
   *  refused `lane-not-wired`, and so is a 'rule' one. */
  lane?: LaneMergePort;
  /** Approval requests' ports. Absent: an effect behind a request is refused
   *  `approval-not-wired`. */
  approval?: ApprovalMergePort;
  /** `gh pr update-branch` for a lane effect whose same-repo `wtask/*` branch
   *  is BEHIND (GhPrReviewService.updateBranch). Absent: the merge runs and
   *  is refused as behind, as for every other effect. */
  updateBranch?: (effect: MergeEffect) => Promise<PrWriteResult>;
  now?: () => number;
  /** Null when the gh login the merge goes out as now is the one the
   *  decision's card showed, else the refusal reason. Asked right before
   *  the merge. */
  identity?: (effect: MergeEffect) => Promise<string | null>;
  emit?: (effect: MergeEffect) => void;
  log?: (line: string) => void;
}

/** An owner's approval re-checks head-unchanged only: no context is read. */
const OWNER_ONLY_CONTEXT: Omit<MergeLaneContext, 'expectHead'> = { trustedAuthors: [], askerBranches: [], verdicts: null, authorWorkspaces: null };

/** A head branch the lane may update: one fan-out made. */
const LANE_UPDATABLE_BRANCH = /^wtask\/[^\s]+$/;

export class MoaMergeExecutor {
  private readonly running = new Map<string, Promise<MergeEffect | null>>();
  /** The last queued lane run: lane runs go one at a time. */
  private laneTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: MoaMergeExecutorPorts) {}

  /** Run one pending effect. Concurrent calls for one id share the run. */
  run(id: string): Promise<MergeEffect | null> {
    const live = this.running.get(id);
    if (live) return live;
    const go = (): Promise<MergeEffect | null> => this.runOnce(id);
    let started: Promise<MergeEffect | null>;
    const row = this.ports.effects.get(id);
    if (row && lanePaced(row)) {
      started = this.laneTail.then(go, go);
      this.laneTail = started.catch(() => undefined);
    } else {
      started = go();
    }
    const p = started.finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  /** Wait for the runs under way to finish recording their result. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  /** Settle every uncertain row from a fresh read, then run what is pending
   *  (startup and the periodic tick). Never re-runs a row without a read.
   *  The one with a lane port (the factory's merge lane host) settles and
   *  runs lane rows and approval rows only; one without (a Moa delegate)
   *  every other row, so no row runs with another executor's ports. */
  async reconcileAll(): Promise<void> {
    const mine = (row: MergeEffect): boolean => (row.approvedBy === 'lane' || isApprovalMergeEffect(row)) === (this.ports.lane !== undefined);
    for (const row of this.ports.effects.list()) {
      if (row.status !== 'uncertain' || !mine(row)) continue;
      const facts = await this.read(row);
      const next = await this.ports.effects.reconcile(row.id, facts);
      if (next) this.emit(next);
    }
    for (const row of this.ports.effects.list()) {
      if (row.status === 'pending' && mine(row)) await this.run(row.id);
    }
  }

  private async runOnce(id: string): Promise<MergeEffect | null> {
    const { effects } = this.ports;
    const claimed = await effects.claim(id);
    if (!claimed) return effects.get(id);
    this.emit(claimed);
    const end = async (status: 'done' | 'refused' | 'uncertain', reason?: string, oid?: string): Promise<MergeEffect | null> => {
      const row = await effects.finish(id, status, reason, oid);
      if (row) {
        this.emit(row);
        this.ports.log?.(`[moa-merge] ${row.repoKey}#${row.prNumber} ${row.status}${row.reason ? ` (${row.reason})` : ''}`);
      }
      return row;
    };
    try {
      const predicates = predicatesFor(claimed.approvedBy);
      if (!predicates) return await end('refused', 'unknown-approver');
      const isLane = claimed.approvedBy === 'lane';
      const isApproval = isApprovalMergeEffect(claimed);
      const lane = this.ports.lane;
      const approval = this.ports.approval;
      if (isLane && !lane) return await end('refused', 'lane-not-wired');
      if (isApproval && !approval) return await end('refused', 'approval-not-wired');
      // A rule only ever approves a request; a request only by owner or rule.
      if (claimed.approvedBy === 'rule' && !isApproval) return await end('refused', 'unknown-approver');
      if (isApproval && claimed.approvedBy !== 'owner' && claimed.approvedBy !== 'rule') return await end('refused', 'unknown-approver');
      if (claimed.approvedBy === 'rule' && !lane) return await end('refused', 'lane-not-wired');
      let denied: string | null;
      if (isLane) denied = this.authorizeLane(claimed);
      else if (isApproval && approval) denied = approval.authorize(claimed) ?? (claimed.approvedBy === 'rule' ? this.authorizeLane(claimed) : null);
      else denied = this.ports.authorize(claimed);
      if (denied) return await end('refused', denied);
      const facts = await this.read(claimed);
      if (!facts) return await end('uncertain', 'read-failed');
      if (facts.number !== claimed.prNumber) return await end('refused', 'pr-mismatch');
      // Not open (or another head) is settled from the read, never merged.
      const pre = reconcileMergeEffect({ expectHead: claimed.expectHead, attempt: 0 }, facts);
      if (pre.status !== 'pending') return await end(pre.status === 'done' ? 'done' : pre.status === 'refused' ? 'refused' : 'uncertain', pre.reason, pre.mergeCommitOid);
      const ctx = isLane && lane
        ? await lane.laneContext(claimed, facts)
        : isApproval && approval
          ? claimed.approvedBy === 'rule' ? await approval.laneContext(claimed, facts) : OWNER_ONLY_CONTEXT
          : await this.ports.laneContext(claimed, facts);
      const verdict = evaluateMergeLane(facts, { ...ctx, expectHead: claimed.expectHead }, predicates);
      if (!verdict.ok) {
        const f = verdict.failures[0];
        return await end('refused', f ? `${f.predicate}:${f.reason}` : 'lane');
      }
      const stop = isLane && lane?.refusal
        ? await lane.refusal(claimed, facts)
        : claimed.approvedBy === 'rule' && approval?.refusal ? await approval.refusal(claimed, facts) : null;
      if (stop) return await end('refused', stop);
      if (isLane && this.ports.updateBranch && facts.mergeStateStatus === 'BEHIND'
        && !facts.isCrossRepository && LANE_UPDATABLE_BRANCH.test(facts.headRefName)) {
        const r = await this.ports.updateBranch(claimed).catch((err): PrWriteResult => ({ ok: false, code: 'error', message: String(err) }));
        return await end('refused', r.ok ? 'behind-updated' : r.code === 'moved' ? 'head-moved' : `behind-update-${r.code}`);
      }
      const wrongIdentity = isApproval && approval ? await approval.identity(claimed) : await this.ports.identity?.(claimed);
      if (wrongIdentity) return await end('refused', wrongIdentity);
      // The last word before GitHub: a revocation, an undo or the kill switch
      // that landed during the reads above stops the merge — asked here and
      // again by the merge after its own reads.
      const gate = (): string | null => (isLane
        ? this.authorizeLane(claimed)
        : isApproval && approval ? approval.authorize(claimed) ?? (claimed.approvedBy === 'rule' ? this.authorizeLane(claimed) : null) : null);
      const lateDenied = gate();
      if (lateDenied) return await end('refused', lateDenied);
      const inMerge: { denied: string | null } = { denied: null };
      const r = await this.ports.merge(claimed, () => {
        inMerge.denied = gate();
        return inMerge.denied;
      });
      if (inMerge.denied) return await end('refused', inMerge.denied);
      if (r.ok) {
        const after = await this.read(claimed);
        const oid = after && after.state === 'MERGED' && after.headRefOid === claimed.expectHead ? after.mergeCommitOid ?? undefined : undefined;
        return await end('done', undefined, oid);
      }
      if (r.code === 'moved') return await end('refused', 'head-moved');
      if (r.code === 'blocked') return await end('refused', `blocked-${r.reason}`);
      if (r.code === 'invalid') return await end('refused', 'invalid');
      // A rate limit or a gh error may have happened after GitHub merged.
      return await end('uncertain', `merge-${r.code}`);
    } catch (err) {
      this.ports.log?.(`[moa-merge] ${id} failed: ${String(err)}`);
      return end('uncertain', 'executor-error');
    }
  }

  /** The lane's gate (a rule's: ruleAuthorize): its inputs read now, and
   *  today's lane merges counted from the outbox. */
  private authorizeLane(effect: MergeEffect): string | null {
    let inputs: LaneAuthorizeInputs | null;
    try {
      inputs = this.ports.lane?.inputs() ?? null;
    } catch {
      inputs = null;
    }
    const since = startOfLocalDay((this.ports.now ?? Date.now)());
    // Done, or uncertain (it may have merged): either uses up the cap. A
    // rule's merges share it with the lane's.
    const mergedToday = this.ports.effects.list()
      .filter((r) => lanePaced(r) && (r.status === 'done' || r.status === 'uncertain') && r.id !== effect.id && r.updatedAt >= since).length;
    return effect.approvedBy === 'rule' ? ruleAuthorize(inputs, mergedToday) : laneAuthorize(inputs, mergedToday);
  }

  private async read(e: MergeEffect): Promise<PrLaneFacts | null> {
    try {
      return await this.ports.facts.readFresh(e.repoPath, e.repoKey, e.prNumber);
    } catch {
      return null;
    }
  }

  private emit(e: MergeEffect): void {
    try { this.ports.emit?.(e); } catch { /* a listener never breaks the outbox */ }
  }
}
