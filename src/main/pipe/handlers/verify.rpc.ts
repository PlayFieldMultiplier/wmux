// ─── verify.recordVerdict — a verifier's PASS/FAIL on one PR head ────────────
//
// The method behind the pr_verdict MCP tool (shared/prVerdict.ts has the
// contract). Identity is server-resolved (pipe/paneCaller.ts
// resolvePaneCaller): the verified senderPtyId's workspace, never params; a
// brain, a hosted workspace or an unattributed caller is refused. The repo is
// the one the verifier pane's own cwd belongs to. Before recording:
//   - the PR head is read fresh (the merge lane's read) and must be `headSha`;
//   - `git rev-parse HEAD` in the verifier's cwd must be `headSha`;
//   - the verifier's cwd must not be on the PR's own branch (a detached
//     checkout of the head is the expected shape).
// Independent of Moa's delegate: a verdict is recorded whether or not it is on.
//
// A factory bot (ctx.bot, from its token) takes the bot path instead: any
// enabled bot of its workspace records on its own repository (a verdict is
// evidence for the merge lane, not a merge right), the principal is its
// binding, the repo is its profile's, and the verdict names the verify task
// it rests on
// (`evidence: {taskId}`). The task's ledger row — written by main, never by
// the bot — must back the verdict exactly as the merge lane will check it
// (moaMergeLane.ts verdictEvidenceCheck): dispatched by this bot with the
// verify preset, on a detached checkout of headSha, with a system gate that
// ran on headSha and was not a skip. A PASS needs that gate green; a FAIL
// may rest on a red one. A verdict the lane would not count is refused here
// with the lane's own reason, so nothing is recorded that cannot count. A
// recorded verdict closes its verify task (factory/verdictedTasks.ts); so
// does one refused because the PR head moved past the task's checkout.
//
// A bot may instead record a reading-only verdict (`evidence: {reading:
// true}`): it read the change itself and started no worker. Main records it
// only where no gate grades the change, found from its own reads, never from
// the bot's word: the PR's base branch declares no gate at its tip as the
// forge reports it (facts.baseRefOid), read at that commit
// (TaskGateRunner.baseGate) once `origin/<baseRefName>` in the repository is
// that same commit (a stale local copy is refused: it may predate a gate).
// The evidence names that ref and commit; the merge lane counts it while the
// forge's base tip is still that commit, or declares no gate either. A docs-only change
// in a repository with a gate is no exception: a docs file can be what the
// gate checks. Anything else is refused `gate-required`: it needs a verify
// worker. The guest checks are the same as for a task verdict.

import type { RpcRouter } from '../RpcRouter';
import {
  PR_VERDICT_ID_MAX,
  PR_VERDICT_RPC,
  READING_EVIDENCE_TASK_ID,
  parsePrVerdictInput,
  type PrVerdictReadingBasis,
  type PrVerdictRecord,
  type PrVerdictResult,
} from '../../../shared/prVerdict';
import type { PrLaneFacts } from '../../../shared/prReview';
import type { BotBinding, BotProfile } from '../../../shared/bot';
import type { RpcContext } from '../../../shared/rpc';
import type { LedgerEntry } from '../../../shared/ledger';
import { verdictEvidenceCheck, type LaneEvidenceRow } from '../../deck/moaMergeLane';
import type { BaseGate } from '../../worktask/TaskGateRunner';
import { originBranchRef, repoBaseGate } from '../../factory/verifyPreset';
import { getBotDirectory } from '../../factory/botStore';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import { closeVerifyTask, isBotVerifyTask } from '../../factory/verdictedTasks';
import { bodyOf, resolvePaneCaller, type PaneCallerDeps } from '../paneCaller';
import { GUEST_TURN_STARTS_NO_WORKERS, guestOfRunningWake, type GuestProvenance } from '../../factory/wakeTaint';
import { conversationSignedIn, signedInRefusal } from '../../factory/conversationMarks';

export interface VerifyRpcDeps extends PaneCallerDeps {
  /** The remote key of the repo a cwd belongs to, or null. */
  repoKeyOf: (cwd: string) => Promise<string | null>;
  /** The PR read fresh (LANE_PR_QUERY); throws when it cannot be read. */
  readPr: (repoPath: string, repoKey: string, prNumber: number) => Promise<PrLaneFacts>;
  /** `git <args>` in `cwd`, trimmed stdout; null when git fails. */
  git: (args: string[], cwd: string) => Promise<string | null>;
  record: (rec: PrVerdictRecord) => Promise<void>;
  now?: () => number;
  /** The bot path's reads; default the factory's bot directory and the
   *  hosted task ledger. */
  bot?: VerifyBotPorts;
}

export interface VerifyBotPorts {
  profile: (botId: string) => BotProfile | null;
  ledgerRow: (taskId: string) => LedgerEntry | null;
  /** Close this bot's verify task (verdictedTasks.ts closeVerifyTask).
   *  Missing: a stale task is left open. */
  closeVerifyTask?: (taskId: string, botId: string, why: string) => Promise<boolean>;
  /** The guest provenance of the bot's running wake (wakeTaint.ts). Missing:
   *  the running tracker's. */
  guestWake?: (botId: string) => GuestProvenance;
  /** Whether the bot's live conversation holds data from a signed-in task
   *  (none: yes). Missing: conversationMarks.ts. */
  signedIn?: (botId: string) => boolean;
  /** The gate the repository declares at a base commit, for a reading-only
   *  verdict. Missing: repoBaseGate (the shared gate runner's). */
  baseGate?: (repoPath: string, at: string) => Promise<BaseGate>;
}

const defaultBotPorts: VerifyBotPorts = {
  profile: (botId) => getBotDirectory()?.get(botId) ?? null,
  ledgerRow: (taskId) => getTaskLedger().get(taskId),
  closeVerifyTask: (taskId, botId, why) => closeVerifyTask(getTaskLedger(), taskId, botId, why),
};

/** The principal's agent label for a bot verdict. */
export const BOT_VERDICT_AGENT = 'bot:verifier';

/** The ledger row as the merge lane reads it (LaneEvidenceRow). */
export function laneEvidenceRowOf(row: LedgerEntry): LaneEvidenceRow {
  const d = row.dispatch;
  return {
    taskId: row.id,
    origin: d?.origin ?? { kind: 'unknown' },
    preset: d?.preset ?? null,
    checkout: d?.checkout ? { sha: d.checkout.sha, detached: d.checkout.detached === true } : null,
    gate: row.gate ?? null,
  };
}

function botEvidenceOf(raw: unknown): { taskId: string } | { reading: true } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length === 1 && r.reading === true) return { reading: true };
  if (keys.some((k) => k !== 'taskId')) return null;
  return typeof r.taskId === 'string' && r.taskId.length > 0 && r.taskId.length <= PR_VERDICT_ID_MAX ? { taskId: r.taskId } : null;
}

/** Why a reading-only verdict cannot rest on reading alone, from what the
 *  repository declares as its gate. */
function gateRequiredMessage(gate: Exclude<BaseGate, { kind: 'none' }>, baseRef: string): string {
  return gate.kind === 'declared'
    ? `${baseRef} declares the gate \`${gate.command}\`, docs-only change or not: start a verify worker at the head`
    : `wmux cannot tell whether ${baseRef} declares a gate (${gate.detail.slice(0, 200)}): start a verify worker at the head`;
}

/** The bot path of verify.recordVerdict (see the header). */
export async function recordBotVerdict(
  params: Record<string, unknown>,
  bot: BotBinding,
  deps: VerifyRpcDeps,
): Promise<PrVerdictResult> {
  const { evidence: rawEvidence, ...rest } = bodyOf(params);
  const parsed = parsePrVerdictInput(rest);
  if (!parsed.ok) return { ok: false, code: 'invalid', message: `${parsed.field ? `${parsed.field}: ` : ''}${parsed.message}` };
  const input = parsed.value;
  const evidence = botEvidenceOf(rawEvidence);
  if (!evidence) return { ok: false, code: 'evidence-missing', message: 'evidence must be {taskId} (the verify task this verdict rests on) or {reading: true} (a change no gate grades, read by you)' };
  const ports = deps.bot ?? defaultBotPorts;
  // A verdict is merge evidence: no wake that is not known clean records one.
  const guestRefusal = (): PrVerdictResult | null => ((ports.guestWake ?? guestOfRunningWake)(bot.botId) !== false
    ? { ok: false, code: 'surface', message: GUEST_TURN_STARTS_NO_WORKERS } : null);
  const refusedAtEntry = guestRefusal();
  if (refusedAtEntry) return refusedAtEntry;
  // A verdict's summary can reach the forge: none from a conversation that
  // holds data from a signed-in task.
  if ((ports.signedIn ?? conversationSignedIn)(bot.botId) !== false) {
    return { ok: false, code: 'surface', message: signedInRefusal('record a verdict', bot.botId) };
  }
  let profile: BotProfile | null;
  try {
    profile = ports.profile(bot.botId);
  } catch {
    profile = null;
  }
  if (!profile || !profile.enabled || profile.workspaceId !== bot.workspaceId) {
    return { ok: false, code: 'not-attributed', message: 'this bot is not running in the factory' };
  }
  const repoPath = profile.repo?.repoPath ?? '';
  const repoKey = repoPath ? await deps.repoKeyOf(repoPath).catch(() => null) : null;
  if (!repoKey) return { ok: false, code: 'no-repo', message: 'this bot has no GitHub repository wmux can read' };
  let facts: PrLaneFacts;
  try {
    facts = await deps.readPr(repoPath, repoKey, input.prNumber);
  } catch {
    return { ok: false, code: 'pr-read-failed', message: 'the pull request could not be read' };
  }
  if (facts.number !== input.prNumber) return { ok: false, code: 'pr-read-failed', message: 'GitHub answered for another pull request' };
  let row: LedgerEntry | null;
  try {
    row = 'taskId' in evidence ? ports.ledgerRow(evidence.taskId) : null;
  } catch {
    row = null;
  }
  // The reads above awaited: the bot must still be enabled, in this
  // workspace, on the same repository before anything is written.
  const unchanged = (): boolean => {
    let now: BotProfile | null;
    try {
      now = ports.profile(bot.botId);
    } catch {
      now = null;
    }
    return !!now && now.enabled && now.workspaceId === bot.workspaceId && now.repo?.repoPath === repoPath;
  };
  if (facts.headRefOid !== input.headSha) {
    // The head moved past the one this bot's verify task checked out: that
    // task's grading is over (a new head is verified by a new task), so it
    // is closed rather than left open with no verdict to come.
    if (row && isBotVerifyTask(row, bot.botId) && row.dispatch?.checkout?.sha === input.headSha && unchanged()) {
      await ports.closeVerifyTask?.(row.id, bot.botId, `PR head moved past ${input.headSha.slice(0, 7)}; no verdict recorded`).catch(() => false);
    }
    return { ok: false, code: 'head-mismatch', message: 'the pull request has another head than headSha; verify the current head' };
  }
  if ('reading' in evidence) {
    // The PR's own base, resolved once: the gate is read at that commit and
    // the evidence names it.
    const baseRef = `origin/${facts.baseRefName}`;
    const fullRef = originBranchRef(facts.baseRefName);
    const baseSha = fullRef ? await deps.git(['rev-parse', '--verify', '--quiet', `${fullRef}^{commit}`], repoPath).catch(() => null) : null;
    if (!baseSha || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(baseSha)) {
      return { ok: false, code: 'gate-required', message: `${baseRef} is not in the repository, so its gate cannot be read: start a verify worker at the head` };
    }
    // The local copy may lag the forge: a gate added on the base since the
    // last fetch would go unread.
    if (!facts.baseRefOid || baseSha !== facts.baseRefOid) {
      return { ok: false, code: 'gate-required', message: `${baseRef} in the repository is not the base tip the pull request reports (${(facts.baseRefOid ?? 'unknown').slice(0, 12)}), so its gate cannot be read: start a verify worker at the head` };
    }
    let gate: BaseGate;
    try {
      gate = await (ports.baseGate ?? repoBaseGate)(repoPath, baseSha);
    } catch (err) {
      gate = { kind: 'unknown', detail: err instanceof Error ? err.message : String(err) };
    }
    if (gate.kind !== 'none') return { ok: false, code: 'gate-required', message: gateRequiredMessage(gate, baseRef) };
    const basis: PrVerdictReadingBasis = 'no-gate';
    const reading: PrVerdictRecord = {
      version: 2,
      repoKey,
      prNumber: input.prNumber,
      headSha: input.headSha,
      verdict: input.verdict,
      principal: { workspaceId: bot.workspaceId, botId: bot.botId, agent: BOT_VERDICT_AGENT },
      evidence: { taskId: READING_EVIDENCE_TASK_ID, gateHeadSha: input.headSha, reading: basis, baseRef, baseSha },
      summary: input.summary,
      at: (deps.now ?? Date.now)(),
    };
    if (!unchanged()) {
      return { ok: false, code: 'not-attributed', message: 'this bot changed while the verdict was being checked' };
    }
    // The lane's own check, on the same read: what is recorded can count.
    const readingWhy = verdictEvidenceCheck(reading, new Map(), facts);
    if (readingWhy !== null) {
      return { ok: false, code: readingWhy === 'verdict-no-evidence' ? 'evidence-missing' : readingWhy, message: 'the merge lane would not count this reading-only verdict' };
    }
    return saveBotVerdict(reading, guestRefusal, deps);
  }
  if (!row) return { ok: false, code: 'evidence-missing', message: `no task ${evidence.taskId} in the task ledger` };
  const record: PrVerdictRecord = {
    version: 2,
    repoKey,
    prNumber: input.prNumber,
    headSha: input.headSha,
    verdict: input.verdict,
    principal: { workspaceId: bot.workspaceId, botId: bot.botId, agent: BOT_VERDICT_AGENT },
    evidence: { taskId: evidence.taskId, gateHeadSha: row.gate?.headSha ?? '' },
    summary: input.summary,
    at: (deps.now ?? Date.now)(),
  };
  if (!unchanged()) {
    return { ok: false, code: 'not-attributed', message: 'this bot changed while the verdict was being checked' };
  }
  const why = verdictEvidenceCheck(record, new Map([[row.id, laneEvidenceRowOf(row)]]));
  // A FAIL may rest on a red gate; anything else the lane would not count is refused.
  if (why !== null && !(why === 'gate-failed' && input.verdict === 'fail')) {
    const message = why === 'gate-failed'
      ? 'the recorded gate at headSha failed; that is a fail verdict'
      : why === 'gate-skipped'
        ? 'the recorded gate at headSha was a skip, which proves nothing'
        : 'the task is not this bot\'s verify task on a detached checkout of headSha with a system gate run at headSha';
    return { ok: false, code: why === 'verdict-no-evidence' ? 'evidence-missing' : why, message };
  }
  return saveBotVerdict(record, guestRefusal, deps);
}

/** The bot path's write: the guest check judged again after the reads, in
 *  the tick that writes, then the record. */
async function saveBotVerdict(record: PrVerdictRecord, guestRefusal: () => PrVerdictResult | null, deps: VerifyRpcDeps): Promise<PrVerdictResult> {
  const refusedLate = guestRefusal();
  if (refusedLate) return refusedLate;
  try {
    await deps.record(record);
  } catch {
    return { ok: false, code: 'store-error', message: 'the verdict could not be saved' };
  }
  return { ok: true, record };
}

export function registerVerifyRpc(router: RpcRouter, deps: VerifyRpcDeps): void {
  router.register(PR_VERDICT_RPC, async (params, ctx?: RpcContext): Promise<PrVerdictResult> => {
    if (ctx?.bot) return recordBotVerdict(params, ctx.bot, deps);
    const who = await resolvePaneCaller(deps, params, ctx);
    if (!who) return { ok: false, code: 'not-attributed', message: 'wmux could not tie this call to your pane' };
    const parsed = parsePrVerdictInput(bodyOf(params));
    if (!parsed.ok) return { ok: false, code: 'invalid', message: `${parsed.field ? `${parsed.field}: ` : ''}${parsed.message}` };
    const input = parsed.value;
    const cwd = who.cwd;
    const repoKey = cwd ? await deps.repoKeyOf(cwd).catch(() => null) : null;
    if (!repoKey) return { ok: false, code: 'no-repo', message: 'your working directory is not in a GitHub repository wmux can read' };
    let facts: PrLaneFacts;
    try {
      facts = await deps.readPr(cwd, repoKey, input.prNumber);
    } catch {
      return { ok: false, code: 'pr-read-failed', message: 'the pull request could not be read' };
    }
    if (facts.number !== input.prNumber) return { ok: false, code: 'pr-read-failed', message: 'GitHub answered for another pull request' };
    if (facts.headRefOid !== input.headSha) return { ok: false, code: 'head-mismatch', message: 'the pull request has another head than headSha; verify the current head' };
    const checkedOut = await deps.git(['rev-parse', 'HEAD'], cwd);
    if (checkedOut !== input.headSha) return { ok: false, code: 'checkout-mismatch', message: 'your working directory does not have headSha checked out' };
    const branch = await deps.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (branch === null) return { ok: false, code: 'checkout-mismatch', message: 'the branch of your working directory could not be read' };
    if (facts.headRefName && branch === facts.headRefName) {
      return { ok: false, code: 'on-pr-branch', message: 'verify from a separate checkout of headSha (detached), not the PR branch' };
    }
    const record: PrVerdictRecord = {
      version: 1,
      repoKey,
      prNumber: input.prNumber,
      headSha: input.headSha,
      verdict: input.verdict,
      principal: { workspaceId: who.asker.workspaceId, ptyId: who.asker.ptyId, agent: who.asker.agent },
      summary: input.summary,
      at: (deps.now ?? Date.now)(),
    };
    try {
      await deps.record(record);
    } catch {
      return { ok: false, code: 'store-error', message: 'the verdict could not be saved' };
    }
    return { ok: true, record };
  });
}
