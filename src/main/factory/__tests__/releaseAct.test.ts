// A release's rules and reads (releaseAct.ts): the tag, which workflows run
// on a tag or a branch push in GitHub's filter syntax (fail closed on any
// shape this reading does not know), the checks verdict, the versions, the
// exact bodies main sends, and what the request-time reads refuse, against
// the in-memory GitHub.

import { describe, expect, it } from 'vitest';
import {
  checksRefusal, checksVerdict, draftBody, publishBody, readReleaseAsk, readTagTarget, releaseMode, releaseTagProblem, runsOnBranch, runsOnTag,
  tagPrereleaseShape, tagRefBody, tagVersion, versionProblem, workflowPush, type ReleaseChecks,
} from '../releaseAct';
import type { ApprovalReleaseAct } from '../../../shared/botApproval';
import { FakeGithub } from './fakeGithubActs';

const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);
const OFF = '9'.repeat(40);
const RELEASE_YML = 'name: release\non:\n  push:\n    tags: [\'v*\']\n';
const P = { host: 'github.com', base: 'repos/o/r' };

describe('the tag', () => {
  it('is one plain ref segment', () => {
    for (const ok of ['v1.2.3', 'v4.0.0-beta.1', 'release_2026', '1']) expect(releaseTagProblem(ok)).toBeNull();
    for (const bad of ['', '-v1', '.v1', 'a/b', 'v1..2', 'v1.lock', 'v1.', 'a b', 'v1~2', 'x'.repeat(101)]) expect(releaseTagProblem(bad)).not.toBeNull();
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
    ]) expect(() => workflowPush(text), text).toThrow();
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
  });
});

describe('the checks on the commit', () => {
  const ok = { status: 'completed', conclusion: 'success' };
  const none = { state: 'pending', total: 0 };
  const v = (o: Partial<Parameters<typeof checksVerdict>[0]>): ReleaseChecks => checksVerdict({ runs: [], status: none, workflowRuns: [], pushOnDefault: false, ...o });
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

  it('with no check runs, reads the workflow runs: none at all is allowed, unless a push workflow should have run', () => {
    expect(v({})).toBe('none');
    expect(v({ pushOnDefault: true })).toBe('not-started');
    expect(v({ workflowRuns: [{ status: 'queued', conclusion: null }], pushOnDefault: true })).toBe('running');
    expect(v({ workflowRuns: [{ status: 'completed', conclusion: 'failure' }] })).toBe('failed');
    expect(checksRefusal('failed')).toBe('checks-failing');
    expect(checksRefusal('running')).toBe('checks-pending');
    expect(checksRefusal('not-started')).toBe('checks-not-started');
    expect(checksRefusal('none')).toBeNull();
    expect(checksRefusal('passed')).toBeNull();
  });
});

describe('the versions at the commit', () => {
  const pkg = (v: unknown) => JSON.stringify({ name: 'x', version: v });
  const lock = (top: unknown, root: unknown) => JSON.stringify({ version: top, packages: { '': { version: root } } });
  it('package.json and both of package-lock.json\'s versions must be the tag\'s', () => {
    expect(versionProblem('v1.2.3', pkg('1.2.3'), lock('1.2.3', '1.2.3'))).toBeNull();
    expect(versionProblem('v1.2.3', pkg('1.2.2'), lock('1.2.3', '1.2.3'))).toMatch(/package.json says 1.2.2/);
    expect(versionProblem('v1.2.3', pkg('1.2.3'), lock('1.2.2', '1.2.3'))).toMatch(/package-lock.json says 1.2.2/);
    expect(versionProblem('v1.2.3', pkg('1.2.3'), lock('1.2.3', '1.2.2'))).toMatch(/packages\[""\] says 1.2.2/);
    expect(versionProblem('v4.0.0-beta.1', pkg('4.0.0-beta.1'), null)).toBeNull();
    // No package.json, or a tag that names no version: nothing to compare.
    expect(versionProblem('v1.2.3', null, null)).toBeNull();
    expect(versionProblem('nightly', pkg('0.0.1'), null)).toBeNull();
    expect(() => versionProblem('v1.2.3', '{not json', null)).toThrow();
  });
});

describe('the bodies main sends', () => {
  const act: ApprovalReleaseAct = {
    kind: 'release', mode: 'release', tagName: 'v1.2.3', targetSha: C3, defaultBranch: 'main', title: 'wmux 1.2.3', notes: 'Fixes.', prerelease: false, workflows: [], draft: false,
  };
  it('a draft, then publishing it with make_latest as one of two constants; a tag ref alone', () => {
    expect(draftBody(act)).toEqual({ tag_name: 'v1.2.3', target_commitish: C3, name: 'wmux 1.2.3', body: 'Fixes.', draft: true, prerelease: false });
    expect(publishBody(act)).toEqual({ draft: false, make_latest: 'true' });
    expect(publishBody({ ...act, prerelease: true })).toEqual({ draft: false, make_latest: 'false' });
    expect(tagRefBody(act)).toEqual({ ref: 'refs/tags/v1.2.3', sha: C3 });
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
      mode: 'release', workflows: [], targetSha: C3, defaultBranch: 'main', behindBy: 0, checks: 'passed', version: '1.2.3', prerelease: false,
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

  it('reads an annotated tag through its tag object', async () => {
    const gh = github();
    gh.tags.set('v1', { sha: C2, annotated: true });
    expect(await readTagTarget(gh, P, 'v1')).toBe(C2);
    expect(await readTagTarget(gh, P, 'v2')).toBeNull();
  });
});
