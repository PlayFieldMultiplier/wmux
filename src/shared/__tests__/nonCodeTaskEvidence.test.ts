import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESEARCH_CRITERIA,
  gradeNonCodeEvidence,
  nonCodeVerificationState,
  sanitizeTaskCriteria,
} from '../nonCodeTaskEvidence';

describe('sanitizeTaskCriteria', () => {
  it('trims, drops empties, caps count and length', () => {
    expect(sanitizeTaskCriteria(['  a  ', '', 'b', 1, 'x'.repeat(300)])).toEqual(['a', 'b', 'x'.repeat(200)]);
    expect(sanitizeTaskCriteria([])).toBeUndefined();
    expect(sanitizeTaskCriteria(null)).toBeUndefined();
  });

  it('default research criteria are non-empty', () => {
    expect(DEFAULT_RESEARCH_CRITERIA.length).toBeGreaterThan(0);
  });
});

describe('gradeNonCodeEvidence', () => {
  it('missing evidence is Not verified (0)', () => {
    expect(gradeNonCodeEvidence(undefined).verifiedItemCount).toBe(0);
    expect(gradeNonCodeEvidence({}).verifiedItemCount).toBe(0);
  });

  it('grades a verified inspection item', () => {
    const r = gradeNonCodeEvidence({
      summary: 'Answered with sources',
      items: [{ kind: 'inspection', status: 'verified', summary: 'Source A supports the claim', location: 'https://example.com' }],
    });
    expect(r.verifiedItemCount).toBe(1);
    expect(r.evidence?.items).toHaveLength(1);
  });

  it('unverified items do not raise the grade', () => {
    const r = gradeNonCodeEvidence({
      summary: 'Draft notes',
      items: [{ kind: 'inspection', status: 'unverified', summary: 'Maybe relevant' }],
    });
    expect(r.verifiedItemCount).toBe(0);
  });
});

describe('nonCodeVerificationState', () => {
  it('maps counts to owner-facing states', () => {
    expect(nonCodeVerificationState(undefined, undefined)).toBe('missing');
    expect(nonCodeVerificationState(0, 0)).toBe('missing');
    expect(nonCodeVerificationState(0, 2)).toBe('unverified');
    expect(nonCodeVerificationState(1, 2)).toBe('partial');
    expect(nonCodeVerificationState(2, 2)).toBe('verified');
  });
});

// Integration-shaped: grading used the same way taskGate stamps a research settle.
describe('research settle grade (taskGate contract)', () => {
  it('a report with no evidence is Not verified; one with verified items is not', () => {
    const missing = gradeNonCodeEvidence(undefined);
    expect(nonCodeVerificationState(missing.verifiedItemCount, missing.evidence?.items?.length ?? 0)).toBe('missing');
    const ok = gradeNonCodeEvidence({
      summary: 'Findings',
      items: [
        { kind: 'inspection', status: 'verified', summary: 'Source A', location: 'https://a.example' },
        { kind: 'inspection', status: 'verified', summary: 'Source B', location: 'https://b.example' },
      ],
    });
    expect(ok.verifiedItemCount).toBe(2);
    expect(nonCodeVerificationState(ok.verifiedItemCount, ok.evidence!.items!.length)).toBe('verified');
  });
});
