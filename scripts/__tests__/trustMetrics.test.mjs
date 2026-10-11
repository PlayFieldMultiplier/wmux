// Revert detection and 1-week survival for the trust metrics (scripts/lib/trust-metrics.mjs).
import { describe, expect, it } from 'vitest';
import { analyze, DAY_MS, parseGitLog } from '../lib/trust-metrics.mjs';

const NOW = Date.parse('2026-10-12T00:00:00Z');
const day = (n) => NOW - n * DAY_MS;
const sha = (c) => c.repeat(40);

/** Builds `git log --format=GIT_LOG_FORMAT` output, newest first like git prints it. */
function log(commits) {
  return [...commits]
    .sort((a, b) => b.at - a.at)
    .map((c) => `${c.sha}\x00${Math.floor(c.at / 1000)}\x00${c.subject}\x00${c.body ?? ''}\x1e`)
    .join('\n');
}

describe('analyze', () => {
  it('follows reverts, revert-of-revert re-applies, and merge commits', () => {
    const commits = parseGitLog(
      log([
        { sha: sha('a'), at: day(20), subject: 'feat: kept (#10)' },
        { sha: sha('b'), at: day(19), subject: 'fix: undone in a day (#11)' },
        // A revert PR squash: the body names the reverted commit.
        { sha: sha('c'), at: day(18), subject: 'Revert "fix: undone in a day (#11)" (#12)', body: `This reverts commit ${sha('b')}.` },
        { sha: sha('d'), at: day(15), subject: 'Merge pull request #13 from fork/branch' },
        // Body edited away: the quoted subject's (#13) is the fallback.
        { sha: sha('e'), at: day(14), subject: 'Revert "Merge pull request #13 from fork/branch"' },
        { sha: sha('f'), at: day(13), subject: 'feat: reverted after a week (#14)' },
        { sha: sha('9'), at: day(4), subject: 'Revert "feat: reverted after a week (#14)" (#15)', body: `This reverts commit ${sha('f')}.` },
        // Reverting the revert re-applies #14.
        { sha: sha('8'), at: day(3), subject: 'Reapply "feat: reverted after a week (#14)" (#16)', body: `This reverts commit ${sha('9')}.` },
        { sha: sha('7'), at: day(2), subject: 'feat: too recent for survival (#17)' },
      ]),
    );
    const r = analyze(commits, { since: day(30), now: NOW });
    expect(r.totals).toMatchObject({ merged: 5, revertPrs: 3, reverted: 3, eligible7d: 4, survived7d: 2 });
    expect(r.totals.revertRate).toBeCloseTo(3 / 5);
    expect(r.reverted.map((p) => [p.pr, p.inMainNow])).toEqual([[11, false], [13, false], [14, true]]);
    // Median of 1d, 1d and 9d.
    expect(r.totals.medianTimeToRevertHours).toBe(24);
  });

  it('counts survival at day 7 and leaves PRs before the window out', () => {
    const commits = parseGitLog(
      log([
        { sha: sha('1'), at: day(40), subject: 'feat: before the window (#1)' },
        { sha: sha('2'), at: day(10), subject: 'feat: lives (#2)' },
        { sha: sha('3'), at: day(9), subject: 'feat: dies on day 2 (#3)' },
        { sha: sha('4'), at: day(7), subject: 'Revert "feat: dies on day 2 (#3)"', body: `This reverts commit ${sha('3').slice(0, 12)}.` },
        { sha: sha('5'), at: day(12), subject: 'feat: reverted and re-applied in one second (#5)' },
      ]).concat(
        // Same second: git prints the re-apply (newer on main) before the revert.
        '\n',
        log([{ sha: sha('0'), at: day(10), subject: 'Reapply "feat: x (#5)"', body: `This reverts commit ${sha('6')}.` }]),
        '\n',
        log([{ sha: sha('6'), at: day(10), subject: 'Revert "feat: x (#5)"', body: `This reverts commit ${sha('5')}.` }]),
      ),
    );
    const r = analyze(commits, { since: day(30), now: NOW });
    expect(r.totals).toMatchObject({ merged: 3, revertPrs: 0, eligible7d: 3, survived7d: 2 });
    expect(r.reverted.find((p) => p.pr === 5)?.inMainNow).toBe(true);
  });
});
