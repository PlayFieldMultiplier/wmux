// ─── The system gate on a bot task's report ────────────────────────────────
//
// A worker a bot started (lead, triage, maintainer: every preset but
// `verify`, which has its own gate in verifyPreset.ts) reports its work by
// moving its ledger row to review_requested. `completed` needs a gate main
// recorded itself, and no bot can run one or force a completion, so main
// runs it here, with the rules the verify gate uses:
//   - the shared TaskGateRunner (its allow-listed steps, its zero-dependency
//     rule, its parent-anchored "no gate" rule), recorded as a `system`
//     write with the HEAD it ran on;
//   - the steps chosen from origin's default branch (`gateBaseRef`), so a
//     worker cannot redefine the gate that grades its own work.
// Then, with the row re-read (a row that moved while the gate ran — sent
// back, failed, cancelled, stopped by the owner — gets nothing):
//   - a passing run (exit 0, recorded, not a recorded skip) completes the
//     task, written as the task's owner (the bot's workspace) exactly as a
//     bot's own ledger_update would be, which the ledger accepts only on that
//     system-recorded pass: the system adds no power a bot lacks;
//   - anything else (a failing, killed, skipped or refused gate, no worktree,
//     no base branch) leaves the task open.
// A research task (the `research` preset: a scratch folder, no repository,
// no code) has no gate to run: its report completes it at once, written as
// the task's owner the same way (the ledger lets a brain complete such a row
// without a gate), with one card and one wake like a gated report.
// Either way one system card in the task's thread says what happened, and the
// bot that started the task is woken once (`task.gated:<taskId>@<rev>`, the
// id the wake queue dedupes on) to read the settled row. That wake replaces
// the worker's own review_requested wake (fanoutCallerNotify.ts skips it), so
// a report is one bot turn, after the gate, never one before it.
//
// A merged pull request ends its task too. A reported task is completed when
// a repo-watch pr.merged fact (never a PR's title) names a PR on the task's
// own repository (LedgerDispatch.repoKey, recorded at dispatch; never the
// bot's current profile) from the task's own branch (the fact's head branch,
// not a fork's), merged into origin's default branch (the fact's base: the
// ref the gate is read from), and the task worktree's HEAD is the merged head
// or behind it (commits made after the merge were never merged). It is
// completed as a gate pass completes it: written as the task's owner, forced
// with `merged` as the reason (a repository with no gate, or a gate still
// running, has no pass to complete on), the merge recorded as the row's
// completion (LedgerEntry.completion, main's own field, which the restart
// re-wake reads; the summary's `[merged: PR #<n>]` is only its words), one
// card and one wake the same way. This is the one completion main forces for
// a bot's code task, and only on what landed on the default branch, which no
// bot merges past the owner's merge rules. Checked when a pr.merged fact
// arrives, when a task reports (a PR merged before the report ends it then,
// with no gate), at install and every MERGE_SWEEP_MS (a merge whose task
// branch could not be read yet, or whose write failed, is tried again then);
// one check per task at a time, and a caller that finds one under way waits
// for its answer. A gate still running when the merge lands finds the row
// moved and settles nothing; the ledger records no gate on an ended row. A PR
// closed without a merge leaves the task open, and so does a task still
// `working` (the ledger has no working → completed move).
//
// Every card carries the id of the row it was written about
// (`task.gated:<taskId>@<rev>`, the card's clientPostId).
// At install (start, after a restart) every open row in this state is caught
// up: one whose current rev already has its card (a refused, skipped or
// not-run gate records nothing in the ledger, so the card is the only trace)
// wakes the bot again and is neither gated nor carded again; otherwise a
// report with no gate after it is gated now; one whose newest write is
// a passing gate is gated again (a quit can land between a gate recorded for
// an older report and the run for the newer one, so that pass is not trusted
// for completion); one whose gate did not pass wakes the bot again (the queue
// drops a wake it already delivered). A task the system completed in the
// last day wakes its bot again too, in case the quit fell between the
// completion and the wake (same id, so a delivered wake is dropped).

import { isResearchDispatch, type LedgerEntry } from '../../shared/ledger';
import type { BotProfile } from '../../shared/bot';
import type { Fact } from '../../shared/facts';
import { normalizeRepoKey } from '../../shared/repoKey';
import { isSystemGatePass } from '../../shared/botTask';
import { taskThreadOf, type CardNotice, type RoomCard, type ThreadId } from '../../shared/room';
import type { WakeReason } from '../../shared/wake';
import type { LedgerUpdateInput, LedgerUpdateResult } from '../../daemon/ledger/TaskLedger';
import type { GateRunInput, GateRunResult } from '../worktask/TaskGateRunner';
import { VERIFY_GATE_SYSTEM_WORKSPACE, verifyGateFactId } from './verifyPreset';

/** Whether a transition is a bot task (not a verify task) reporting its work. */
export function isTaskGateReport(entry: LedgerEntry, to: string): boolean {
  const d = entry.dispatch;
  return to === 'review_requested'
    && d?.origin.kind === 'bot' && typeof d.origin.botId === 'string' && d.origin.botId.length > 0
    && d.preset !== 'verify';
}

/** Whether a reported row's newest write is a system gate (the report was gated). */
export function reportWasGated(entry: LedgerEntry): boolean {
  return entry.gate?.recordedBy === 'system' && entry.updatedBy.kind === 'system';
}

/**
 * Complete a bot's research task on its report: only a row still in
 * review_requested whose dispatch is a research task, written as the task's
 * owner with no force (the ledger completes such a row without a gate). One
 * retry on a write that landed in between. Never throws.
 */
export async function completeResearchTask(ledger: CheckedTaskLedger, taskId: string): Promise<{ entry: LedgerEntry } | { entry: null; why: string }> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = ledger.get(taskId);
      if (!row) return { entry: null, why: 'the task is gone' };
      if (row.status !== 'review_requested') return { entry: null, why: `the task moved to ${row.status}` };
      if (!isResearchDispatch(row.dispatch)) return { entry: null, why: 'the task is not a research task' };
      const r = await ledger.update({
        id: taskId,
        status: 'completed',
        actor: { kind: 'brain', workspaceId: row.ownerWorkspaceId },
        expectedRev: row.rev,
      });
      if (r.ok) return { entry: r.entry };
      if (r.error !== 'stale_rev') return { entry: null, why: r.message };
    }
  } catch (err) {
    return { entry: null, why: String(err) };
  }
  return { entry: null, why: 'the task kept changing' };
}

/** The ledger calls completing a checked task makes (TaskLedger). */
export interface CheckedTaskLedger {
  get(id: string): LedgerEntry | null;
  update(input: LedgerUpdateInput): Promise<LedgerUpdateResult>;
}

/**
 * Complete a bot task whose report the system gate passed: only a row still
 * in review_requested whose newest write is that passing system gate, written
 * as the task's owner with no force (the ledger itself refuses `completed`
 * without such a gate). One retry on a write that landed in between. Never
 * throws; the completed row, or null with why not.
 */
export async function completeCheckedTask(ledger: CheckedTaskLedger, taskId: string): Promise<{ entry: LedgerEntry } | { entry: null; why: string }> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = ledger.get(taskId);
      if (!row) return { entry: null, why: 'the task is gone' };
      if (row.status !== 'review_requested') return { entry: null, why: `the task moved to ${row.status}` };
      if (!reportWasGated(row) || !isSystemGatePass(row.gate)) return { entry: null, why: 'no passing system gate is the newest write on the task' };
      const r = await ledger.update({
        id: taskId,
        status: 'completed',
        actor: { kind: 'brain', workspaceId: row.ownerWorkspaceId },
        expectedRev: row.rev,
      });
      if (r.ok) return { entry: r.entry };
      if (r.error !== 'stale_rev') return { entry: null, why: r.message };
    }
  } catch (err) {
    return { entry: null, why: String(err) };
  }
  return { entry: null, why: 'the task kept changing' };
}

/** The reason the ledger records on a task its merged pull request ended. */
export const MERGED_REASON = 'merged';

/** The words heading the summary of a task its merged pull request ended
 *  (display only: LedgerEntry.completion is the record). */
export function mergedMark(pr: number): string {
  return `[merged: PR #${pr}]`;
}

/** Whether a completed row was ended by its merged pull request: main's own
 *  completion record, never the summary's words. Pure. */
export function isMergeCompletion(entry: LedgerEntry): boolean {
  return entry.status === 'completed' && entry.completion?.source === 'merge';
}

/** One merge of a pull request from a task's branch. */
export interface BranchMerge {
  pr: number;
  /** The branch it was merged into. */
  base: string;
  /** The PR's head when it was merged (as repo-watch read it). */
  headSha: string;
}

/**
 * The merges of pull requests from `branch` on `repoKey`, newest first: each
 * pr.merged fact whose own head branch is `branch` (not a fork's) and that
 * names its base and head. Selected by the merge fact itself, never by the
 * PR last seen opened from the branch (the fact log drops a reopened PR's
 * second pr.opened). Pure over the PR facts, oldest first.
 */
export function mergesOfBranch(facts: readonly Fact[], repoKey: string | null | undefined, branch: string | null | undefined): BranchMerge[] {
  const repo = normalizeRepoKey(repoKey);
  if (!repo || !branch) return [];
  const out: BranchMerge[] = [];
  for (const f of facts) {
    const n = f.ref?.pr;
    if (f.kind !== 'pr.merged' || typeof n !== 'number' || normalizeRepoKey(f.repoKey) !== repo) continue;
    const p = f.payload ?? {};
    if (p.headRefName !== branch || p.isCrossRepository !== false) continue;
    const base = typeof p.baseRefName === 'string' ? p.baseRefName : '';
    const headSha = typeof p.headRefOid === 'string' && p.headRefOid ? p.headRefOid : typeof f.ref?.headSha === 'string' ? f.ref.headSha : '';
    if (base && headSha) out.push({ pr: n, base, headSha });
  }
  return out.reverse();
}

/**
 * Whether the worktree's HEAD is commit `sha` or an ancestor of it (its work
 * is all in that commit). False when that cannot be told: not a full commit
 * id, no HEAD, or the commit not in the repository.
 */
export async function worktreeHeadMerged(git: (args: string[], cwd: string) => Promise<{ stdout: string; code: number }>, worktreePath: string, sha: string): Promise<boolean> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) return false;
  try {
    const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], worktreePath);
    if (head.code !== 0) return false;
    if (head.stdout.trim().toLowerCase() === sha.toLowerCase()) return true;
    return (await git(['merge-base', '--is-ancestor', 'HEAD', sha], worktreePath)).code === 0;
  } catch {
    return false;
  }
}

/**
 * Complete a reported bot task whose pull request `pr` was merged: only a row
 * still in review_requested that the gate would check (not a verify or a
 * research task), written as the task's owner, forced with MERGED_REASON (a
 * merge is not a gate: a repository with no gate, or a gate still running,
 * has no pass to complete on), the merge recorded as the row's completion and
 * its summary headed by mergedMark (both kept even where the ledger needs no
 * force, a recorded "no gate" skip). One retry on a
 * write that landed in between. Never throws; the completed row, or null with
 * why not.
 */
export async function completeMergedTask(ledger: CheckedTaskLedger, taskId: string, pr: number): Promise<{ entry: LedgerEntry } | { entry: null; why: string }> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = ledger.get(taskId);
      if (!row) return { entry: null, why: 'the task is gone' };
      if (row.status !== 'review_requested') return { entry: null, why: `the task moved to ${row.status}` };
      if (!isTaskGateReport(row, row.status) || isResearchDispatch(row.dispatch)) return { entry: null, why: 'the task is not a bot\'s code task' };
      const r = await ledger.update({
        id: taskId,
        status: 'completed',
        actor: { kind: 'brain', workspaceId: row.ownerWorkspaceId },
        expectedRev: row.rev,
        summary: `${mergedMark(pr)} ${row.summary ?? ''}`.trim(),
        force: true,
        reason: MERGED_REASON,
        completion: { source: 'merge', pr },
      });
      if (r.ok) return { entry: r.entry };
      if (r.error !== 'stale_rev') return { entry: null, why: r.message };
    }
  } catch (err) {
    return { entry: null, why: String(err) };
  }
  return { entry: null, why: 'the task kept changing' };
}

export interface TaskGatePorts {
  onTransition: (fn: (t: { entry: LedgerEntry; from: string | null; to: string }) => void) => () => void;
  ledgerRow: (taskId: string) => LedgerEntry | null;
  /** The open ledger rows, read once at install (restart catch-up). */
  openRows?: () => LedgerEntry[];
  /** Every ledger row, read once at install (completions to wake again). */
  allRows?: () => LedgerEntry[];
  now?: () => number;
  bot: (botId: string) => BotProfile | null;
  worktreeOf: (entry: LedgerEntry) => Promise<string | null>;
  /** origin's default branch as a ref (`origin/main`), or null. */
  baseRef: (repoPath: string) => Promise<string | null>;
  runGate: (input: GateRunInput) => Promise<GateRunResult>;
  /** completeCheckedTask over the hosted ledger. */
  complete: (taskId: string) => Promise<{ entry: LedgerEntry } | { entry: null; why: string }>;
  /** completeResearchTask over the hosted ledger. */
  completeResearch?: (taskId: string) => Promise<{ entry: LedgerEntry } | { entry: null; why: string }>;
  /** The fact log's live facts: a `pr.merged` ends its task (with prFacts,
   *  branchOf and completeMerged; absent, merges end nothing). */
  onFact?: (fn: (f: Fact) => void) => () => void;
  /** The PR facts in the fact log's window, oldest first. */
  prFacts?: () => readonly Fact[];
  /** A task's branch; null when it has none (a detached checkout),
   *  undefined when it cannot be read now. */
  branchOf?: (entry: LedgerEntry) => Promise<string | null | undefined>;
  /** Whether the worktree's HEAD is `sha` or an ancestor of it (false when
   *  it cannot be told). */
  headMerged?: (worktreePath: string, sha: string) => Promise<boolean>;
  /** completeMergedTask over the hosted ledger. */
  completeMerged?: (taskId: string, pr: number) => Promise<{ entry: LedgerEntry } | { entry: null; why: string }>;
  /** How often open reports are checked for a merged PR (default
   *  MERGE_SWEEP_MS). */
  mergeSweepMs?: number;
  wake: (input: { botId: string; workspaceId: string; reason: WakeReason; priority: 1; threadId: ThreadId }) => unknown;
  /** A system card in the task's thread (best effort), keyed by the row it
   *  is about (`verifyGateFactId(taskId, rev)`): a key already carded writes
   *  nothing. */
  note?: (workspaceId: string, threadId: ThreadId, title: string, body: string, key: string, notice?: CardNotice) => void;
  /** Whether a system card with this key is in the task's thread; null when
   *  the room cannot be read yet (the install catch-up waits for it). */
  noted?: (workspaceId: string, threadId: ThreadId, key: string) => boolean | null;
  /** How long the install catch-up waits for `noted` to answer (default
   *  NOTED_WAIT_MS); after that it runs as if nothing was carded. */
  notedWaitMs?: number;
  log?: (msg: string) => void;
}

/** Whether the task's thread holds a system card with this key (a bot's
 *  post cannot claim one: only system cards count). Null while the rooms
 *  cannot be read. Pure over `find`. */
export function gateCardNoted(
  find: ((workspaceId: string, match: (c: RoomCard) => boolean) => RoomCard | null) | null,
  workspaceId: string,
  threadId: ThreadId,
  key: string,
): boolean | null {
  if (!find) return null;
  return find(workspaceId, (c) => c.threadId === threadId && c.actor.kind === 'system' && c.clientPostId === key) !== null;
}

/** How long the install catch-up waits for the room to be readable. */
export const NOTED_WAIT_MS = 10_000;
const NOTED_POLL_MS = 250;

/** A gate card: its English words and its stable code (RoomCard.notice). */
export interface GateCard {
  title: string;
  body: string;
  notice: CardNotice;
}

/** The card for a gate run that did not complete the task. */
export function describeTaskGate(r: GateRunResult): GateCard {
  if (r.ok && r.status === 'completed') {
    const g = r.result;
    const verdict = g.exitCode === 0 ? 'passed' : g.exitCode === null ? 'was killed' : `failed (exit ${g.exitCode})`;
    const head = g.headSha ? `at ${g.headSha}` : 'with no pinned head (the tree changed or HEAD moved during the run)';
    const receipt = r.recorded ? 'recorded in the ledger' : 'NOT recorded (ledger unreachable)';
    const notice: CardNotice = g.exitCode === 0 ? { code: 'gate.passed' } : g.exitCode === null ? { code: 'gate.killed' } : { code: 'gate.failed', args: { exit: g.exitCode } };
    return { title: `Gate ${verdict}: task left open`, body: `\`${g.command}\` ${head}; ${receipt}.`, notice };
  }
  if (r.ok && r.status === 'skipped') {
    return { title: `Gate skipped (${r.skipped}): task left open`, body: r.detail, notice: { code: 'gate.skipped', args: { reason: r.skipped } } };
  }
  if (!r.ok && r.status === 'busy') return { title: 'Gate already running: task left open', body: 'Another gate run holds this task; its result is in the task\'s ledger row when it ends.', notice: { code: 'gate.busy' } };
  if (!r.ok && r.code === 'no_base_gate') {
    return {
      notice: { code: 'gate.noBase', args: { detail: r.error } },
      title: 'No gate on the default branch yet: task left open',
      body: `${r.error}.\n\nThis task cannot be completed by the gate as it stands. To finish it, either merge a test script into the default branch first `
        + '(its own small PR), then have the bot send the task back so its worker reports again and the gate runs; or end the task: '
        + 'ask the bot to cancel it, or close its workspace. The task\'s branch and worktree are kept either way.',
    };
  }
  return { title: 'Gate refused: task left open', body: r.ok ? '' : r.error, notice: { code: 'gate.refused' } };
}

/** How far back a completion is woken again at install. */
export const COMPLETION_REWAKE_MS = 24 * 3_600_000;

/** How often open reports are checked for a merged PR (a merge whose task
 *  branch could not be read, or whose completion did not land, is tried
 *  again then). */
export const MERGE_SWEEP_MS = 5 * 60_000;

/** Install the gate on bot task reports. Returns the unsubscribe. */
export function installTaskGate(ports: TaskGatePorts): () => void {
  const log = ports.log ?? ((m: string) => console.warn(m));
  const running = new Set<string>();
  /** Reports that arrived while their task's gate ran: gated again after. */
  const again = new Set<string>();

  const note = (entry: LedgerEntry, title: string, body: string, notice: CardNotice): void => {
    try {
      ports.note?.(entry.ownerWorkspaceId, taskThreadOf(entry), title, body, verifyGateFactId(entry.id, entry.rev), notice);
    } catch {
      /* the card is best effort */
    }
  };
  const wake = (entry: LedgerEntry): void => {
    const botId = entry.dispatch?.origin.botId ?? '';
    try {
      ports.wake({
        botId, workspaceId: entry.ownerWorkspaceId, priority: 1, threadId: taskThreadOf(entry),
        reason: { kind: 'facts', factIds: [verifyGateFactId(entry.id, entry.rev)], trigger: { kind: 'task.done' } },
      });
    } catch (err) {
      log(`[factory] gate wake for ${entry.id} failed: ${String(err)}`);
    }
  };
  /** The row now, when it still holds the report being gated. */
  const stillReported = (taskId: string): LedgerEntry | null => {
    const row = ports.ledgerRow(taskId);
    return row && isTaskGateReport(row, row.status) ? row : null;
  };
  /** Settle a gated report: complete on a pass, else leave it open; wake once. */
  const settle = async (row: LedgerEntry, failure: GateCard | null): Promise<void> => {
    if (!failure) {
      const done = await ports.complete(row.id);
      if (done.entry) {
        const g = done.entry.gate;
        note(done.entry, 'Task checked: gate passed, task completed', `\`${g?.command ?? 'gate'}\` ${g?.headSha ? `at ${g.headSha}` : 'with no pinned head'}.`, { code: 'gate.checked' });
        wake(done.entry);
        return;
      }
      const now = stillReported(row.id);
      if (!now) return;
      note(now, 'Gate passed: task not completed', done.why, { code: 'gate.passedNotCompleted' });
      wake(now);
      return;
    }
    note(row, failure.title, failure.body, failure.notice);
    wake(row);
  };

  let disposed = false;
  const readPrFacts = (): readonly Fact[] => {
    try {
      return ports.prFacts?.() ?? [];
    } catch {
      return [];
    }
  };
  const mergeable = (): boolean => !!(ports.branchOf && ports.completeMerged && ports.headMerged);
  /** The open reports a merge could end: code tasks with their repository recorded. */
  const reportedRows = (): LedgerEntry[] => {
    try {
      return (ports.openRows?.() ?? []).filter((e) => e.status === 'review_requested' && isTaskGateReport(e, e.status)
        && !isResearchDispatch(e.dispatch) && !!normalizeRepoKey(e.dispatch?.repoKey));
    } catch {
      return [];
    }
  };
  /** The PR whose merge into origin's default branch holds the task's work
   *  (its worktree's HEAD is that merge's head or behind it), else null. */
  const mergedPrOf = async (row: LedgerEntry, facts: readonly Fact[]): Promise<number | null> => {
    if (!ports.branchOf || !ports.headMerged) return null;
    const branch = await ports.branchOf(row);
    const merges = branch ? mergesOfBranch(facts, row.dispatch?.repoKey, branch) : [];
    if (merges.length === 0) return null;
    const worktree = await ports.worktreeOf(row);
    if (!worktree) return null;
    // Only what landed where the gate is read from: a merge into any other
    // base would complete a task no gate checked and main never received.
    const baseRef = await ports.baseRef(worktree);
    for (const m of merges) {
      if (baseRef !== `origin/${m.base}`) continue;
      // Commits made after the merged head were never merged.
      if (await ports.headMerged(worktree, m.headSha)) return m.pr;
    }
    return null;
  };
  /** End the reported task when its PR was merged: one card, one wake. */
  const checkMerged = async (taskId: string, facts: readonly Fact[]): Promise<boolean> => {
    const row = stillReported(taskId);
    if (!row || isResearchDispatch(row.dispatch) || !ports.completeMerged) return false;
    let pr: number | null = null;
    try {
      pr = await mergedPrOf(row, facts);
    } catch (err) {
      log(`[factory] merged PR of task ${taskId} not read: ${String(err)}`);
    }
    if (pr === null || disposed) return false;
    const done = await ports.completeMerged(taskId, pr);
    if (!done.entry) {
      log(`[factory] merged PR #${pr} did not complete task ${taskId}: ${done.why}`);
      return false;
    }
    // Disposed meanwhile: the completion stands; its wake comes again at the
    // next install (the re-wake reads the row's completion).
    if (disposed) return true;
    note(done.entry, `PR #${pr} merged: task completed`, 'The pull request from this task\'s branch was merged, so the task ends without waiting for a gate.', { code: 'task.merged', args: { pr } });
    wake(done.entry);
    return true;
  };
  /** The merge check under way per task. */
  const merging = new Map<string, Promise<boolean>>();
  /** Check the task for a merge, after any check of it already under way
   *  (that one may end it: its answer is taken). True when it was ended. */
  const endIfMerged = async (taskId: string, facts: readonly Fact[]): Promise<boolean> => {
    if (!mergeable()) return false;
    for (let pending = merging.get(taskId); pending; pending = merging.get(taskId)) {
      if (await pending.catch(() => false)) return true;
    }
    if (disposed) return false;
    const check = checkMerged(taskId, facts);
    merging.set(taskId, check);
    try {
      return await check;
    } finally {
      if (merging.get(taskId) === check) merging.delete(taskId);
    }
  };
  /** Check `rows` one after another (never throws). */
  const endMerged = async (rows: readonly LedgerEntry[], facts: readonly Fact[]): Promise<void> => {
    for (const row of rows) {
      if (disposed) return;
      try {
        await endIfMerged(row.id, facts);
      } catch (err) {
        log(`[factory] merge check of ${row.id} failed: ${String(err)}`);
      }
    }
  };
  /** Every open report, against the fact log's window (install and sweep). */
  const sweepMerged = (): void => {
    if (disposed || !mergeable()) return;
    const rows = reportedRows();
    if (rows.length > 0) void endMerged(rows, readPrFacts());
  };

  const run = async (taskId: string): Promise<void> => {
    const entry = stillReported(taskId);
    if (!entry) return;
    // A research task changed no code: nothing to gate.
    if (isResearchDispatch(entry.dispatch)) {
      const done = ports.completeResearch
        ? await ports.completeResearch(entry.id)
        : { entry: null, why: 'research tasks cannot be completed here' };
      if (done.entry) {
        note(done.entry, 'Research reported: task completed', 'A research task changes no code, so no gate runs on it.', { code: 'research.completed' });
        wake(done.entry);
        return;
      }
      const now = stillReported(entry.id);
      if (!now) return;
      note(now, 'Research reported: task not completed', done.why, { code: 'research.notCompleted' });
      wake(now);
      return;
    }
    // A PR merged before the report ends the task now, with no gate.
    if (await endIfMerged(entry.id, readPrFacts())) return;
    if (!stillReported(taskId)) return;
    const bot = ports.bot(entry.dispatch?.origin.botId ?? '');
    const repoPath = bot?.repo?.repoPath;
    if (!bot || !repoPath) {
      await settle(entry, { title: 'Gate not run: task left open', body: 'The bot that started this task is gone or has no repository.', notice: { code: 'gate.notRunNoBot' } });
      return;
    }
    const [worktree, baseRef] = await Promise.all([ports.worktreeOf(entry), ports.baseRef(repoPath)]);
    // The row may have moved (sent back, stopped by the owner) during the lookups.
    const before = again.has(taskId) ? null : stillReported(taskId);
    if (!before) return;
    if (!worktree || !baseRef) {
      await settle(before, {
        title: 'Gate not run: task left open',
        body: !worktree ? 'The task worktree is not on disk.' : 'origin\'s default branch could not be resolved, so there is no base gate to run.',
        notice: { code: !worktree ? 'gate.notRunNoWorktree' : 'gate.notRunNoBaseRef' },
      });
      return;
    }
    const result = await ports.runGate({
      taskId,
      worktreePath: worktree,
      systemWorkspaceId: VERIFY_GATE_SYSTEM_WORKSPACE,
      projectRoot: repoPath,
      gateBaseRef: baseRef,
    });
    // A report that arrived during the run is gated again (start's finally);
    // this run's result does not settle it.
    const now = again.has(taskId) ? null : stillReported(taskId);
    if (!now) return;
    const passed = result.ok && result.status === 'completed' && result.recorded && result.result.exitCode === 0;
    await settle(now, passed ? null : describeTaskGate(result));
  };

  const start = (taskId: string): void => {
    if (running.has(taskId)) {
      again.add(taskId);
      return;
    }
    running.add(taskId);
    void run(taskId)
      .catch((err) => log(`[factory] gate for ${taskId} failed: ${String(err)}`))
      .finally(() => {
        running.delete(taskId);
        if (again.delete(taskId) && stillReported(taskId)) start(taskId);
      });
  };

  const off = ports.onTransition((t) => {
    if (isTaskGateReport(t.entry, t.to)) start(t.entry.id);
  });

  const offFacts = ports.onFact?.((f) => {
    if (f.kind !== 'pr.merged') return;
    const repo = normalizeRepoKey(f.repoKey);
    if (!repo) return;
    const rows = reportedRows().filter((e) => normalizeRepoKey(e.dispatch?.repoKey) === repo);
    if (rows.length > 0) void endMerged(rows, [...readPrFacts(), f]);
  });

  /** Whether this rev of the row already has its card; null: unknown yet. */
  const carded = (entry: LedgerEntry): boolean | null => {
    if (!ports.noted) return false;
    try {
      return ports.noted(entry.ownerWorkspaceId, taskThreadOf(entry), verifyGateFactId(entry.id, entry.rev));
    } catch {
      return null;
    }
  };
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  const sweepOpen = (waitedMs: number): void => {
    sweepTimer = null;
    if (disposed) return;
    let open: LedgerEntry[] = [];
    try {
      open = (ports.openRows?.() ?? []).filter((e) => isTaskGateReport(e, e.status));
    } catch {
      open = [];
    }
    // The room is not readable yet (its module starts after this one): wait
    // for it rather than gate and card a report again.
    const waitMs = ports.notedWaitMs ?? NOTED_WAIT_MS;
    if (waitedMs < waitMs && open.some((e) => carded(e) === null)) {
      sweepTimer = setTimeout(() => sweepOpen(waitedMs + NOTED_POLL_MS), NOTED_POLL_MS);
      sweepTimer.unref?.();
      return;
    }
    // A PR merged while the app was closed, or before a report a quit cut short.
    sweepMerged();
    for (const entry of open) {
      // A report that arrived while the sweep waited is being gated already.
      if (running.has(entry.id)) continue;
      // This rev was gated and carded already (before a restart): the bot is
      // woken again (the queue drops a delivered wake), nothing runs again.
      // A carded pass is not: its completion did not land, so it is gated
      // again below, as any pass at install is.
      const passed = reportWasGated(entry) && isSystemGatePass(entry.gate);
      if (carded(entry) === true && !passed) wake(entry);
      // Not gated, or gated with a pass that may belong to an older report:
      // gate it (again). A gate that did not pass (its card is already up)
      // wakes the bot again, which the queue drops once delivered.
      else if (!reportWasGated(entry) || isSystemGatePass(entry.gate)) start(entry.id);
      else wake(entry);
    }
  };
  sweepOpen(0);
  const mergeSweep = mergeable() ? setInterval(sweepMerged, ports.mergeSweepMs ?? MERGE_SWEEP_MS) : null;
  mergeSweep?.unref?.();
  let all: LedgerEntry[] = [];
  try {
    all = ports.allRows?.() ?? [];
  } catch {
    all = [];
  }
  const since = (ports.now ?? Date.now)() - COMPLETION_REWAKE_MS;
  for (const entry of all) {
    if (entry.status !== 'completed' || entry.updatedAt < since || entry.updatedBy.kind !== 'brain') continue;
    if (!isTaskGateReport(entry, 'review_requested')) continue;
    if (!isSystemGatePass(entry.gate) && !isResearchDispatch(entry.dispatch) && !isMergeCompletion(entry)) continue;
    wake(entry);
  }
  return () => {
    disposed = true;
    if (sweepTimer) clearTimeout(sweepTimer);
    if (mergeSweep) clearInterval(mergeSweep);
    off();
    offFacts?.();
  };
}
