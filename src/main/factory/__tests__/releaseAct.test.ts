// A release's rules and reads (releaseAct.ts): the tag, which workflows run
// on a tag or a branch push in GitHub's filter syntax (fail closed on any
// shape this reading does not know), the checks verdict, the versions, the
// exact bodies main sends, and what the request-time reads refuse, against
// the in-memory GitHub.

import { describe, expect, it } from 'vitest';
import {
  alsoRunsOn, checksRefusal, checksVerdict, deleteDraft, draftBody, filterRegex, latestPerWorkflow, publishBody, publishedWritten,
  pushWorkflowsOf, readReleaseAsk, readReleases, readTagTarget, readWorkflows, releaseMode, releasePrecondition, releaseTagProblem, runsOnBranch, runsOnPublish, runsOnTag,
  sameText, tagPrereleaseShape, tagRefBody, tagVersion, versionProblem, workflowOn, type ReleaseChecks,
} from '../releaseAct';
import type { ApprovalReleaseAct } from '../../../shared/botApproval';
import { FakeGithub } from './fakeGithubActs';

const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);
const OFF = '9'.repeat(40);
const RELEASE_YML = 'name: release\non:\n  push:\n    tags: [\'v*\']\n';
const P = { host: 'github.com', base: 'repos/o/r' };

/** A workflow's `on.push` alone. */
const workflowPush = (text: string) => workflowOn(text).push;

describe('the tag', () => {
  it('is one plain ref segment', () => {
    for (const ok of ['v1.2.3', 'v4.0.0-beta.1', 'release_2026', '1']) expect(releaseTagProblem(ok)).toBeNull();
    for (const bad of ['', '-v1', '.v1', 'a/b', 'v1..2', 'v1.lock', 'v1.', 'a b', 'v1~2', 'x'.repeat(101)]) expect(releaseTagProblem(bad)).not.toBeNull();
    // A capital V would pass the version and prerelease checks by.
    expect(releaseTagProblem('V1.2.3')).toMatch(/lowercase v/);
    expect(tagVersion('V1.2.3')).toBeNull();
  });

  it('names a semver and reads as a prerelease or not', () => {
    expect(tagVersion('v1.2.3')).toBe('1.2.3');
    expect(tagVersion('1.2.3-rc.1+build.5')).toBe('1.2.3-rc.1');
    expect(tagVersion('latest')).toBeNull();
    expect(tagPrereleaseShape('v4.0.0-beta.1')).toBe(true);
    expect(tagPrereleaseShape('v4.0.0')).toBe(false);
    expect(tagPrereleaseShape('v4.0.0+build-7')).toBe(false);
    expect(tagPrereleaseShape('nightly')).toBe(false);
    expect(tagPrereleaseShape('nightly-2026')).toBeNull();
  });
});

describe('which workflows run on a push', () => {
  it('reads `on` as the event key (YAML 1.2), in each of its shapes', () => {
    expect(workflowPush(RELEASE_YML)).toEqual({ tags: ['v*'] });
    expect(workflowPush('on: push\n')).toEqual({});
    expect(workflowPush('on: [push, pull_request]\n')).toEqual({});
    expect(workflowPush('on: pull_request\n')).toBeNull();
    expect(workflowPush('on:\n  push:\n')).toEqual({});
    expect(workflowPush('on:\n  workflow_dispatch: {}\n')).toBeNull();
    expect(workflowPush('on:\n  push:\n    branches: main\n    tags-ignore: ["*-rc*"]\n')).toEqual({ branches: ['main'], tagsIgnore: ['*-rc*'] });
  });

  it('fails closed on a shape it does not know', () => {
    for (const text of [
      'name: no trigger\n',
      'on: 5\n',
      'on: [push, 3]\n',
      'on:\n  push: [main]\n',
      'on:\n  push:\n    tags: [v1]\n    tags-ignore: [v2]\n',
      'on:\n  push:\n    branches: [a]\n    branches-ignore: [b]\n',
      'on:\n  push:\n    tags-ignore: ["!v1"]\n',
      'on:\n  push:\n    tags: ["v[^0]"]\n',
      'on:\n  push:\n    tags: ["?v"]\n',
      'on:\n  push:\n    tags: [{a: 1}]\n',
      'on: [push\n',
      // A YAML merge key is a plain key under YAML 1.2: its filters would be lost.
      'x: &base\n  tags: [v*]\non:\n  push:\n    <<: *base\n',
      'on:\n  push:\n    tags: ["v*?"]\n',
      'on:\n  push:\n    tags: ["v**+"]\n',
    ]) expect(() => workflowPush(text), text).toThrow();
    expect(() => workflowPush('x: &base\n  tags: [v*]\non:\n  push:\n    <<: *base\n')).toThrow(/merge key/);
    expect(() => filterRegex('v*?')).toThrow();
    expect(() => filterRegex('v*+')).toThrow();
  });

  it('notes path filters: such a push to the default branch may not run, so it does not make checks expected', () => {
    const paths = workflowPush('on:\n  push:\n    branches: [main]\n    paths: ["src/**"]\n');
    expect(paths).toEqual({ branches: ['main'], paths: true });
    expect(pushWorkflowsOf([{ path: 'ci.yml', push: paths }], 'main')).toEqual([]);
    expect(pushWorkflowsOf([{ path: 'ci.yml', push: { branches: ['main'] } }], 'main')).toEqual(['ci.yml']);
    expect(workflowPush('on:\n  push:\n    paths-ignore: [docs/**]\n')).toEqual({ paths: true });
  });

  it('matches tags and branches in GitHub\'s filter syntax', () => {
    const tags = (t: string[]) => ({ tags: t });
    expect(runsOnTag(tags(['v*']), 'v1.2.3')).toBe(true);
    expect(runsOnTag(tags(['v*']), 'x1')).toBe(false);
    // Later patterns take back earlier ones.
    expect(runsOnTag(tags(['v*', '!v*-beta*']), 'v1-beta1')).toBe(false);
    expect(runsOnTag(tags(['v*', '!v*-beta*']), 'v1')).toBe(true);
    expect(runsOnTag(tags(['v[0-9]+.[0-9]+.[0-9]+']), 'v12.3.4')).toBe(true);
    expect(runsOnTag(tags(['v[0-9]+.[0-9]+.[0-9]+']), 'v1x2x3')).toBe(false);
    expect(runsOnTag(tags(['v1.?2']), 'v12')).toBe(true);
    expect(runsOnTag({ tagsIgnore: ['*-rc*'] }, 'v1-rc1')).toBe(false);
    expect(runsOnTag({ tagsIgnore: ['*-rc*'] }, 'v1')).toBe(true);
    // No filter runs on every tag; branches alone run on none.
    expect(runsOnTag({}, 'v1')).toBe(true);
    expect(runsOnTag({ branches: ['main'] }, 'v1')).toBe(false);
    expect(runsOnTag(null, 'v1')).toBe(false);
    expect(runsOnBranch({ branches: ['release/*'] }, 'release/x')).toBe(true);
    expect(runsOnBranch({ branches: ['release/*'] }, 'release/x/y')).toBe(false);
    expect(runsOnBranch({ branches: ['release/**'] }, 'release/x/y')).toBe(true);
    expect(runsOnBranch({ tags: ['v*'] }, 'main')).toBe(false);
    expect(runsOnBranch({}, 'main')).toBe(true);
    expect(runsOnBranch({ branchesIgnore: ['main'] }, 'main')).toBe(false);
  });

  it('decides the mode: the tag workflows that run on it, none naming tags, or a refusal', () => {
    const ci = { path: '.github/workflows/ci.yml', push: {} };
    const rel = { path: '.github/workflows/release.yml', push: { tags: ['v*'] } };
    const docker = { path: '.github/workflows/docker.yml', push: { tags: ['v*'] } };
    // A push with no filters runs on a tag too, but names no tags: not a release workflow.
    expect(releaseMode([ci], 'v1')).toEqual({ mode: 'release' });
    expect(releaseMode([], 'v1')).toEqual({ mode: 'release' });
    expect(releaseMode([ci, rel], 'v1')).toEqual({ mode: 'workflow', workflows: ['.github/workflows/release.yml'] });
    expect(releaseMode([rel, docker], 'v1')).toEqual({ mode: 'workflow', workflows: ['.github/workflows/docker.yml', '.github/workflows/release.yml'] });
    expect(releaseMode([rel], 'nightly')).toEqual({ refusal: 'tag-not-matching-release-workflow' });
    // A CI that skips tags is no tag workflow for this tag; one whose
    // tags-ignore leaves this tag in is one.
    const skipsTags = { path: '.github/workflows/ci.yml', push: { branches: ['main'], tagsIgnore: ['**'] } };
    expect(releaseMode([skipsTags], 'v1')).toEqual({ mode: 'release' });
    // A workflow that only leaves some tags out runs on this one too, but is
    // no release workflow: Mode W needs a tags list that takes the tag.
    const leavesOut = { path: '.github/workflows/rc.yml', push: { tagsIgnore: ['*-rc*'] } };
    expect(releaseMode([leavesOut], 'v1')).toEqual({ mode: 'release' });
    expect(alsoRunsOn([leavesOut], 'v1', 'release', false)).toEqual([{ path: '.github/workflows/rc.yml', on: ['tag-push'] }]);
    expect(releaseMode([leavesOut], 'v1-rc1')).toEqual({ mode: 'release' });
    expect(alsoRunsOn([leavesOut], 'v1-rc1', 'release', false)).toEqual([]);
    // The workflows with no filter run on the tag push too: named on the card.
    expect(alsoRunsOn([ci, rel, skipsTags], 'v1', 'workflow', false)).toEqual([{ path: '.github/workflows/ci.yml', on: ['tag-push'] }]);
  });

  it('reads `on.release` and `on.create`: what else runs when the tag is made or the release is published', () => {
    expect(workflowOn('on: release\n')).toEqual({ push: null, release: true, create: false });
    expect(workflowOn('on: [create, pull_request]\n')).toEqual({ push: null, create: true });
    expect(workflowOn('on:\n  release:\n')).toMatchObject({ release: true });
    expect(workflowOn('on:\n  release:\n    types: [published]\n')).toMatchObject({ release: ['published'] });
    expect(workflowOn('on:\n  release:\n    types: prereleased\n')).toMatchObject({ release: ['prereleased'] });
    expect(workflowOn('on:\n  create:\n  push:\n    branches: [main]\n')).toEqual({ push: { branches: ['main'] }, create: true });
    // Publishing a draft fires `published`, and `released` or `prereleased`;
    // `created` is not fired for a draft, nor are edits.
    for (const pre of [false, true]) {
      expect(runsOnPublish(true, pre)).toBe(true);
      expect(runsOnPublish(['published'], pre)).toBe(true);
      expect(runsOnPublish(['released'], pre)).toBe(!pre);
      expect(runsOnPublish(['prereleased'], pre)).toBe(pre);
      expect(runsOnPublish(['created', 'edited', 'deleted'], pre)).toBe(false);
      expect(runsOnPublish(undefined, pre)).toBe(false);
    }
    const onlyReleased = { path: 'r.yml', push: null, release: ['released'] };
    expect(alsoRunsOn([onlyReleased], 'v1', 'release', false)).toEqual([{ path: 'r.yml', on: ['release-published'] }]);
    expect(alsoRunsOn([onlyReleased], 'v1', 'release', true)).toEqual([]);
    expect(() => workflowOn('on:\n  release: [published]\n')).toThrow(/on.release/);
    expect(() => workflowOn('on:\n  release:\n    types: [{a: 1}]\n')).toThrow(/types/);
    const ci = { path: '.github/workflows/ci.yml', push: {} };
    const published = { path: '.github/workflows/notify.yml', push: null, release: true as const };
    const created = { path: '.github/workflows/created.yml', push: null, create: true };
    const rel = { path: '.github/workflows/release.yml', push: { tags: ['v*'] }, create: true };
    // Main publishes in release mode, so a release workflow there runs; in
    // workflow mode the tag workflow publishes the release, not main.
    expect(alsoRunsOn([ci, published, created], 'v1', 'release', false)).toEqual([
      { path: '.github/workflows/ci.yml', on: ['tag-push'] },
      { path: '.github/workflows/created.yml', on: ['tag-create'] },
      { path: '.github/workflows/notify.yml', on: ['release-published'] },
    ]);
    expect(alsoRunsOn([ci, published, created, rel], 'v1', 'workflow', false)).toEqual([
      { path: '.github/workflows/ci.yml', on: ['tag-push'] },
      { path: '.github/workflows/created.yml', on: ['tag-create'] },
    ]);
    expect(alsoRunsOn([{ path: 'all.yml', push: {}, create: true, release: true as const }], 'v1', 'release', false)).toEqual([{ path: 'all.yml', on: ['tag-push', 'tag-create', 'release-published'] }]);
  });
});

describe('the checks on the commit', () => {
  const ok = { status: 'completed', conclusion: 'success' };
  const none = { state: 'pending', total: 0 };
  const v = (o: Partial<Parameters<typeof checksVerdict>[0]>): ReleaseChecks => checksVerdict({ runs: [], status: none, workflowRuns: [], expected: [], branch: 'main', ...o });
  /** A workflow run, by default a push to main. */
  const wr = (status: string, conclusion: string | null, event = 'push', branch = 'main', path = 'ci.yml') => ({ status, conclusion, event, branch, path });
  const CI = ['ci.yml'];
  it('passes only when every run passed and the combined status is success or has no statuses', () => {
    expect(v({ runs: [ok, { status: 'completed', conclusion: 'neutral' }, { status: 'completed', conclusion: 'skipped' }] })).toBe('passed');
    // GitHub answers `pending` with no statuses at all: that is none, not running.
    expect(v({ runs: [ok], status: none })).toBe('passed');
    expect(v({ runs: [ok, { status: 'completed', conclusion: 'failure' }] })).toBe('failed');
    expect(v({ runs: [ok, { status: 'completed', conclusion: 'cancelled' }] })).toBe('failed');
    expect(v({ runs: [ok, { status: 'in_progress', conclusion: null }] })).toBe('running');
    expect(v({ runs: [ok], status: { state: 'failure', total: 1 } })).toBe('failed');
    expect(v({ runs: [ok], status: { state: 'pending', total: 2 } })).toBe('running');
    expect(v({ runs: [], status: { state: 'success', total: 1 } })).toBe('passed');
  });

  it('reads the push workflow runs with the check runs: a queued run is running, though other checks passed; none at all is allowed unless a push workflow should have run', () => {
    expect(v({})).toBe('none');
    expect(v({ expected: CI })).toBe('not-started');
    // Passing statuses are checks, though no run is there.
    expect(v({ status: { state: 'success', total: 2 } })).toBe('passed');
    expect(v({ workflowRuns: [wr('queued', null)], expected: CI })).toBe('running');
    expect(v({ runs: [ok], workflowRuns: [wr('queued', null)] })).toBe('running');
    expect(v({ runs: [ok], workflowRuns: [wr('completed', 'failure')] })).toBe('failed');
    expect(v({ workflowRuns: [wr('completed', 'failure')] })).toBe('failed');
    expect(v({ runs: [ok], workflowRuns: [wr('completed', 'success')], expected: CI })).toBe('passed');
  });

  it('a push to the default branch that should have run its workflows and did not is not-started, whatever else passed', () => {
    // A bot's green check, a deploy preview's status, another event's run: push CI never ran (`[skip ci]`, Actions off).
    expect(v({ runs: [ok], expected: CI })).toBe('not-started');
    expect(v({ status: { state: 'success', total: 2 }, expected: CI })).toBe('not-started');
    expect(v({ runs: [ok], workflowRuns: [wr('completed', 'success', 'pull_request')], expected: CI })).toBe('not-started');
    expect(v({ runs: [ok], workflowRuns: [wr('completed', 'success', 'push', 'feature-x')], expected: CI })).toBe('not-started');
    expect(v({ runs: [ok], expected: [] })).toBe('passed');
    // Every push workflow waited for must have run: another one's green run (a labeler's) is not CI's.
    expect(v({ workflowRuns: [wr('completed', 'success', 'push', 'main', 'labeler.yml')], expected: ['ci.yml', 'labeler.yml'] })).toBe('not-started');
    expect(v({ workflowRuns: [wr('completed', 'success', 'push', 'main', 'labeler.yml'), wr('completed', 'success')], expected: ['ci.yml', 'labeler.yml'] })).toBe('passed');
    // A run's path may carry the ref it was read at.
    expect(v({ workflowRuns: [wr('completed', 'success', 'push', 'main', 'ci.yml@refs/heads/main')], expected: CI })).toBe('passed');
    expect(checksRefusal('failed')).toBe('checks-failing');
    expect(checksRefusal('running')).toBe('checks-pending');
    expect(checksRefusal('not-started')).toBe('checks-not-started');
    expect(checksRefusal('none')).toBeNull();
    expect(checksRefusal('passed')).toBeNull();
  });

  it('takes the latest run, then the latest attempt, of each workflow', () => {
    const run = (workflowId: string, id: number, attempt: number, conclusion: string) => ({ workflowId, id, attempt, status: 'completed', conclusion, event: 'push', branch: 'main', path: 'ci.yml' });
    const latest = latestPerWorkflow([run('1', 10, 1, 'failure'), run('1', 11, 1, 'success'), run('2', 20, 1, 'failure'), run('2', 20, 2, 'success'), run('3', 30, 1, 'success')]);
    expect(latest.map((r) => [r.workflowId, r.id, r.attempt])).toEqual([['1', 11, 1], ['2', 20, 2], ['3', 30, 1]]);
    expect(v({ workflowRuns: latest })).toBe('passed');
  });
});

describe('the versions at the commit', () => {
  const pkg = (v: unknown) => JSON.stringify({ name: 'x', version: v });
  const lock = (top: unknown, root: unknown) => JSON.stringify({ version: top, packages: { '': { version: root } } });
  it('package.json and both of package-lock.json\'s versions must be the tag\'s', () => {
    expect(versionProblem('v1.2.3', pkg('1.2.3'), lock('1.2.3', '1.2.3'))).toEqual({ problem: null, version: '1.2.3' });
    expect(versionProblem('v1.2.3', pkg('1.2.2'), lock('1.2.3', '1.2.3'))).toEqual({ problem: expect.stringMatching(/package.json says 1.2.2/), version: '1.2.2' });
    expect(versionProblem('v1.2.3', pkg('1.2.3'), lock('1.2.2', '1.2.3')).problem).toMatch(/package-lock.json says 1.2.2/);
    expect(versionProblem('v1.2.3', pkg('1.2.3'), lock('1.2.3', '1.2.2')).problem).toMatch(/packages\[""\] says 1.2.2/);
    expect(versionProblem('v4.0.0-beta.1', pkg('4.0.0-beta.1'), null)).toEqual({ problem: null, version: '4.0.0-beta.1' });
    // No package.json, or a tag that names no version: nothing to compare.
    expect(versionProblem('v1.2.3', null, null)).toEqual({ problem: null, version: null });
    expect(versionProblem('nightly', pkg('0.0.1'), null)).toEqual({ problem: null, version: null });
    expect(versionProblem('v1.2.3', pkg(7), null)).toEqual({ problem: expect.stringMatching(/package.json says 7/), version: null });
    expect(() => versionProblem('v1.2.3', '{not json', null)).toThrow();
  });
});

describe('the bodies main sends', () => {
  const act: ApprovalReleaseAct = {
    kind: 'release', mode: 'release', tagName: 'v1.2.3', targetSha: C3, defaultBranch: 'main', title: 'wmux 1.2.3', notes: 'Fixes.', prerelease: false, workflows: [], checksExpected: false, pushWorkflows: [], draft: false,
  };
  it('a draft, then publishing it with make_latest as one of two constants; a tag ref alone', () => {
    expect(draftBody(act)).toEqual({ tag_name: 'v1.2.3', target_commitish: C3, name: 'wmux 1.2.3', body: 'Fixes.', draft: true, prerelease: false });
    // Publishing sends every approved field again: an edit of the draft since is not what goes out.
    expect(publishBody(act)).toEqual({ tag_name: 'v1.2.3', target_commitish: C3, name: 'wmux 1.2.3', body: 'Fixes.', prerelease: false, draft: false, make_latest: 'true' });
    expect(publishBody({ ...act, prerelease: true })).toEqual({ tag_name: 'v1.2.3', target_commitish: C3, name: 'wmux 1.2.3', body: 'Fixes.', prerelease: true, draft: false, make_latest: 'false' });
    expect(tagRefBody(act)).toEqual({ ref: 'refs/tags/v1.2.3', sha: C3 });
  });

  it('a published answer is as approved only with the approved name and notes, read as stored (line ends, trailing whitespace)', () => {
    const answer = (over: Record<string, unknown>) => ({ id: 5, tag_name: 'v1.2.3', draft: false, prerelease: false, author: { login: 'owner' }, html_url: 'https://github.com/o/r/releases/tag/v1.2.3', name: 'wmux 1.2.3', body: 'Fixes.', ...over });
    expect(publishedWritten(answer({}), act, 'owner', 5)).toEqual({ url: 'https://github.com/o/r/releases/tag/v1.2.3', id: 5 });
    expect(publishedWritten(answer({ body: 'Fixes.\r\n' }), act, 'owner', 5)).toEqual({ url: 'https://github.com/o/r/releases/tag/v1.2.3', id: 5 });
    expect(publishedWritten(answer({ body: 'Edited.' }), act, 'owner', 5)).toBe('different');
    expect(publishedWritten(answer({ name: 'other' }), act, 'owner', 5)).toBe('different');
    expect(publishedWritten(answer({ draft: true }), act, 'owner', 5)).toBeNull();
    expect(sameText({ name: 'wmux 1.2.3  ', body: 'Fixes.\n\n' }, act)).toBe(true);
  });
});

/** A GitHub with a default branch of three commits, green checks on the
 *  head, and package.json at 1.2.3. */
function github(): FakeGithub {
  const gh = new FakeGithub();
  gh.history = [C1, C2, C3];
  gh.otherCommits.add(OFF);
  for (const c of [C1, C2, C3, OFF]) gh.checkRuns.set(c, [{ status: 'completed', conclusion: 'success' }]);
  gh.files.set('package.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
  return gh;
}

describe('what a release request reads', () => {
  it('pins the default branch\'s head and states the facts the card shows', async () => {
    const gh = github();
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toEqual({
      mode: 'release', workflows: [], alsoRuns: [], targetSha: C3, defaultBranch: 'main', behindBy: 0, checks: 'passed', version: '1.2.3', prerelease: false, pushWorkflows: [], checksExpected: false,
    });
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3', targetSha: C1, prerelease: true })).toMatchObject({ targetSha: C1, behindBy: 2, prerelease: true });
    gh.files.set('.github/workflows/release.yml', RELEASE_YML);
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ mode: 'workflow', workflows: ['.github/workflows/release.yml'], prerelease: false });
  });

  it('refuses a tag or a release (a draft included) that exists, a commit not on the default branch or not a commit', async () => {
    const refused = async (gh: FakeGithub, input: Parameters<typeof readReleaseAsk>[2], re: RegExp) => {
      const r = await readReleaseAsk(gh, 'github.com/o/r', input);
      expect(r, String(re)).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(re) });
    };
    let gh = github();
    gh.tags.set('v1.2.3', { sha: C1 });
    await refused(gh, { tagName: 'v1.2.3' }, /^tag-taken/);
    gh = github();
    gh.releases.push({ id: 7, tag_name: 'v1.2.3', draft: false, prerelease: false, name: '', body: '', target_commitish: C3, author: { login: 'owner' }, html_url: 'https://github.com/o/r/releases/tag/v1.2.3' });
    await refused(gh, { tagName: 'v1.2.3' }, /^release-exists/);
    gh = github();
    gh.releases.push({ id: 8, tag_name: 'v1.2.3', draft: true, prerelease: false, name: '', body: '', target_commitish: C3, author: { login: 'someone' }, html_url: 'https://github.com/o/r/releases/tag/untagged-1' });
    await refused(gh, { tagName: 'v1.2.3' }, /^release-exists: a draft/);
    await refused(github(), { tagName: 'v1.2.3', targetSha: OFF }, /^not-on-default-branch/);
    await refused(github(), { tagName: 'v1.2.3', targetSha: 'a'.repeat(40) }, /is not a commit/);
  });

  it('refuses versions that are not the tag\'s, a large package-lock.json read through its blob', async () => {
    let gh = github();
    gh.files.set('package.json', JSON.stringify({ version: '1.2.2' }));
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(/^version-mismatch: package.json says 1.2.2/) });
    gh = github();
    gh.files.set('package-lock.json', JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.0' } } }));
    gh.bigFiles.add('package-lock.json');
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(/^version-mismatch: package-lock.json packages\[""\] says 1.2.0/) });
  });

  it('refuses tag workflows that do not run on the tag, an unreadable workflow, and a prerelease flag the workflow mode contradicts', async () => {
    let gh = github();
    gh.files.set('.github/workflows/release.yml', RELEASE_YML);
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'nightly' })).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(/^tag-not-matching-release-workflow/) });
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3', prerelease: true })).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(/^prerelease-mismatch/) });
    gh.files.set('package.json', JSON.stringify({ version: '1.2.3-beta.1' }));
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3-beta.1' })).toMatchObject({ mode: 'workflow', prerelease: true });
    // Without a tag workflow the owner approves the flag as shown.
    gh = github();
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3', prerelease: true })).toMatchObject({ mode: 'release', prerelease: true });
    gh.files.set('.github/workflows/odd.yml', 'on:\n  push:\n    tags: [v1]\n    tags-ignore: [v2]\n');
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(/odd.yml cannot be read/) });
  });

  it('a read GitHub did not answer refuses the request as read_failed', async () => {
    const gh = github();
    gh.answerRead = (e) => (e.startsWith('repos/o/r/releases?') ? { ok: false, kind: 'error', message: 'gh: Server Error (HTTP 502)' } : null);
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'read_failed' });
  });

  it('reads a file at a commit through its folder\'s listing and its blob, whatever its size', async () => {
    const gh = github();
    gh.files.set('package-lock.json', '{"version":"1.2.0"}');
    // Over 1 MB, contents/ refuses the JSON gh asks for (HTTP 403).
    gh.bigFiles.add('package-lock.json');
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(/^version-mismatch: package-lock.json says 1.2.0/) });
    expect(gh.reads.filter((e) => /\/contents\/package-lock\.json/.test(e))).toEqual([]);
  });

  it('does not read through a symlink or a submodule where a file or a workflow is', async () => {
    let gh = github();
    gh.entryTypes.set('package.json', 'symlink');
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'read_failed', message: expect.stringMatching(/is a symlink/) });
    gh = github();
    gh.entryTypes.set('package.json', 'submodule');
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'read_failed', message: expect.stringMatching(/is a submodule/) });
    gh = github();
    gh.files.set('.github/workflows/release.yml', RELEASE_YML);
    gh.entryTypes.set('.github/workflows/release.yml', 'symlink');
    expect(await readWorkflows(gh, P, C3)).toEqual({ refusal: '.github/workflows/release.yml is a symlink, not a file' });
  });

  it('a 200 that is not a ref is not "no such tag"', async () => {
    const gh = github();
    gh.answerRead = (e) => (e === 'repos/o/r/git/ref/tags/v1' ? { ok: true, value: 'not a ref' } : null);
    expect(await readTagTarget(gh, P, 'v1')).toMatchObject({ error: expect.any(String) });
    gh.answerRead = (e) => (e === 'repos/o/r/git/ref/tags/v1' ? { ok: true, value: [{ ref: 'refs/tags/v10', object: { type: 'commit', sha: C1 } }] } : null);
    expect(await readTagTarget(gh, P, 'v1')).toBeNull();
  });

  it('a CI that skips tags does not block a release; one with path filters does not make checks expected', async () => {
    let gh = github();
    gh.files.set('.github/workflows/ci.yml', 'on:\n  push:\n    branches: [main]\n    tags-ignore: ["**"]\n');
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ mode: 'release', alsoRuns: [] });
    gh = github();
    gh.checkRuns.delete(C3);
    gh.files.set('.github/workflows/ci.yml', 'on:\n  push:\n    branches: [main]\n    paths: ["src/**"]\n');
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ checks: 'none' });
    gh.files.set('.github/workflows/ci.yml', 'on:\n  push:\n    branches: [main]\n');
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ checks: 'not-started' });
  });

  it('a prerelease flag left out reads the tag\'s shape in either mode', async () => {
    const gh = github();
    gh.files.set('package.json', JSON.stringify({ version: '1.2.4-rc.1' }));
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.4-rc.1' })).toMatchObject({ mode: 'release', prerelease: true });
  });

  it('refuses a disabled release workflow, or Actions off; a login that cannot read Actions\' switch is not refused for it', async () => {
    const gh = github();
    gh.files.set('.github/workflows/release.yml', RELEASE_YML);
    gh.workflowStates.set('.github/workflows/release.yml', 'disabled_manually');
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(/^workflow-disabled: .github\/workflows\/release.yml is disabled/) });
    gh.workflowStates.clear();
    gh.actions = 'off';
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(/^workflow-disabled: GitHub Actions is off/) });
    gh.actions = 'forbidden';
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ mode: 'workflow' });
  });

  it('reads an annotated tag through its tag object', async () => {
    const gh = github();
    gh.tags.set('v1', { sha: C2, annotated: true });
    expect(await readTagTarget(gh, P, 'v1')).toBe(C2);
    expect(await readTagTarget(gh, P, 'v2')).toBeNull();
  });
});

describe('the checks on the commit, whatever ref ran them', () => {
  const act: ApprovalReleaseAct = {
    kind: 'release', mode: 'release', tagName: 'v1.2.3', targetSha: C3, defaultBranch: 'main', title: 'wmux 1.2.3', notes: 'Fixes.', prerelease: false, workflows: [], checksExpected: false, pushWorkflows: [], draft: false,
  };
  const pre = (gh: FakeGithub, over: Partial<ApprovalReleaseAct> = {}) => releasePrecondition(gh, P, { ...act, ...over }, { login: 'owner', branch: 'main', draftId: undefined, wroteBefore: false });
  const failure = { status: 'completed', conclusion: 'failure' };
  const success = { status: 'completed', conclusion: 'success' };

  it('only the act\'s own tag\'s runs are left out: another tag, a branch an app named, a merge queue all count', async () => {
    const gh = github();
    // The publish made the tag, and its own workflows failed on the commit.
    gh.checkRuns.set(C3, [success, { ...failure, suiteBranch: 'v1.2.3' }]);
    gh.workflowRuns.push(
      { head_sha: C3, event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/1', workflow_id: 9, id: 1 },
      { head_sha: C3, event: 'push', head_branch: 'v1.2.3', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/2', workflow_id: 9, id: 2 },
    );
    expect(await pre(gh)).toMatchObject({ refusal: null });
    for (const ref of ['v1.2.3-beta.1', 'feature-x', 'gh-readonly-queue/main/pr-1-abc', null]) {
      gh.checkRuns.set(C3, [success, { ...failure, suiteBranch: ref }]);
      expect(await pre(gh), String(ref)).toMatchObject({ refusal: 'checks-failing' });
    }
    gh.checkRuns.set(C3, [success]);
    gh.workflowRuns.push({ head_sha: C3, event: 'push', head_branch: 'v1.2.3-beta.1', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/3', workflow_id: 9, id: 3 });
    expect(await pre(gh)).toMatchObject({ refusal: 'checks-failing' });
  });

  it('a re-run (same check, same suite, started after the run completed) that passed stands for the failed one; overlapping runs all count', async () => {
    const gh = github();
    const at = (m: number) => new Date(Date.UTC(2026, 9, 26, 12, m)).toISOString();
    const failed1 = { ...failure, name: 'build', id: 1, startedAt: at(0), completedAt: at(5) };
    gh.checkRuns.set(C3, [failed1, { ...success, name: 'build', id: 2, startedAt: at(6), completedAt: at(9) }, { ...success, name: 'lint', id: 3 }]);
    expect(await pre(gh)).toMatchObject({ refusal: null });
    // Two runs of one name in one suite at once (an app's), or no times given: both count.
    gh.checkRuns.set(C3, [failed1, { ...success, name: 'build', id: 2, startedAt: at(3), completedAt: at(9) }]);
    expect(await pre(gh)).toMatchObject({ refusal: 'checks-failing' });
    gh.checkRuns.set(C3, [{ ...failure, name: 'build', id: 1 }, { ...success, name: 'build', id: 2 }]);
    expect(await pre(gh)).toMatchObject({ refusal: 'checks-failing' });
    // Another suite's run of the same name is not a re-run.
    gh.checkRuns.set(C3, [failed1, { ...success, name: 'build', id: 2, startedAt: at(6), completedAt: at(9), suiteBranch: null }]);
    expect(await pre(gh)).toMatchObject({ refusal: 'checks-failing' });
    // One listing of the commit's check runs and one of its suites; none per suite.
    expect(gh.reads.filter((e) => /check-suites\/\d+\/check-runs/.test(e))).toEqual([]);
    expect(gh.reads.filter((e) => e.startsWith(`repos/o/r/commits/${C3}/check-runs?filter=all&`))).toHaveLength(4);
  });

  it('a workflow run of another event on the commit counts, and a later one does not hide it', async () => {
    const gh = github();
    gh.workflowRuns.push(
      { head_sha: C3, event: 'pull_request', head_branch: 'feature-x', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/1', workflow_id: 9, id: 1 },
      { head_sha: C3, event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/2', workflow_id: 9, id: 2 },
    );
    expect(await pre(gh)).toMatchObject({ refusal: 'checks-failing' });
  });

  it('fails closed on what it cannot read', async () => {
    const gh = github();
    gh.answerRead = (e) => (e.includes('/check-runs?') ? { ok: true, value: { check_runs: [{ id: 1, status: 'completed', conclusion: 'success', check_suite: { id: 5 } }] } } : null);
    expect(await pre(gh)).toMatchObject({ refusal: 'unreadable-answer' });
    gh.answerRead = (e) => (e.includes('/check-suites?') ? { ok: true, value: { check_suites: [{ id: 'x', head_branch: 'main' }] } } : null);
    expect(await pre(gh)).toMatchObject({ refusal: 'unreadable-answer' });
    gh.answerRead = (e) => (e.includes('/check-suites?') ? { ok: false, kind: 'http', status: 403, message: 'gh: Forbidden (HTTP 403)' } : null);
    expect(await pre(gh)).toMatchObject({ refusal: 'gh-403' });
    gh.answerRead = (e) => (e.includes('/check-runs?') ? { ok: false, kind: 'error', message: 'gh: Server Error (HTTP 502)' } : null);
    expect(await pre(gh)).toMatchObject({ refusal: 'read-failed' });
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'read_failed' });
  });

  it('a request an earlier build stored without pushWorkflows reads the workflows now', async () => {
    const gh = github();
    gh.checkRuns.delete(C3);
    const legacy = { checksExpected: undefined, pushWorkflows: undefined };
    expect(await pre(gh, legacy)).toMatchObject({ refusal: null });
    gh.files.set('.github/workflows/ci.yml', 'on:\n  push:\n    branches: [main]\n');
    expect(await pre(gh, legacy)).toMatchObject({ refusal: 'checks-not-started' });
    gh.files.set('.github/workflows/odd.yml', 'on: 5\n');
    expect(await pre(gh, legacy)).toMatchObject({ refusal: 'workflow-unreadable' });
  });

  it('an answer GitHub gave in a shape this build cannot read refuses as unreadable-answer, never gh-200', async () => {
    const gh = github();
    gh.answerRead = (e) => (e === `repos/o/r/commits/${C3}/status` ? { ok: true, value: { state: 'success' } } : null);
    const a = await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' });
    expect(a).toMatchObject({ refuse: 'read_failed' });
    expect(JSON.stringify(a)).not.toContain('200');
  });
});

describe('second code review round', () => {
  const act: ApprovalReleaseAct = {
    kind: 'release', mode: 'release', tagName: 'v1.2.3', targetSha: C3, defaultBranch: 'main', title: 'wmux 1.2.3', notes: 'Fixes.', prerelease: false, workflows: [], checksExpected: false, pushWorkflows: [], draft: false,
  };
  const pre = (gh: FakeGithub) => releasePrecondition(gh, P, act, { login: 'owner', branch: 'main', draftId: undefined, wroteBefore: false });

  it('a listing that fails keeps the failing page\'s status: GitHub\'s 404 is gone, another status refuses, none gives the try back', async () => {
    const gh = github();
    const fail = (a: { ok: false; kind: 'http'; status: number; message: string } | { ok: false; kind: 'error'; message: string }) => {
      gh.answerRead = (e) => (e.startsWith('repos/o/r/releases?') && e.endsWith('page=1') ? a : null);
    };
    fail({ ok: false, kind: 'http', status: 404, message: 'gh: Not Found (HTTP 404)' });
    expect(await readReleases(gh, P)).toMatchObject({ status: 404 });
    expect(await pre(gh)).toMatchObject({ refusal: 'repo-changed' });
    fail({ ok: false, kind: 'http', status: 403, message: 'gh: Resource not accessible (HTTP 403)' });
    expect(await pre(gh)).toMatchObject({ refusal: 'gh-403' });
    fail({ ok: false, kind: 'error', message: 'gh: Server Error (HTTP 502)' });
    expect(await pre(gh)).toMatchObject({ refusal: 'read-failed' });
    // More pages than LIST_PAGES_MAX: the listing cannot say, and never will.
    gh.answerRead = (e) => (e.startsWith('repos/o/r/releases?') ? { ok: true, value: Array.from({ length: 100 }, () => ({})) } : null);
    expect(await pre(gh)).toMatchObject({ refusal: 'unreadable-answer' });
    // A repository read that names no default branch is not a changed branch.
    gh.answerRead = null;
    expect(await releasePrecondition(gh, P, act, { login: 'owner', branch: '', draftId: undefined, wroteBefore: false })).toMatchObject({ refusal: 'unreadable-answer' });
  });

  it('a commit behind the head with no check yet is asked for, not refused: GitHub may still be making its runs', async () => {
    const gh = github();
    gh.files.set('.github/workflows/ci.yml', 'on:\n  push:\n    branches: [main]\n');
    gh.checkRuns.delete(C1);
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3', targetSha: C1 })).toMatchObject({ checks: 'not-started', behindBy: 2 });
  });

  it('a draft is deleted only while its tag is not made at the commit, and kept when that cannot be checked', async () => {
    const draft = (gh: FakeGithub) => {
      gh.releases = [{ id: 50, tag_name: 'v1.2.3', draft: true, prerelease: false, name: 'x', body: '', target_commitish: C3, author: { login: 'owner' }, html_url: 'https://github.com/o/r/releases/tag/x' }];
    };
    // The act that made the draft: its fields are the draft's.
    const want: ApprovalReleaseAct = {
      kind: 'release', mode: 'release', tagName: 'v1.2.3', targetSha: C3, defaultBranch: 'main', title: 'x', notes: '', prerelease: false, workflows: [], pushWorkflows: [], draft: false,
    };
    let gh = github();
    draft(gh);
    gh.tags.set('v1.2.3', { sha: C3 });
    expect(await deleteDraft(gh, P, 50, want)).toBe('kept-tag-made');
    // A row whose request is gone: the draft's own tag and target.
    expect(await deleteDraft(gh, P, 50)).toBe('kept-tag-made');
    gh.answerRead = (e) => (e === 'repos/o/r/git/ref/tags/v1.2.3' ? { ok: false, kind: 'error', message: 'timeout' } : null);
    expect(await deleteDraft(gh, P, 50, want)).toBe('kept-unchecked');
    expect(await deleteDraft(gh, P, 50)).toBe('kept-unchecked');
    gh.answerRead = (e) => (e === 'repos/o/r/releases/50' ? { ok: false, kind: 'error', message: 'timeout' } : null);
    expect(await deleteDraft(gh, P, 50, want)).toBe('kept-unchecked');
    expect(gh.writes).toEqual([]);
    // The tag at the commit, but another release holds it: the draft could
    // never be published, and goes.
    gh = github();
    draft(gh);
    gh.tags.set('v1.2.3', { sha: C3 });
    gh.releases.push({ id: 60, tag_name: 'v1.2.3', draft: false, prerelease: false, name: 'y', body: '', target_commitish: C3, author: { login: 'someone' }, html_url: 'https://github.com/o/r/releases/tag/v1.2.3' });
    expect(await deleteDraft(gh, P, 50, want)).toBe('deleted');
    expect(gh.releases.map((r) => r.id)).toEqual([60]);
    gh = github();
    draft(gh);
    gh.tags.set('v1.2.3', { sha: C3 });
    gh.answerRead = (e) => (e.startsWith('repos/o/r/releases?') ? { ok: false, kind: 'error', message: 'timeout' } : null);
    expect(await deleteDraft(gh, P, 50, want)).toBe('kept-unchecked');
    // The release listing refused (403) or the read itself threw: kept, never deleted.
    gh.answerRead = (e) => (e.startsWith('repos/o/r/releases?') ? { ok: false, kind: 'http', status: 403, message: 'gh: Forbidden (HTTP 403)' } : null);
    expect(await deleteDraft(gh, P, 50, want)).toBe('kept-unchecked');
    gh.answerRead = (e) => {
      if (e.startsWith('repos/o/r/releases?')) throw new Error('gh did not start');
      return null;
    };
    expect(await deleteDraft(gh, P, 50, want)).toBe('kept-unchecked');
    expect(gh.writes).toEqual([]);
    gh = github();
    draft(gh);
    gh.tags.set('v1.2.3', { sha: C2 });
    gh.nextWrite = { answer: { ok: false, kind: 'http', status: 500, message: 'gh: Server Error (HTTP 500)' }, landed: false };
    expect(await deleteDraft(gh, P, 50, want)).toBe('failed');
    expect(await deleteDraft(gh, P, 50, want)).toBe('deleted');
    expect(gh.releases).toEqual([]);
  });

  it('reads no release by its tag when the listing holds one, nor the repository again when the default branch is given', async () => {
    const gh = github();
    gh.releases.push({ id: 7, tag_name: 'v1.2.3', draft: false, prerelease: false, name: '', body: '', target_commitish: C3, author: { login: 'owner' }, html_url: 'https://github.com/o/r/releases/tag/v1.2.3' });
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3', defaultBranch: 'main' })).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(/^release-exists: a release of v1.2.3 is already published/) });
    expect(await pre(gh)).toMatchObject({ refusal: 'release-exists' });
    expect(gh.reads.filter((e) => e.includes('/releases/tags/') || e === 'repos/o/r')).toEqual([]);
    gh.releases = [];
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3', defaultBranch: 'main' })).toMatchObject({ mode: 'release' });
    expect(gh.reads.filter((e) => e === 'repos/o/r')).toEqual([]);
    // Listed none: GitHub's answer for the tag itself is read.
    expect(gh.reads.filter((e) => e.includes('/releases/tags/'))).toHaveLength(1);
  });
});

describe('Mac review round 2', () => {
  const act: ApprovalReleaseAct = {
    kind: 'release', mode: 'release', tagName: 'v1.2.3', targetSha: C3, defaultBranch: 'main', title: 'wmux 1.2.3', notes: 'Fixes.', prerelease: false, workflows: [], checksExpected: false, pushWorkflows: [], draft: false,
  };
  const pre = (gh: FakeGithub, o: { draftId?: number; over?: Partial<ApprovalReleaseAct> } = {}) =>
    releasePrecondition(gh, P, { ...act, ...o.over }, { login: 'owner', branch: 'main', draftId: o.draftId, wroteBefore: false });
  const pushRun = { head_sha: C3, event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/1', workflow_id: 9, id: 1, path: '.github/workflows/ci.yml' };
  const ci = { over: { checksExpected: true, pushWorkflows: ['.github/workflows/ci.yml'] } };

  it('a green third-party check with no push run on the default branch is not-started, never passed', async () => {
    const gh = github();
    gh.files.set('.github/workflows/ci.yml', 'on:\n  push:\n    branches: [main]\n');
    // github() puts one green check run on every commit: a bot's.
    expect(await pre(gh, ci)).toMatchObject({ refusal: 'checks-not-started' });
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ checks: 'not-started', pushWorkflows: ['.github/workflows/ci.yml'] });
    gh.workflowRuns.push(pushRun);
    expect(await pre(gh, ci)).toMatchObject({ refusal: null });
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ checks: 'passed' });
  });

  it('a journaled draft deleted on GitHub refuses draft-gone: no new draft in its place', async () => {
    const gh = github();
    gh.workflowRuns.push(pushRun);
    expect(await pre(gh, { draftId: 77 })).toMatchObject({ refusal: 'draft-gone' });
    // The draft there, but no longer this act's (its tag edited): found-different.
    gh.releases.push({ id: 77, tag_name: 'v9', draft: true, prerelease: false, name: 'wmux 1.2.3', body: 'Fixes.', target_commitish: C3, author: { login: 'owner' }, html_url: 'https://github.com/o/r/releases/tag/x' });
    expect(await pre(gh, { draftId: 77 })).toMatchObject({ refusal: 'found-different' });
    // Not listed (the listing late), but there by its id: decided from that answer.
    gh.releases = [];
    const answer = (over: Record<string, unknown>) => ({ id: 77, tag_name: 'v1.2.3', draft: true, prerelease: false, name: 'wmux 1.2.3', body: 'Fixes.', target_commitish: C3, author: { login: 'owner' }, html_url: 'https://github.com/o/r/releases/tag/x', ...over });
    gh.answerRead = (e) => (e === 'repos/o/r/releases/77' ? { ok: true, value: answer({}) } : null);
    expect(await pre(gh, { draftId: 77 })).toMatchObject({ refusal: null, draft: { id: 77 } });
    gh.answerRead = (e) => (e === 'repos/o/r/releases/77' ? { ok: true, value: answer({ tag_name: 'v9' }) } : null);
    expect(await pre(gh, { draftId: 77 })).toMatchObject({ refusal: 'found-different' });
    gh.answerRead = (e) => (e === 'repos/o/r/releases/77' ? { ok: true, value: answer({ draft: false }) } : null);
    expect(await pre(gh, { draftId: 77 })).toMatchObject({ refusal: 'release-exists' });
    gh.answerRead = (e) => (e === 'repos/o/r/releases/77' ? { ok: true, value: { id: 77 } } : null);
    expect(await pre(gh, { draftId: 77 })).toMatchObject({ refusal: 'unreadable-answer' });
    // The draft as journaled: no refusal.
    gh.answerRead = null;
    gh.releases.push({ id: 77, tag_name: 'v1.2.3', draft: true, prerelease: false, name: 'wmux 1.2.3', body: 'Fixes.', target_commitish: C3, author: { login: 'owner' }, html_url: 'https://github.com/o/r/releases/tag/x' });
    expect(await pre(gh, { draftId: 77 })).toMatchObject({ refusal: null, draft: { id: 77 } });
  });

  it('a branch named like the tag refuses when the bot asks and when it runs', async () => {
    const gh = github();
    gh.workflowRuns.push(pushRun);
    gh.branches.add('v1.2.3');
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ refuse: 'invalid', message: expect.stringMatching(/^tag-name-is-branch: /) });
    expect(await pre(gh)).toMatchObject({ refusal: 'tag-name-is-branch' });
    gh.answerRead = (e) => (e === 'repos/o/r/git/ref/heads/v1.2.3' ? { ok: false, kind: 'error', message: 'timeout' } : null);
    expect(await pre(gh)).toMatchObject({ refusal: 'read-failed' });
    gh.answerRead = null;
    gh.branches.clear();
    expect(await pre(gh)).toMatchObject({ refusal: null });
  });

  it('a deleted draft is draft-gone before any tag test: a tag made elsewhere since does not hide it', async () => {
    const gh = github();
    gh.tags.set('v1.2.3', { sha: C2 });
    expect(await pre(gh, { draftId: 77 })).toMatchObject({ refusal: 'draft-gone' });
  });

  it('a 2xx naming another ref is unreadable, for a branch as for a tag', async () => {
    const gh = github();
    gh.answerRead = (e) => (e === 'repos/o/r/git/ref/heads/v1.2.3' ? { ok: true, value: { ref: 'refs/heads/v1.2.30', object: { type: 'commit', sha: C1 } } } : null);
    expect(await pre(gh)).toMatchObject({ refusal: 'unreadable-answer' });
    gh.answerRead = (e) => (e === 'repos/o/r/git/ref/heads/v1.2.3' ? { ok: true, value: 'not a ref' } : null);
    expect(await pre(gh)).toMatchObject({ refusal: 'unreadable-answer' });
    gh.answerRead = (e) => (e === 'repos/o/r/git/ref/heads/v1.2.3' ? { ok: true, value: [{ ref: 'refs/heads/v1.2.30', object: { type: 'commit', sha: C1 } }] } : null);
    expect(await pre(gh)).toMatchObject({ refusal: null });
    gh.answerRead = (e) => (e === 'repos/o/r/git/ref/tags/v1.2.3' ? { ok: true, value: { ref: 'refs/tags/v1.2.30', object: { type: 'commit', sha: C1 } } } : null);
    expect(await readTagTarget(gh, P, 'v1.2.3')).toMatchObject({ unreadable: true });
  });

  it('the push workflows waited for are pinned when the bot asks (enabled ones only); one disabled since refuses workflow-disabled', async () => {
    const gh = github();
    gh.files.set('.github/workflows/ci.yml', 'on:\n  push:\n    branches: [main]\n');
    gh.files.set('.github/workflows/labeler.yml', 'on: push\n');
    gh.files.set('.github/workflows/old.yml', 'on: push\n');
    gh.workflowStates.set('.github/workflows/old.yml', 'disabled_manually');
    const ask = await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' });
    expect(ask).toMatchObject({ pushWorkflows: ['.github/workflows/ci.yml', '.github/workflows/labeler.yml'], checksExpected: true, checks: 'not-started' });
    const pinned = { over: { checksExpected: true, pushWorkflows: ['.github/workflows/ci.yml', '.github/workflows/labeler.yml'] } };
    // The labeler ran on the push; CI did not.
    gh.workflowRuns.push({ ...pushRun, path: '.github/workflows/labeler.yml', workflow_id: 8, id: 2 });
    expect(await pre(gh, pinned)).toMatchObject({ refusal: 'checks-not-started' });
    // CI disabled with no push run on the commit: it never will run.
    gh.workflowStates.set('.github/workflows/ci.yml', 'disabled_manually');
    expect(await pre(gh, pinned)).toMatchObject({ refusal: 'workflow-disabled' });
    // CI ran on the push and passed: disabled since, it counts all the same.
    gh.workflowRuns.push(pushRun);
    expect(await pre(gh, pinned)).toMatchObject({ refusal: null });
    gh.workflowStates.delete('.github/workflows/ci.yml');
    expect(await pre(gh, pinned)).toMatchObject({ refusal: null });
    // Actions off: no push run is waited for when the bot asks.
    gh.workflowStates.clear();
    gh.actions = 'off';
    expect(await readReleaseAsk(gh, 'github.com/o/r', { tagName: 'v1.2.3' })).toMatchObject({ pushWorkflows: [], checksExpected: false });
  });

  it('a draft changed on GitHub (its tag, notes, name, target or prerelease flag) is the owner\'s now: never deleted', async () => {
    const made = { id: 50, tag_name: 'v1.2.3', draft: true, prerelease: false, name: 'wmux 1.2.3', body: 'Fixes.', target_commitish: C3, author: { login: 'owner' }, html_url: 'https://github.com/o/r/releases/tag/x' };
    for (const edit of [{ tag_name: 'v9' }, { body: 'Edited.' }, { name: 'Other' }, { target_commitish: C2 }, { prerelease: true }]) {
      const gh = github();
      gh.releases = [{ ...made, ...edit }];
      expect(await deleteDraft(gh, P, 50, act), JSON.stringify(edit)).toBe('kept-not-ours');
      expect(gh.writes).toEqual([]);
    }
    // As the act made it, with no tag: deleted.
    const gh = github();
    gh.releases = [{ ...made }];
    expect(await deleteDraft(gh, P, 50, act)).toBe('deleted');
  });

  it('a branch ref read that fails is not a branch: 410 and the like refuse as GitHub\'s answer', async () => {
    const gh = github();
    gh.answerRead = (e) => (e === 'repos/o/r/git/ref/heads/v1.2.3' ? { ok: false, kind: 'http', status: 410, message: 'gh: Gone (HTTP 410)' } : null);
    expect(await pre(gh)).toMatchObject({ refusal: 'gh-410' });
    gh.answerRead = (e) => (e === 'repos/o/r/git/ref/heads/v1.2.3' ? { ok: false, kind: 'http', status: 403, message: 'gh: Forbidden (HTTP 403)' } : null);
    expect(await pre(gh)).toMatchObject({ refusal: 'gh-403' });
  });
});
