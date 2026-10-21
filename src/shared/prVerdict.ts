// ─── pr_verdict — a verifier's PASS/FAIL on one PR head ──────────────────────
//
// An agent that verified a pull request records what it found, pinned to the
// exact head it checked out:
//
//   pr_verdict {prNumber, headSha, verdict, summary}  → { ok, record } | refusal
//
// Main stamps the principal (pane, workspace, agent) from the verified pipe
// identity of the calling pane and derives the repo from that pane's cwd;
// nothing in the input names either. Before recording, main re-reads the PR
// head and checks that the verifier's cwd has exactly `headSha` checked out,
// not on the PR's own branch.
//
// Order contract: verify → pr_verdict → then moa_ask for the merge. The merge
// lane (main/deck/moaMergeLane.ts, `verifier-pass-at-head`) reads the verdicts
// when the merge is decided and again before every merge try; a verdict
// recorded after a merge question was escalated does not re-open it.
//
// Everything a caller sends is untrusted text; main validates it with
// parsePrVerdictInput below.

/** MCP tool name. */
export const PR_VERDICT_TOOL = 'pr_verdict';
/** Pipe RPC method behind the tool. */
export const PR_VERDICT_RPC = 'verify.recordVerdict';

export const PR_VERDICT_SUMMARY_MAX = 500;
/** Verdicts for a head with no FAIL and no record newer than this are pruned
 *  on write. */
export const PR_VERDICT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const COMMIT_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const PR_NUMBER_MAX = 99_999_999;

export type PrVerdictKind = 'pass' | 'fail';

/** Bound on `principal.botId` and `evidence.taskId`. */
export const PR_VERDICT_ID_MAX = 200;

/** Who recorded a verdict. A pane verifier is `workspaceId` + `ptyId`; a bot
 *  verifier is `workspaceId` + `botId` and may have no pane (a v2 record
 *  carries at least one of the two). */
export interface PrVerdictPrincipal {
  workspaceId: string;
  /** Absent only on a v2 record from a bot. */
  ptyId?: string;
  botId?: string;
  agent: string;
}

/** What a v2 verdict rests on: the verify task whose system-recorded gate ran
 *  at the head. The merge lane resolves `taskId` to its ledger row and checks
 *  the row, never this claim alone.
 *
 *  A reading-only verdict (`reading` set) rests on no task: the bot read the
 *  change itself and main found, when it recorded the verdict, that no gate
 *  grades it — every changed file is docs or content (`docs-only`, which the
 *  merge lane checks again on its own read of the PR), or the repository
 *  declares no gate on its base (`no-gate`). Its `taskId` is
 *  READING_EVIDENCE_TASK_ID, which names no ledger row, so a build that does
 *  not know `reading` still reads the record and never counts it. */
export interface PrVerdictEvidence {
  taskId: string;
  gateHeadSha: string;
  reading?: PrVerdictReadingBasis;
}

export type PrVerdictReadingBasis = 'docs-only' | 'no-gate';

/** The `taskId` of a reading-only verdict's evidence. */
export const READING_EVIDENCE_TASK_ID = 'reading-only';

/**
 * One verdict. v1 records (pane verifiers, before bots) are still read; a v2
 * record may carry a bot principal and evidence. The store holds both and
 * reads them as one shape: a v1 record is a v2 record without `botId` and
 * `evidence`.
 */
export interface PrVerdictRecord {
  version: 1 | 2;
  repoKey: string;
  prNumber: number;
  headSha: string;
  verdict: PrVerdictKind;
  principal: PrVerdictPrincipal;
  /** v2 only. */
  evidence?: PrVerdictEvidence;
  summary: string;
  at: number;
}

export interface PrVerdictInput {
  prNumber: number;
  headSha: string;
  verdict: PrVerdictKind;
  summary: string;
}

export type PrVerdictRefusalCode =
  /** The input failed parsePrVerdictInput (nothing was recorded). */
  | 'invalid'
  /** The calling pane has no verified identity. */
  | 'not-attributed'
  /** The pane's cwd is not in a GitHub repository wmux can read. */
  | 'no-repo'
  /** The pull request could not be read. */
  | 'pr-read-failed'
  /** The pull request's head is not `headSha`. */
  | 'head-mismatch'
  /** The verifier's cwd does not have `headSha` checked out. */
  | 'checkout-mismatch'
  /** The verifier's cwd is on the pull request's own branch. */
  | 'on-pr-branch'
  /** The verdict store could not be read or written. */
  | 'store-error'
  /** A bot caller whose role records no verdicts (only the verifier does),
   *  or whose wake is not known clean of a guest's words. */
  | 'surface'
  /** A bot verdict without `evidence: {taskId}` naming a task in the ledger. */
  | 'evidence-missing'
  /** The evidence task is not the bot's verify task on a detached checkout
   *  of headSha with a system gate run at headSha (the lane's reason). */
  | 'evidence-mismatch'
  /** The evidence gate was a recorded skip (the lane's reason). */
  | 'gate-skipped'
  /** A PASS whose evidence gate failed (the lane's reason). */
  | 'gate-failed'
  /** A reading-only verdict on a change a gate grades: it touches more than
   *  docs and content, and the repository declares a gate (or wmux cannot
   *  tell whether it does). Start a verify worker. */
  | 'gate-required';

export type PrVerdictResult =
  | { ok: true; record: PrVerdictRecord }
  | { ok: false; code: PrVerdictRefusalCode; message: string };

export type PrVerdictParse<T> = { ok: true; value: T } | { ok: false; field: string; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPrNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= PR_NUMBER_MAX;
const bad = (field: string, message: string) => ({ ok: false as const, field, message });

/** Validate a `pr_verdict` input; unknown keys are rejected. Pure. */
export function parsePrVerdictInput(raw: unknown): PrVerdictParse<PrVerdictInput> {
  if (!isRecord(raw)) return bad('', 'must be an object');
  for (const k of Object.keys(raw)) if (!['prNumber', 'headSha', 'verdict', 'summary'].includes(k)) return bad(k, 'unknown field');
  if (!isPrNumber(raw.prNumber)) return bad('prNumber', 'must be a positive integer');
  if (typeof raw.headSha !== 'string' || !COMMIT_SHA_RE.test(raw.headSha)) return bad('headSha', 'must be a full lowercase commit SHA');
  if (raw.verdict !== 'pass' && raw.verdict !== 'fail') return bad('verdict', 'must be "pass" or "fail"');
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) return bad('summary', 'must be a non-empty string');
  if (summary.length > PR_VERDICT_SUMMARY_MAX) return bad('summary', `at most ${PR_VERDICT_SUMMARY_MAX} characters`);
  return { ok: true, value: { prNumber: raw.prNumber, headSha: raw.headSha, verdict: raw.verdict, summary } };
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= PR_VERDICT_ID_MAX;

/** A stored record's shape check, v1 or v2 (strict: one bad record refuses
 *  the file). */
export function isPrVerdictRecord(v: unknown): v is PrVerdictRecord {
  if (!isRecord(v) || !isRecord(v.principal)) return false;
  const p = v.principal;
  const principalOk = v.version === 1
    ? typeof p.ptyId === 'string' && p.ptyId.length > 0 && p.botId === undefined && v.evidence === undefined
    : v.version === 2
      && (p.ptyId === undefined || (typeof p.ptyId === 'string' && p.ptyId.length > 0))
      && (p.botId === undefined || isId(p.botId))
      && (p.ptyId !== undefined || p.botId !== undefined)
      && (v.evidence === undefined || (isRecord(v.evidence)
        && isId(v.evidence.taskId)
        && typeof v.evidence.gateHeadSha === 'string' && COMMIT_SHA_RE.test(v.evidence.gateHeadSha)
        && (v.evidence.reading === undefined || v.evidence.reading === 'docs-only' || v.evidence.reading === 'no-gate')));
  return principalOk
    && typeof v.repoKey === 'string' && v.repoKey.length > 0
    && isPrNumber(v.prNumber)
    && typeof v.headSha === 'string' && COMMIT_SHA_RE.test(v.headSha)
    && (v.verdict === 'pass' || v.verdict === 'fail')
    && typeof p.workspaceId === 'string' && p.workspaceId.length > 0
    && typeof p.agent === 'string'
    && typeof v.summary === 'string' && v.summary.length <= PR_VERDICT_SUMMARY_MAX
    && typeof v.at === 'number' && Number.isSafeInteger(v.at);
}
