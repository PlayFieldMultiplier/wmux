// The detection-fix rule and dates for the lead-time baseline (scripts/lib/detection-fixes.mjs).
//
// The count is only a baseline if the rule stays put: these pin which real
// CHANGELOG titles it takes and which look-alikes it leaves out.
import { describe, expect, it } from 'vitest';
import { daysBetween, entryDates, isDetectionFix, parseChangelog, percentile, refsOf } from '../lib/detection-fixes.mjs';

describe('parseChangelog', () => {
  it('reads releases with their Fixed entries, titles and refs', () => {
    const text = [
      '## [Unreleased]',
      '',
      '## [4.2.0] — 2026-10-08',
      '',
      '### Added',
      '',
      '- **Not a fix.** (#1)',
      '',
      '### Fixed',
      '',
      '- **A pane no longer reads Running.** Body text',
      '  over two lines (#1938, #12).',
      '- An older entry without a bold claim. It cites #935.',
      '',
      '## [2.6.0] — 2026-04-17 — Stability',
      '',
      '### Fixed ',
      '',
      '- **Trailing-space heading.**',
    ].join('\n');
    const [r1, r2] = parseChangelog(text);
    expect(r1.version).toBe('4.2.0');
    expect(r1.date).toBe('2026-10-08');
    expect(r1.fixed.map((f) => f.title)).toEqual(['A pane no longer reads Running.', 'An older entry without a bold claim.']);
    expect(r1.fixed[0].refs).toEqual([1938, 12]);
    expect(r1.fixed[1].refs).toEqual([935]);
    expect(r2).toMatchObject({ version: '2.6.0', date: '2026-04-17' });
    expect(r2.fixed).toHaveLength(1);
  });

  it('collects each cited number once', () => {
    expect(refsOf('(#1392) and again #1392, plus #77')).toEqual([1392, 77]);
  });
});

describe('isDetectionFix', () => {
  it('takes titles about an agent state shown on screen', () => {
    for (const t of [
      'A Copilot permission prompt cancelled with Esc no longer leaves the pane "waiting on you".',
      'Fleet no longer shows a finished turn as Running.',
      'An interrupted Claude or Codex turn now reads as idle in chat.',
      '"Needs you" clears as soon as you answer an agent\'s question.',
      'Claude Code panes are detected again.',
      'The workspace dot no longer reads green while an agent is blocked.',
    ]) expect(isDetectionFix(t), t).toBe(true);
  });

  it('leaves out the same words used for something else', () => {
    for (const t of [
      'A WSL pane no longer gets stuck after a restart because of a garbled working directory.',
      'Long-running fullscreen apps keep scrolling after a pane reattaches.',
      'Busy agents get one reminder about waiting A2A tasks.',
      'A pane no longer goes dead while the shell inside it keeps running.',
      "Moa's chat shows its replies, not its working.",
      'The sidebar git sync badge works in repos with many submodules.',
      'Orchestrator mode stays smooth even while it observes a busy fleet.',
    ]) expect(isDetectionFix(t), t).toBe(false);
  });
});

describe('entryDates', () => {
  const items = new Map([
    [10, { type: 'Issue', createdAt: '2026-10-01T00:00:00Z', closedBy: [{ mergedAt: '2026-10-02T00:00:00Z' }] }],
    [20, { type: 'PullRequest', createdAt: '2026-10-01T12:00:00Z', mergedAt: '2026-10-03T00:00:00Z', closes: [{ createdAt: '2026-09-30T00:00:00Z' }] }],
  ]);

  it('takes the earliest report and the latest merge across issues and PRs', () => {
    expect(entryDates([10, 20], items)).toEqual({
      reportedAt: '2026-09-30T00:00:00Z',
      openedAt: '2026-10-01T12:00:00Z',
      mergedAt: '2026-10-03T00:00:00Z',
    });
  });

  it('gives an issue-only entry the merge of the PR that closed it', () => {
    expect(entryDates([10], items).mergedAt).toBe('2026-10-02T00:00:00Z');
  });

  it('measures days and nearest-rank percentiles', () => {
    expect(daysBetween('2026-10-01T00:00:00Z', '2026-10-02T12:00:00Z')).toBe(1.5);
    expect(daysBetween(null, '2026-10-02T00:00:00Z')).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
  });
});
