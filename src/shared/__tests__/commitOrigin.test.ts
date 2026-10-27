import { describe, expect, it } from 'vitest';
import { COMMIT_ORIGIN_MAX_CANDIDATES, parseCommitOrigin, parseReflogCommit, textShowsCommitSummary } from '../commitOrigin';

const OLD = 'a'.repeat(40);
const NEW = '0123456789abcdef0123456789abcdef01234567';
const line = (what: string, sha = NEW) => `${OLD} ${sha} Dev Person <dev@example.com> 1793116920 +0900\t${what}`;

describe('parseReflogCommit', () => {
  it('tells a commit, an amend and a first commit apart, and keeps no subject', () => {
    expect(parseReflogCommit(line('commit: fix the thing'))).toEqual({ sha: NEW, at: 1793116920_000, op: 'commit' });
    expect(parseReflogCommit(line('commit (amend): fix the thing'))).toMatchObject({ op: 'amend' });
    expect(parseReflogCommit(line('commit (initial): first'))).toMatchObject({ op: 'initial' });
    expect(JSON.stringify(parseReflogCommit(line('commit: secret subject')))).not.toContain('secret');
    expect(parseReflogCommit(line('commit: x', 'b'.repeat(64)))).toMatchObject({ sha: 'b'.repeat(64) });
  });

  it('skips every other entry, and a line that is not one', () => {
    for (const what of ['checkout: moving from main to x', 'reset: moving to HEAD~1', 'merge feature: Fast-forward',
      'cherry-pick: x', 'rebase (finish): returning', 'pull: Fast-forward', 'commit (merge): Merge branch x']) {
      expect(parseReflogCommit(line(what))).toBeNull();
    }
    expect(parseReflogCommit('commit: no head')).toBeNull();
    expect(parseReflogCommit(`${OLD} ${NEW} name <e> notatime +0900\tcommit: x`)).toBeNull();
  });
});

describe('textShowsCommitSummary', () => {
  it('matches the summary line git commit prints, and not a bare hash', () => {
    expect(textShowsCommitSummary('[main 0123456] fix the thing', NEW)).toBe(true);
    expect(textShowsCommitSummary('  ⎿ [feat/x 0123456789ab] fix', NEW)).toBe(true);
    expect(textShowsCommitSummary('[main (root-commit) 0123456] first', NEW)).toBe(true);
    expect(textShowsCommitSummary('[detached HEAD 0123456] x', NEW)).toBe(true);
    expect(textShowsCommitSummary('[main 012345] fix', NEW)).toBe(false); // under 7
    expect(textShowsCommitSummary('[main 0123457] fix', NEW)).toBe(false);
    expect(textShowsCommitSummary('commit 0123456789abcdef0123456789abcdef01234567', NEW)).toBe(false); // git log
    expect(textShowsCommitSummary('~/repo @0123456 ❯', NEW)).toBe(false); // a prompt
  });
});

describe('parseCommitOrigin', () => {
  const base = { sha: NEW, at: 1, op: 'commit', branch: 'main' };
  it('needs the attributed pane on screen evidence, and keeps candidates otherwise', () => {
    expect(parseCommitOrigin({ ...base, evidence: 'screen' })).toBeNull();
    expect(parseCommitOrigin({ ...base, evidence: 'screen', attributed: { ptyId: 'p1', taskId: 't1' } })?.attributed)
      .toEqual({ ptyId: 'p1', workspaceId: null, agent: null, agentSessionId: null, taskId: 't1' });
    const many = Array.from({ length: 40 }, (_, k) => ({ ptyId: `p${k}` }));
    const none = parseCommitOrigin({ ...base, evidence: 'none', candidates: many, attributed: { ptyId: 'p1' } });
    expect(none?.candidates).toHaveLength(COMMIT_ORIGIN_MAX_CANDIDATES);
    expect(none?.attributed).toBeUndefined();
    expect(parseCommitOrigin({ ...base, sha: 'zz', evidence: 'none' })).toBeNull();
  });
});
