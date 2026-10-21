// GlabPrService's factory half: the lane read of one merge request (mapped to
// PrLaneFacts), the default-branch CI read, the login, and the squash merge
// with its head checks (exec mocked, as in GlabPrService.test).
import { describe, it, expect, vi } from 'vitest';
import {
  GlabPrService,
  glabMergeBlock,
  glabMergeState,
  glabSquashSubject,
  mapGlabCiRollup,
  mapGlabLaneFacts,
} from '../GlabPrService';

const KEY = 'gitlab.example.com/group/sub/proj';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const MERGE_REF = 'c'.repeat(40);

function mrAnswer(over: Record<string, unknown> = {}, pipeline: Record<string, unknown> | null = {}) {
  return {
    data: {
      project: {
        mergeRequest: {
          iid: '7', title: 'feat: x', state: 'opened', draft: false, sourceBranch: 'wtask/x', targetBranch: 'main',
          diffHeadSha: HEAD, sourceProjectId: 10, targetProjectId: 10, conflicts: false, detailedMergeStatus: 'MERGEABLE',
          mergedAt: null, mergeCommitSha: null, author: { username: 'alice' },
          labels: { pageInfo: { hasNextPage: false }, nodes: [{ title: 'bug' }, { title: 'needs-windows-verify' }] },
          diffStatsSummary: { fileCount: 2 }, diffStats: [{ path: 'src/a.ts' }, { path: 'README.md' }],
          headPipeline: pipeline === null ? null : {
            sha: HEAD, mergeRequestEventType: 'DETACHED',
            jobs: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { name: 'test', status: 'SUCCESS', allowFailure: false, webPath: '/group/sub/proj/-/jobs/1', stage: { name: 'test' }, startedAt: 's', finishedAt: 'f' },
                { name: 'flaky', status: 'FAILED', allowFailure: true, webPath: '/group/sub/proj/-/jobs/2', stage: { name: 'test' } },
                { name: 'deploy', status: 'MANUAL', allowFailure: true, webPath: '/group/sub/proj/-/jobs/3', stage: { name: 'deploy' } },
              ],
            },
            ...pipeline,
          },
          ...over,
        },
      },
    },
  };
}

type Handler = (args: string[]) => unknown;

function makeService(handler: Handler) {
  const calls: string[][] = [];
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    calls.push(args);
    const r = handler(args);
    if (r instanceof Error) throw r;
    return { stdout: JSON.stringify(r) };
  });
  return { svc: new GlabPrService(() => 1000, exec as never), calls };
}

const isGraphql = (args: string[]) => args[3] === 'graphql';
const queryOf = (args: string[]) => args.find((a) => a.startsWith('query=')) ?? '';

describe('mapGlabLaneFacts', () => {
  it('maps an open merge request: iid as number, labels, files, jobs with allow-failure as not required', () => {
    const f = mapGlabLaneFacts(mrAnswer(), 'gitlab.example.com');
    expect(f).toMatchObject({
      number: 7, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefOid: HEAD, headRefName: 'wtask/x', baseRefName: 'main',
      author: 'alice', title: 'feat: x', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', mergedAt: null, mergeCommitOid: null,
      labels: ['bug', 'needs-windows-verify'], labelsTruncated: false, files: ['src/a.ts', 'README.md'], filesTruncated: false,
      checksHeadOid: HEAD, checksTruncated: false,
    });
    expect(f?.checks).toEqual([
      { name: 'test', workflow: 'test', bucket: 'pass', link: 'https://gitlab.example.com/group/sub/proj/-/jobs/1', startedAt: 's', completedAt: 'f', isRequired: true },
      { name: 'flaky', workflow: 'test', bucket: 'fail', link: 'https://gitlab.example.com/group/sub/proj/-/jobs/2', isRequired: false },
      { name: 'deploy', workflow: 'deploy', bucket: 'skipping', link: 'https://gitlab.example.com/group/sub/proj/-/jobs/3', isRequired: false },
    ]);
  });

  it('states, forks, truncation and a missing pipeline', () => {
    expect(mapGlabLaneFacts(mrAnswer({ state: 'merged', mergeCommitSha: OTHER }), 'h')).toMatchObject({ state: 'MERGED', mergeCommitOid: OTHER });
    expect(mapGlabLaneFacts(mrAnswer({ state: 'locked' }), 'h')?.state).toBe('CLOSED');
    expect(mapGlabLaneFacts(mrAnswer({ sourceProjectId: 11 }), 'h')?.isCrossRepository).toBe(true);
    expect(mapGlabLaneFacts(mrAnswer({ sourceProjectId: null }), 'h')?.isCrossRepository).toBe(true);
    expect(mapGlabLaneFacts(mrAnswer({ diffStatsSummary: { fileCount: 500 } }), 'h')?.filesTruncated).toBe(true);
    expect(mapGlabLaneFacts(mrAnswer({ labels: { nodes: [] } }), 'h')?.labelsTruncated).toBe(true);
    expect(mapGlabLaneFacts(mrAnswer({}, null), 'h')).toMatchObject({ checks: [], checksHeadOid: null, checksTruncated: false });
    expect(mapGlabLaneFacts({ data: { project: { mergeRequest: null } } }, 'h')).toBeNull();
    expect(mapGlabLaneFacts({ errors: [{ message: 'nope' }] }, 'h')).toBeNull();
  });

  it('detailedMergeStatus in the GitHub words mergeBlock reads', () => {
    expect(glabMergeState('MERGEABLE', false)).toEqual({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    expect(glabMergeState('CONFLICT', true)).toEqual({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    expect(glabMergeState('NEED_REBASE', false).mergeStateStatus).toBe('BEHIND');
    expect(glabMergeState('DRAFT_STATUS', false).mergeStateStatus).toBe('DRAFT');
    expect(glabMergeState('CI_STILL_RUNNING', false).mergeStateStatus).toBe('UNSTABLE');
    expect(glabMergeState('NOT_APPROVED', false).mergeStateStatus).toBe('BLOCKED');
    expect(glabMergeState('CHECKING', false)).toEqual({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  });

  it('glabMergeBlock: only required jobs hold a merge, and a pipeline of another commit is still to come', () => {
    const f = mapGlabLaneFacts(mrAnswer(), 'h');
    if (!f) throw new Error('unmapped');
    expect(glabMergeBlock(f)).toBeNull();
    expect(glabMergeBlock({ ...f, checks: f.checks.map((c) => (c.name === 'test' ? { ...c, bucket: 'fail' as const } : c)) })).toBe('checks-failing');
    expect(glabMergeBlock({ ...f, checksHeadOid: OTHER })).toBe('checks-pending');
    expect(glabMergeBlock({ ...f, isDraft: true })).toBe('draft');
    expect(glabMergeBlock({ ...f, mergeStateStatus: 'BLOCKED' })).toBe('blocked');
  });
});

describe('laneFacts', () => {
  it('reads the named project on the key\'s host, fresh each time', async () => {
    const { svc, calls } = makeService(() => mrAnswer());
    const r = await svc.laneFacts('/repo', KEY, 7);
    expect(r).toMatchObject({ ok: true, value: { number: 7, headRefOid: HEAD } });
    await svc.laneFacts('/repo', KEY, 7);
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 4)).toEqual(['api', '--hostname', 'gitlab.example.com', 'graphql']);
    expect(calls[0]).toContain('fullPath=group/sub/proj');
    expect(calls[0]).toContain('iid=7');
  });

  it('a merged-results pipeline counts for the head only when the head is a parent of its merge commit', async () => {
    const answer = mrAnswer({}, { sha: MERGE_REF, mergeRequestEventType: 'MERGED_RESULT' });
    const parents = vi.fn((): unknown => ({ parent_ids: [OTHER, HEAD] }));
    const { svc, calls } = makeService((args) => (isGraphql(args) ? answer : parents()));
    expect(await svc.laneFacts('/repo', KEY, 7)).toMatchObject({ ok: true, value: { checksHeadOid: HEAD } });
    expect(calls[1]).toEqual(['api', '--hostname', 'gitlab.example.com', `projects/group%2Fsub%2Fproj/repository/commits/${MERGE_REF}`]);
    parents.mockReturnValue({ parent_ids: [OTHER, OTHER] });
    expect(await svc.laneFacts('/repo', KEY, 7)).toMatchObject({ ok: true, value: { checksHeadOid: MERGE_REF } });
  });

  it('a GraphQL error or a key that is no project is a read error', async () => {
    const { svc } = makeService(() => ({ errors: [{ message: 'Field x does not exist' }] }));
    expect(await svc.laneFacts('/repo', KEY, 7)).toEqual({ ok: false, code: 'error', message: 'Field x does not exist' });
    expect(await svc.laneFacts('/repo', 'gitlab.example.com/x', 7)).toMatchObject({ ok: false, code: 'error' });
  });
});

describe('defaultBranchCi', () => {
  const ROOT = { data: { project: { repository: { rootRef: 'main' } } } };
  const CI = {
    data: { project: { repository: { tree: { lastCommit: {
      sha: HEAD, committedDate: '2026-10-21T00:00:00Z',
      pipelines: { nodes: [{ status: 'FAILED', jobs: { count: 3, nodes: [
        { name: 'test', status: 'FAILED', allowFailure: false },
        { name: 'flaky', status: 'FAILED', allowFailure: true },
        { name: 'lint', status: 'SUCCESS', allowFailure: false },
      ] } }] },
    } } } } },
  };

  it('maps the head of the default branch and its newest pipeline there', async () => {
    const { svc, calls } = makeService((args) => (queryOf(args).includes('rootRef') ? ROOT : CI));
    expect(await svc.defaultBranchCi('/repo', KEY)).toEqual({
      branch: 'main', headSha: HEAD, committedAt: '2026-10-21T00:00:00Z', state: 'FAILURE',
      checks: [{ name: 'test', state: 'FAILURE' }, { name: 'flaky', state: 'NEUTRAL' }, { name: 'lint', state: 'SUCCESS' }],
      checksTotal: 3,
    });
    expect(calls[1]).toContain('ref=main');
  });

  it('no pipeline on the head yet: no state, no checks; an unreadable answer is an error', () => {
    const none = { data: { project: { repository: { tree: { lastCommit: { sha: HEAD, committedDate: null, pipelines: { nodes: [] } } } } } } };
    expect(mapGlabCiRollup(none, 'main')).toEqual({ branch: 'main', headSha: HEAD, committedAt: null, state: null, checks: [], checksTotal: 0 });
    expect(mapGlabCiRollup({ data: null }, 'main')).toBeNull();
  });

  it('a project with no default branch is an error', async () => {
    const { svc } = makeService(() => ({ data: { project: null } }));
    expect(await svc.defaultBranchCi('/repo', KEY)).toEqual({ error: 'the default branch could not be read' });
  });
});

describe('merge', () => {
  const req = { expectHead: HEAD, subject: '', body: '' };

  it('squash-merges at the expected head with the title and !iid as subject', async () => {
    const { svc, calls } = makeService((args) => (isGraphql(args) ? mrAnswer() : { state: 'merged' }));
    const gate = vi.fn(() => null);
    expect(await svc.merge('/repo', KEY, 7, req, gate)).toEqual({ ok: true, url: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/7' });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(calls[1]).toEqual([
      'api', '--hostname', 'gitlab.example.com', '-X', 'PUT', 'projects/group%2Fsub%2Fproj/merge_requests/7/merge',
      '-f', `sha=${HEAD}`, '-F', 'squash=true', '-f', 'squash_commit_message=feat: x (!7)',
    ]);
  });

  it('refuses a head that moved before writing anything', async () => {
    const { svc, calls } = makeService(() => mrAnswer({ diffHeadSha: OTHER }, { sha: OTHER }));
    expect(await svc.merge('/repo', KEY, 7, req)).toMatchObject({ ok: false, code: 'moved', headRefOid: OTHER });
    expect(calls).toHaveLength(1);
  });

  it('refuses an MR that is not open or cannot merge, and a gate that says no', async () => {
    const closed = makeService(() => mrAnswer({ state: 'closed' }));
    expect(await closed.svc.merge('/repo', KEY, 7, req)).toMatchObject({ ok: false, code: 'blocked', reason: 'not-open' });
    const conflicted = makeService(() => mrAnswer({ conflicts: true, detailedMergeStatus: 'CONFLICT' }));
    expect(await conflicted.svc.merge('/repo', KEY, 7, req)).toMatchObject({ ok: false, code: 'blocked', reason: 'conflicts' });
    const denied = makeService(() => mrAnswer());
    expect(await denied.svc.merge('/repo', KEY, 7, req, () => 'revoked')).toMatchObject({ ok: false, code: 'invalid' });
    for (const m of [closed, conflicted, denied]) expect(m.calls).toHaveLength(1);
  });

  it('GitLab\'s own refusals: 409 is a moved head, 405 cannot merge; anything else stays an error', async () => {
    const fail = (stderr: string) => makeService((args) => (isGraphql(args) ? mrAnswer() : Object.assign(new Error('exit 1'), { stderr })));
    expect(await fail('glab: SHA does not match HEAD of source branch (HTTP 409)').svc.merge('/repo', KEY, 7, req)).toMatchObject({ ok: false, code: 'moved' });
    expect(await fail('glab: 405 Method Not Allowed').svc.merge('/repo', KEY, 7, req)).toMatchObject({ ok: false, code: 'blocked', reason: 'blocked' });
    expect(await fail('connection reset').svc.merge('/repo', KEY, 7, req)).toMatchObject({ ok: false, code: 'error' });
  });

  it('subjects', () => {
    expect(glabSquashSubject('  fix:  y ', 3)).toBe('fix: y (!3)');
    expect(glabSquashSubject('', 3)).toBe('Merge request !3 (!3)');
  });
});

describe('currentLogin', () => {
  it('the signed-in username on the key\'s host, or null', async () => {
    const { svc, calls } = makeService(() => ({ username: 'Alice' }));
    expect(await svc.currentLogin('/repo', KEY)).toBe('alice');
    expect(calls[0]).toEqual(['api', '--hostname', 'gitlab.example.com', 'user']);
    const broken = makeService(() => new Error('401'));
    expect(await broken.svc.currentLogin('/repo', KEY)).toBeNull();
  });
});
