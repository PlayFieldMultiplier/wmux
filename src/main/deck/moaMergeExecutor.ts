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
//   lane              `lane.authorize` (laneAuthorize): the factory is on, the
//                     lane's kill switch is off, and today's lane merges are
//                     under the daily cap. With no lane port nothing merges
//                     as 'lane' (`lane-not-wired`).
// A failure after the claim that may or may not have reached GitHub ends
// `uncertain`, never `done`.
//
// update-branch (lane only): when every predicate passes but GitHub says the
// branch is BEHIND its base, a same-repo `wtask/*` branch is updated
// (`updateBranch`) and the try ends `refused: behind-updated` — the new head
// needs its own checks and verdict, so it is a new effect. One update per
// repo runs at a time. Owner and moa-auto effects, forks and other branches
// go to the merge as before (mergeBlock refuses them as behind).

import type { MergeEffect } from '../../shared/moaDecision';
import type { PrLaneFacts, PrWriteResult } from '../../shared/prReview';
import { reconcileMergeEffect, type MoaEffectStore } from './moaEffectStore';
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
};

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
 *  `mergedToday` counts lane effects done since local midnight. */
export function laneAuthorize(inputs: LaneAuthorizeInputs | null, mergedToday: number): string | null {
  if (!inputs) return 'lane-inputs-unreadable';
  if (inputs.factoryEnabled !== true) return 'factory-disabled';
  if (inputs.killSwitch !== false) return 'lane-paused';
  if (!Number.isSafeInteger(inputs.dailyCap) || inputs.dailyCap < 0 || mergedToday >= inputs.dailyCap) return 'lane-daily-cap';
  return null;
}

/** The lane's ports, wired by the factory host. */
export interface LaneMergePort {
  /** The authorize inputs, read now; null when they cannot be read. */
  inputs: () => LaneAuthorizeInputs | null;
  /** The lane context for a lane effect (it has no decision or asker), read
   *  now on the executor's fresh read. */
  laneContext: (effect: MergeEffect, facts: PrLaneFacts) => Promise<Omit<MergeLaneContext, 'expectHead'>>;
}

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface MoaMergeExecutorPorts {
  effects: MoaEffectStore;
  facts: MergeLaneFactsReader;
  /** The squash merge itself (GhPrReviewService.merge with expectHead). */
  merge: (effect: MergeEffect) => Promise<PrWriteResult>;
  /** trustedAuthors, askerBranches, the PR's verdicts and its author
   *  workspaces for this effect, read by main now (never cached). */
  laneContext: (effect: MergeEffect, facts: PrLaneFacts) => Promise<Omit<MergeLaneContext, 'expectHead'>>;
  /** Null when an 'owner' or 'moa-auto' effect may run now, else the refusal
   *  reason. Never asked for a 'lane' effect. */
  authorize: (effect: MergeEffect) => string | null;
  /** The lane's authorize inputs and context. Absent: a 'lane' effect is
   *  refused `lane-not-wired`. */
  lane?: LaneMergePort;
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

/** A head branch the lane may update: one fan-out made. */
const LANE_UPDATABLE_BRANCH = /^wtask\/[^\s]+$/;

export class MoaMergeExecutor {
  private readonly running = new Map<string, Promise<MergeEffect | null>>();
  /** The update-branch in flight per repoKey (at most one). */
  private readonly updating = new Map<string, Promise<unknown>>();

  constructor(private readonly ports: MoaMergeExecutorPorts) {}

  /** Run one pending effect. Concurrent calls for one id share the run. */
  run(id: string): Promise<MergeEffect | null> {
    const live = this.running.get(id);
    if (live) return live;
    const p = this.runOnce(id).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  /** Wait for the runs under way to finish recording their result. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  /** Settle every uncertain row from a fresh read, then run what is pending
   *  (startup and the periodic tick). Never re-runs a row without a read. */
  async reconcileAll(): Promise<void> {
    for (const row of this.ports.effects.list()) {
      if (row.status !== 'uncertain') continue;
      const facts = await this.read(row);
      const next = await this.ports.effects.reconcile(row.id, facts);
      if (next) this.emit(next);
    }
    for (const row of this.ports.effects.list()) {
      if (row.status === 'pending') await this.run(row.id);
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
      const lane = this.ports.lane;
      if (isLane && !lane) return await end('refused', 'lane-not-wired');
      const denied = isLane ? this.authorizeLane(claimed) : this.ports.authorize(claimed);
      if (denied) return await end('refused', denied);
      const facts = await this.read(claimed);
      if (!facts) return await end('uncertain', 'read-failed');
      if (facts.number !== claimed.prNumber) return await end('refused', 'pr-mismatch');
      // Not open (or another head) is settled from the read, never merged.
      const pre = reconcileMergeEffect({ expectHead: claimed.expectHead, attempt: 0 }, facts);
      if (pre.status !== 'pending') return await end(pre.status === 'done' ? 'done' : pre.status === 'refused' ? 'refused' : 'uncertain', pre.reason, pre.mergeCommitOid);
      const ctx = isLane && lane ? await lane.laneContext(claimed, facts) : await this.ports.laneContext(claimed, facts);
      const verdict = evaluateMergeLane(facts, { ...ctx, expectHead: claimed.expectHead }, predicates);
      if (!verdict.ok) {
        const f = verdict.failures[0];
        return await end('refused', f ? `${f.predicate}:${f.reason}` : 'lane');
      }
      if (isLane && this.ports.updateBranch && facts.mergeStateStatus === 'BEHIND'
        && !facts.isCrossRepository && LANE_UPDATABLE_BRANCH.test(facts.headRefName)) {
        const r = await this.updateBranchSerialized(claimed, this.ports.updateBranch);
        return await end('refused', r.ok ? 'behind-updated' : r.code === 'moved' ? 'head-moved' : `behind-update-${r.code}`);
      }
      const wrongIdentity = await this.ports.identity?.(claimed);
      if (wrongIdentity) return await end('refused', wrongIdentity);
      const r = await this.ports.merge(claimed);
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

  /** The lane's gate: its inputs read now, and today's lane merges counted
   *  from the outbox. */
  private authorizeLane(effect: MergeEffect): string | null {
    let inputs: LaneAuthorizeInputs | null;
    try {
      inputs = this.ports.lane?.inputs() ?? null;
    } catch {
      inputs = null;
    }
    const since = startOfLocalDay((this.ports.now ?? Date.now)());
    const mergedToday = this.ports.effects.list()
      .filter((r) => r.approvedBy === 'lane' && r.status === 'done' && r.id !== effect.id && r.updatedAt >= since).length;
    return laneAuthorize(inputs, mergedToday);
  }

  /** One update-branch per repo at a time: a second waits for the first. */
  private async updateBranchSerialized(effect: MergeEffect, update: (e: MergeEffect) => Promise<PrWriteResult>): Promise<PrWriteResult> {
    const key = effect.repoKey;
    let prev = this.updating.get(key);
    while (prev) {
      await prev.catch(() => undefined);
      prev = this.updating.get(key);
    }
    const p = update(effect).catch((err): PrWriteResult => ({ ok: false, code: 'error', message: String(err) }));
    this.updating.set(key, p);
    try {
      return await p;
    } finally {
      if (this.updating.get(key) === p) this.updating.delete(key);
    }
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
