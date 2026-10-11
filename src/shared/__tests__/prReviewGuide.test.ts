import { describe, it, expect } from 'vitest';
import { REVIEW_GUIDE_MARKER, formatReviewGuide, gateLine, hasReviewGuideMarker, type ReviewGuide } from '../prReviewGuide';

const guide = (gate: ReviewGuide['gate']): ReviewGuide => ({
  steps: [
    { target: 'criteria', items: ['(1) tests pass'] },
    { target: 'evidence', items: ['(1) `out/test.log` (sha256 abc)'] },
    { target: 'files', items: [] },
  ],
  gate,
  headSha: 'f'.repeat(40),
});

describe('review order guide (PR body)', () => {
  it('reads as a plain-language ordered list on GitHub, code last and optional', () => {
    const md = formatReviewGuide(guide('passed'));
    expect(md.startsWith(REVIEW_GUIDE_MARKER)).toBe(true);
    expect(md).toContain('1. **What you asked for**');
    expect(md).toContain('   - (1) tests pass');
    expect(md).toContain(`   - Passed: project checks on version \`${'f'.repeat(12)}\``);
    expect(md).toContain('3. **Code changes (optional)**');
  });

  it('never says Passed when no gate result was recorded', () => {
    const md = formatReviewGuide(guide('missing'));
    expect(md).not.toContain('Passed');
    expect(md).toContain('Not verified');
    expect(gateLine('failed', 'a'.repeat(40))).toMatch(/^Failed/);
  });

  it('detects the marker only to warn', () => {
    expect(hasReviewGuideMarker(`x\n${REVIEW_GUIDE_MARKER}`)).toBe(true);
    expect(hasReviewGuideMarker('### Review order')).toBe(false);
    expect(hasReviewGuideMarker(undefined)).toBe(false);
  });
});
