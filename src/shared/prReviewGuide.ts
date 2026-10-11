// Review order guide: a short, ordered list of where a reviewer should look in
// a Moa evidence PR — what was asked, the proof it works, then (optionally)
// the code. Moa writes it into the PR body for GitHub readers
// (main/deck/moaGoalDelivery.ts). The Git page never trusts that text: it
// rebuilds the guide from the local Moa delivery record, and only for a PR
// whose author is this computer's gh account and that is not from a fork
// (main/github/GhPrService.ts). Any other PR is shown without a stepper.

/** Where a step sends the reviewer on the Git page. */
export type ReviewGuideTarget = 'criteria' | 'evidence' | 'files';

export interface ReviewGuideStep {
  readonly target: ReviewGuideTarget;
  /** The things to look at: criteria, evidence files, the gate command. */
  readonly items: readonly string[];
}

/** The project gate's result on the delivered commit; 'missing' = no result
 *  was recorded, so nothing is claimed. */
export type ReviewGuideGate = 'passed' | 'failed' | 'missing';

export interface ReviewGuide {
  readonly steps: readonly ReviewGuideStep[];
  readonly gate: ReviewGuideGate;
  /** The commit Moa verified and delivered. */
  readonly headSha: string;
}

/** Marks the guide section in a PR body (for GitHub readers only; never a
 *  trust signal). */
export const REVIEW_GUIDE_MARKER = '<!-- wmux:review-guide v1 -->';

const TITLE: Record<ReviewGuideTarget, string> = {
  criteria: 'What you asked for',
  evidence: 'Proof it works',
  files: 'Code changes (optional)',
};
const HINT: Record<ReviewGuideTarget, string> = {
  criteria: 'Does this list match what you wanted?',
  evidence: 'Each item is a check that ran on this exact version.',
  files: 'For anyone who wants to read the code. Not needed to approve.',
};

export function gateLine(gate: ReviewGuideGate, headSha: string): string {
  const v = `\`${headSha.slice(0, 12)}\``;
  if (gate === 'passed') return `Passed: project checks on version ${v}`;
  if (gate === 'failed') return `Failed: project checks on version ${v}`;
  return `Not verified: no project check result was recorded for version ${v}`;
}

/** The markdown section for the PR body, marker first. */
export function formatReviewGuide(guide: ReviewGuide): string {
  const out = [REVIEW_GUIDE_MARKER, '### Review order'];
  guide.steps.forEach((s, i) => {
    out.push(`${i + 1}. **${TITLE[s.target]}** — ${HINT[s.target]}`);
    for (const item of s.items) out.push(`   - ${item.replace(/\s+/g, ' ').trim()}`);
    if (s.target === 'evidence') out.push(`   - ${gateLine(guide.gate, guide.headSha)}`);
  });
  return out.join('\n');
}

/** Whether a body carries a guide section — only to warn that an
 *  unverified PR claims one. */
export function hasReviewGuideMarker(body: string | null | undefined): boolean {
  return !!body && body.includes(REVIEW_GUIDE_MARKER);
}
