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

/** Who recorded a verdict. The comparison unit is `workspaceId` for now. */
export interface PrVerdictPrincipal {
  workspaceId: string;
  ptyId: string;
  agent: string;
}

export interface PrVerdictRecord {
  version: 1;
  repoKey: string;
  prNumber: number;
  headSha: string;
  verdict: PrVerdictKind;
  principal: PrVerdictPrincipal;
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
  | 'store-error';

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

/** A stored record's shape check (strict: one bad record refuses the file). */
export function isPrVerdictRecord(v: unknown): v is PrVerdictRecord {
  if (!isRecord(v) || !isRecord(v.principal)) return false;
  const p = v.principal;
  return v.version === 1
    && typeof v.repoKey === 'string' && v.repoKey.length > 0
    && isPrNumber(v.prNumber)
    && typeof v.headSha === 'string' && COMMIT_SHA_RE.test(v.headSha)
    && (v.verdict === 'pass' || v.verdict === 'fail')
    && typeof p.workspaceId === 'string' && p.workspaceId.length > 0
    && typeof p.ptyId === 'string' && p.ptyId.length > 0
    && typeof p.agent === 'string'
    && typeof v.summary === 'string' && v.summary.length <= PR_VERDICT_SUMMARY_MAX
    && typeof v.at === 'number' && Number.isSafeInteger(v.at);
}
