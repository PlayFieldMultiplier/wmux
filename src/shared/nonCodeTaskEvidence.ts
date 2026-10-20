// ─── Completion criteria + evidence for research / no-changes tasks ────────
//
// Code tasks are graded by main's system gate (taskGate.ts). Research and
// no-commit tasks skip that gate, so without a separate record they finish
// looking "done" with nothing to show. Criteria are set only at dispatch by
// main (a worker cannot rewrite them). Evidence is attached on the report
// (ledger_update) and graded with the shared completionEvidence contract:
// verifiedItemCount is a grade, never a laundry of run-success. Missing or
// empty evidence is "Not verified" — never claimed verified.

import {
  normalizeCompletionEvidenceWire,
  validateCompletionEvidence,
  type EvidenceVerdict,
} from './completionEvidence';
import type { CompletionEvidence } from './types';

export const TASK_CRITERIA_MAX = 8;
export const TASK_CRITERION_MAX_CHARS = 200;

/** Default research criteria (English). Main stamps these at dispatch when
 *  the brain did not name its own; the worker cannot change them. */
export const DEFAULT_RESEARCH_CRITERIA: readonly string[] = [
  'The findings answer the question',
  'Each finding cites a source URL',
  'The summary states what the findings mean for the question',
];

/** Sanitize criteria for LedgerDispatch: trim, drop empties, cap count/length.
 *  Pure. Never invents criteria. */
export function sanitizeTaskCriteria(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const s = item.replace(/\s+/g, ' ').trim().slice(0, TASK_CRITERION_MAX_CHARS);
    if (!s) continue;
    out.push(s);
    if (out.length >= TASK_CRITERIA_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Grade attached evidence for a completed non-code task. Missing / malformed
 *  / empty → verifiedItemCount 0 (Not verified). Pure. */
export function gradeNonCodeEvidence(raw: unknown): {
  evidence: CompletionEvidence | undefined;
  verifiedItemCount: number;
  verdict: EvidenceVerdict;
} {
  const evidence = normalizeCompletionEvidenceWire(raw) ?? undefined;
  const verdict = validateCompletionEvidence('completed', evidence);
  if (!verdict.ok) {
    return { evidence, verifiedItemCount: 0, verdict };
  }
  return { evidence, verifiedItemCount: verdict.verifiedItemCount, verdict };
}

/** Owner-facing verification label code for i18n. Pure. */
export function nonCodeVerificationState(
  verifiedItemCount: number | undefined,
  totalItems: number | undefined,
): 'missing' | 'unverified' | 'partial' | 'verified' {
  if (verifiedItemCount === undefined || totalItems === undefined || totalItems <= 0) return 'missing';
  if (verifiedItemCount <= 0) return 'unverified';
  if (verifiedItemCount >= totalItems) return 'verified';
  return 'partial';
}
