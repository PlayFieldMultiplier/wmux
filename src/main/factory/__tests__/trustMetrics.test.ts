// The main-process trust metrics give the CLI's numbers on the same log
// (scripts/lib/trust-metrics.mjs is the reference), and a shallow clone that
// starts inside the window is refused.
import { describe, expect, it } from 'vitest';
import * as cli from '../../../../scripts/lib/trust-metrics.mjs';
import { analyze, DAY_MS, GIT_LOG_FORMAT, parseGitLog, readTrustMetrics, type TrustGit } from '../trustMetrics';

const NOW = Date.parse('2026-10-12T00:00:00Z');
const day = (n: number) => NOW - n * DAY_MS;
const sha = (c: string) => c.repeat(40);

interface C { sha: string; at: number; subject: string; body?: string }

function log(commits: C[]): string {
  return [...commits]
    .sort((a, b) => b.at - a.at)
    .map((c) => `${c.sha}\x00${Math.floor(c.at / 1000)}\x00${c.subject}\x00${c.body ?? ''}\x1e`)
    .join('\n');
}

const FIXTURE = log([
  { sha: sha('a'), at: day(20), subject: 'feat: kept (#10)' },
  { sha: sha('b'), at: day(19), subject: 'fix: undone in a day (#11)' },
  { sha: sha('c'), at: day(18), subject: 'Revert "fix: undone in a day (#11)" (#12)', body: `This reverts commit ${sha('b')}.` },
  { sha: sha('d'), at: day(15), subject: 'Merge pull request #13 from fork/branch' },
  { sha: sha('e'), at: day(14), subject: 'Revert "Merge pull request #13 from fork/branch"' },
  { sha: sha('f'), at: day(13), subject: 'feat: reverted after a week (#14)' },
  { sha: sha('9'), at: day(4), subject: 'Revert "feat: reverted after a week (#14)" (#15)', body: `This reverts commit ${sha('f')}.` },
  { sha: sha('8'), at: day(3), subject: 'Reapply "feat: reverted after a week (#14)" (#16)', body: `This reverts commit ${sha('9')}.` },
  { sha: sha('7'), at: day(2), subject: 'feat: too recent for survival (#17)' },
  { sha: sha('6'), at: day(40), subject: 'feat: before the window (#1)' },
  { sha: sha('5'), at: day(9), subject: 'chore: a direct push with no PR' },
  { sha: sha('4'), at: day(8), subject: 'Revert "chore: a direct push with no PR"', body: `This reverts commit ${sha('5').slice(0, 12)}.` },
]);

describe('trustMetrics (port of scripts/lib/trust-metrics.mjs)', () => {
  it('matches the CLI library on the same log', () => {
    expect(GIT_LOG_FORMAT).toBe(cli.GIT_LOG_FORMAT);
    const ours = parseGitLog(FIXTURE);
    expect(ours).toEqual(cli.parseGitLog(FIXTURE));
    const opts = { since: day(30), now: NOW, prOf: (s: string) => (s === sha('5') ? 99 : null) };
    // The .mjs is inferred from its JS default (`prOf = () => null`), so it is called untyped here.
    expect(analyze(ours, opts)).toEqual((cli.analyze as (c: unknown, o: unknown) => unknown)(cli.parseGitLog(FIXTURE), opts));
    const plain = analyze(ours, { since: day(30), now: NOW });
    expect(plain).toEqual(cli.analyze(cli.parseGitLog(FIXTURE), { since: day(30), now: NOW }));
    expect(plain.totals).toMatchObject({ merged: 5, revertPrs: 3, reverted: 3, eligible7d: 4, survived7d: 2 });
  });

  it('reads a repository through git and refuses a shallow clone that starts inside the window', async () => {
    const calls: string[][] = [];
    const git = (shallow: boolean, oldestDay: number): TrustGit => async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return shallow ? 'true\n' : 'false\n';
      if (args.includes('--format=%ct')) return `${Math.floor(day(1) / 1000)}\n${Math.floor(day(oldestDay) / 1000)}\n`;
      return FIXTURE;
    };
    const full = await readTrustMetrics('/repo', { since: day(30), now: NOW, git: git(false, 0) });
    expect(full.ok && full.analysis.totals.merged).toBe(5);
    expect(full.ok && full.unattributedCommits).toBe(3);
    expect(calls.some((a) => a.includes('origin/main'))).toBe(true);

    const shallowInside = await readTrustMetrics('/repo', { since: day(30), now: NOW, git: git(true, 10) });
    expect(shallowInside).toMatchObject({ ok: false, code: 'shallow' });

    const shallowDeepEnough = await readTrustMetrics('/repo', { since: day(30), now: NOW, git: git(true, 45) });
    expect(shallowDeepEnough.ok).toBe(true);
  });

  it('fails closed when git fails or the ref is not a ref', async () => {
    const broken: TrustGit = async () => {
      throw new Error('fatal: not a git repository');
    };
    expect(await readTrustMetrics('/x', { since: day(30), now: NOW, git: broken })).toMatchObject({ ok: false, code: 'git_failed' });
    expect(await readTrustMetrics('/x', { since: day(30), now: NOW, ref: '--all', git: broken })).toMatchObject({ ok: false, code: 'git_failed' });
  });
});
