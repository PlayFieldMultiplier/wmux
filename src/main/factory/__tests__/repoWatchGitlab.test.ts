import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_WATCH_LIMITS, RepoWatch, type WatchGraphql } from '../repoWatch';
import {
  GITLAB_WATCH_QUERY,
  gitlabChecksOf,
  gitlabWatchReader,
  mapGitlabWatchAnswer,
  type GitlabWatchAnswer,
  type GitlabWatchPorts,
} from '../repoWatchGitlab';
import { factDedupeKey, type FactDraft } from '../../../shared/facts';
import type { ForgeHosts } from '../../../shared/forgeHosts';

// glab's host entries (shared/forgeHosts.ts): none unless a test sets them.
const forge = vi.hoisted(() => ({ hosts: { gh: new Set<string>(), glab: new Map() } as ForgeHosts }));
vi.mock('../../../shared/forgeHosts', async (orig) => ({
  ...(await orig<typeof import('../../../shared/forgeHosts')>()),
  forgeHosts: () => forge.hosts,
}));
import type { BotProfile } from '../../../shared/bot';

const KEY = 'gitlab.example.com/group/sub/app';
const T0 = Date.parse('2026-10-22T00:00:00Z');
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const TARGET = 'd'.repeat(40);

interface Job { status: string; allowFailure?: boolean }
interface Pipeline { sha: string; status: string; type?: string; jobs?: Job[]; more?: boolean }
interface MrSpec { iid: number; head: string; pipeline?: Pipeline | null; labels?: string[]; labelCount?: number; state?: string }
interface Spec { open: MrSpec[]; locked?: MrSpec[]; merged?: number[]; closed?: number[]; issues?: Array<{ iid: number; labels?: string[]; createdAt?: number; confidential?: boolean }> }

function mrNode(m: MrSpec) {
  const p = m.pipeline;
  return {
    iid: String(m.iid), title: `MR ${m.iid}`, createdAt: new Date(T0 - 86_400_000).toISOString(), state: m.state ?? 'opened', draft: false,
    diffHeadSha: m.head, sourceBranch: `b${m.iid}`, sourceProjectId: 7, targetProjectId: 7, detailedMergeStatus: 'MERGEABLE', conflicts: false,
    author: { username: 'owner' },
    labels: { count: m.labelCount ?? (m.labels ?? []).length, nodes: (m.labels ?? []).map((title) => ({ title })) },
    headPipeline: p ? {
      sha: p.sha, status: p.status, mergeRequestEventType: p.type ?? 'DETACHED',
      jobs: { pageInfo: { hasNextPage: p.more === true }, nodes: (p.jobs ?? [{ status: p.status === 'SUCCESS' ? 'SUCCESS' : p.status }]).map((j) => ({ status: j.status, allowFailure: j.allowFailure === true })) },
    } : null,
  };
}

function answer(s: Spec) {
  return {
    data: {
      project: {
        open: { count: s.open.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: s.open.map(mrNode) },
        locked: { count: (s.locked ?? []).length, nodes: (s.locked ?? []).map((m) => mrNode({ state: 'locked', ...m })) },
        merged: { nodes: (s.merged ?? []).map((iid) => ({ iid: String(iid) })) },
        closed: { nodes: (s.closed ?? []).map((iid) => ({ iid: String(iid) })) },
        issues: {
          count: (s.issues ?? []).length,
          nodes: (s.issues ?? []).map((i) => ({
            iid: String(i.iid), title: `I ${i.iid}`, createdAt: new Date(i.createdAt ?? T0 - 86_400_000).toISOString(), confidential: i.confidential ?? false, author: { username: 'someone' },
            labels: { count: (i.labels ?? []).length, nodes: (i.labels ?? []).map((title) => ({ title })) },
          })),
        },
      },
    },
  };
}

function fakeGlab(get: () => Spec | GitlabWatchAnswer, parents: Record<string, string[]> = {}) {
  const calls: Array<{ query: string; vars: Record<string, string> }> = [];
  const parentReads: string[] = [];
  const ports: GitlabWatchPorts = {
    graphql: async (_p, _k, query, vars) => {
      calls.push({ query, vars });
      const s = get();
      return 'ok' in s ? s : { ok: true, value: answer(s) };
    },
    commitParents: async (_p, _k, sha) => {
      parentReads.push(sha);
      return parents[sha] ?? [];
    },
  };
  return { ports, calls, parentReads };
}

function fakeFacts() {
  const keys = new Set<string>();
  const appended: FactDraft[] = [];
  return {
    appended,
    append(draft: FactDraft) {
      const key = factDedupeKey(draft);
      if (!key || keys.has(key)) return null;
      keys.add(key);
      appended.push(draft);
      return { ...draft, id: String(appended.length), seq: appended.length, dedupeKey: key };
    },
  };
}

function bot(id: string, repoKey = KEY): BotProfile {
  return {
    version: 1, id, workspaceId: 'ws-1', role: 'verifier', name: 'V', engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
    repo: { repoKey, repoPath: '/repo' }, enabled: true, createdAt: 0, updatedAt: 0,
  };
}

let dir = '';
let now = T0;
let timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
let made: RepoWatch[] = [];

function makeWatch(glab: ReturnType<typeof fakeGlab>, facts: ReturnType<typeof fakeFacts>, extra: { graphql?: WatchGraphql; log?: (m: string) => void; bots?: BotProfile[] } = {}) {
  const w = new RepoWatch({
    facts,
    bots: { listEnabled: () => extra.bots ?? [bot('bot-00000001')] },
    graphql: extra.graphql ?? (async () => { throw new Error('gh must not be asked'); }),
    gitlab: gitlabWatchReader(glab.ports),
    stateFile: path.join(dir, 'factory', 'repo-watch.json'),
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    log: extra.log ?? (() => undefined),
  });
  made.push(w);
  return w;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-repo-watch-gl-'));
  now = T0;
  timers = [];
  made = [];
});

afterEach(async () => {
  for (const w of made) await w.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

const kinds = (f: ReturnType<typeof fakeFacts>) => f.appended.map((d) => `${d.kind}:${d.ref?.pr ?? d.ref?.issue}`);

describe('GitLab watch mapping', () => {
  it('reads string iids, counts and label titles; folds locked MRs into the open set', () => {
    const m = mapGitlabWatchAnswer(answer({
      open: [{ iid: 4, head: HEAD, labels: ['b', 'a'] }, { iid: 5, head: HEAD2, labels: ['x'], labelCount: 30 }],
      locked: [{ iid: 3, head: HEAD }, { iid: 4, head: HEAD }],
      merged: [2], closed: [1],
      issues: [{ iid: 9, labels: ['bug'] }, { iid: 10, confidential: true }],
    }));
    expect(m?.snapshot.prs.map((p) => [p.number, p.state, p.labels, p.labelsTruncated, p.mergeStateStatus, p.isCrossRepository])).toEqual([
      [4, 'OPEN', ['a', 'b'], false, 'CLEAN', false],
      [5, 'OPEN', ['x'], true, 'CLEAN', false],
      [3, 'LOCKED', [], false, 'CLEAN', false],
    ]);
    // MR 4, read in both lists, counts once; the open-PR cap counts open MRs only.
    expect(m?.snapshot.prTotal).toBe(3);
    expect(m?.snapshot.openTotal).toBe(2);
    expect(m?.snapshot.issueTotal).toBe(1);
    expect(m?.snapshot.recent).toEqual({ 1: 'CLOSED', 2: 'MERGED' });
    expect(m?.snapshot.issues.map((i) => [i.number, i.labels])).toEqual([[9, ['bug']]]);
    expect(mapGitlabWatchAnswer({ data: { project: null } })).toBeNull();
  });

  it('a draft MR and one from a fork read as GitHub\'s draft and cross-repository PRs do', () => {
    const raw = answer({ open: [{ iid: 4, head: HEAD }, { iid: 5, head: HEAD2 }, { iid: 6, head: HEAD }] });
    const [a, b, c] = raw.data.project.open.nodes as Array<Record<string, unknown>>;
    Object.assign(a, { draft: true, title: 'Draft: MR 4' });
    Object.assign(b, { sourceProjectId: 8 });
    Object.assign(c, { sourceProjectId: null });
    const m = mapGitlabWatchAnswer(raw);
    expect(m?.snapshot.prs.map((p) => [p.number, p.isDraft, p.isCrossRepository])).toEqual([
      [4, true, false],
      [5, false, true],
      // Unreadable project ids read as a fork, as GitHub's unreadable flag does.
      [6, false, true],
    ]);
  });

  it('asks for the key\'s path as the project under a subfolder install: never stripped again', async () => {
    forge.hosts = { gh: new Set(), glab: new Map([['gitlab.example.com', { name: 'gitlab.example.com', subfolder: 'gitlab' }]]) };
    try {
      const asked: string[] = [];
      const read = gitlabWatchReader({
        graphql: async (_repoPath, _repoKey, _query, vars) => {
          asked.push(vars.fullPath);
          return { ok: true, value: answer({ open: [] }) };
        },
        commitParents: async () => [],
      });
      // The https clone's key already lost the subfolder (parseRemoteKey) ...
      await read('/repo', 'gitlab.example.com/platform/api', undefined);
      // ... and an ssh clone of a project in a real group named `gitlab` keeps it.
      await read('/repo', 'gitlab.example.com/gitlab/platform/api', undefined);
      expect(asked).toEqual(['platform/api', 'gitlab/platform/api']);
    } finally {
      forge.hosts = { gh: new Set(), glab: new Map() };
    }
  });

  it('checks: the head pipeline with every job that may not fail passed; stale, truncated or running is pending', () => {
    expect(gitlabChecksOf({ sha: HEAD, status: 'SUCCESS', jobs: { pageInfo: { hasNextPage: false }, nodes: [{ status: 'SUCCESS', allowFailure: false }, { status: 'FAILED', allowFailure: true }] } }, HEAD)).toEqual({ checks: 'pass' });
    expect(gitlabChecksOf({ sha: HEAD, status: 'FAILED', jobs: { pageInfo: { hasNextPage: false }, nodes: [{ status: 'FAILED', allowFailure: false }] } }, HEAD)).toEqual({ checks: 'fail' });
    expect(gitlabChecksOf({ sha: HEAD, status: 'RUNNING', jobs: { pageInfo: { hasNextPage: false }, nodes: [{ status: 'RUNNING', allowFailure: false }] } }, HEAD)).toEqual({ checks: 'pending' });
    expect(gitlabChecksOf({ sha: HEAD, status: 'SUCCESS', jobs: { pageInfo: { hasNextPage: true }, nodes: [{ status: 'SUCCESS', allowFailure: false }] } }, HEAD)).toEqual({ checks: 'pending' });
    // A pipeline of another commit that is no merged-results one: stale.
    expect(gitlabChecksOf({ sha: HEAD2, status: 'SUCCESS', mergeRequestEventType: 'DETACHED', jobs: { pageInfo: { hasNextPage: false }, nodes: [] } }, HEAD)).toEqual({ checks: 'pending' });
    expect(gitlabChecksOf({ sha: MERGE, status: 'SUCCESS', mergeRequestEventType: 'MERGED_RESULT', jobs: { pageInfo: { hasNextPage: false }, nodes: [] } }, HEAD))
      .toEqual({ checks: 'pending', unconfirmed: { pipelineSha: MERGE, verdict: 'pass' } });
    expect(gitlabChecksOf(null, HEAD)).toEqual({ checks: 'pending' });
  });
});

describe('RepoWatch on a GitLab repo', () => {
  it('ci.green fires once when the head pipeline turns green, never for a stale-head pipeline', async () => {
    let spec: Spec = { open: [{ iid: 1, head: HEAD, pipeline: { sha: HEAD, status: 'RUNNING' } }, { iid: 2, head: HEAD2, pipeline: { sha: HEAD, status: 'RUNNING' } }] };
    const glab = fakeGlab(() => spec);
    const facts = fakeFacts();
    const w = makeWatch(glab, facts);
    await w.start();
    expect((await w.pollNow(KEY))?.baseline).toBe(true);
    expect(glab.calls[0]).toEqual({ query: GITLAB_WATCH_QUERY, vars: { fullPath: 'group/sub/app' } });

    spec = { open: [{ iid: 1, head: HEAD, pipeline: { sha: HEAD, status: 'SUCCESS' } }, { iid: 2, head: HEAD2, pipeline: { sha: HEAD, status: 'SUCCESS' } }] };
    const out = await w.pollNow(KEY);
    expect(out).toMatchObject({ ok: true, calls: 1 });
    expect(kinds(facts)).toEqual(['ci.green:1']);
    expect(facts.appended[0]).toMatchObject({ repoKey: KEY, ref: { pr: 1, headSha: HEAD } });

    await w.pollNow(KEY);
    expect(kinds(facts)).toEqual(['ci.green:1']);
    expect(w.stateOf(KEY)?.prs['2'].checks).toBe('pending');
  });

  it('a merged-results verdict counts once the head is a parent of its commit; a kept verdict needs no read', async () => {
    let spec: Spec = { open: [{ iid: 1, head: HEAD, pipeline: { sha: HEAD, status: 'RUNNING' } }] };
    const glab = fakeGlab(() => spec, { [MERGE]: [TARGET, HEAD] });
    const facts = fakeFacts();
    const w = makeWatch(glab, facts);
    await w.start();
    await w.pollNow(KEY);
    spec = { open: [{ iid: 1, head: HEAD, pipeline: { sha: MERGE, status: 'SUCCESS', type: 'MERGED_RESULT' } }] };
    expect(await w.pollNow(KEY)).toMatchObject({ ok: true, calls: 2 });
    expect(glab.parentReads).toEqual([MERGE]);
    expect(kinds(facts)).toEqual(['ci.green:1']);
    await w.pollNow(KEY);
    expect(glab.parentReads).toEqual([MERGE]);
    expect(kinds(facts)).toEqual(['ci.green:1']);
  });

  it('a baseline records an unconfirmed merged-results verdict as pending, and confirms it later without announcing it', async () => {
    const MERGE2 = 'e'.repeat(40);
    const spec: Spec = { open: [
      { iid: 1, head: HEAD, pipeline: { sha: MERGE, status: 'SUCCESS', type: 'MERGED_RESULT' } },
      { iid: 2, head: HEAD2, pipeline: { sha: MERGE2, status: 'SUCCESS', type: 'MERGED_RESULT' } },
    ] };
    const glab = fakeGlab(() => spec, { [MERGE]: [TARGET, HEAD], [MERGE2]: [TARGET, HEAD2] });
    const facts = fakeFacts();
    const w = makeWatch(glab, facts);
    await w.start();
    // One parent read per poll: MR 1 is confirmed, MR 2 is not, so it is pending.
    expect(await w.pollNow(KEY)).toMatchObject({ ok: true, baseline: true, calls: 2 });
    expect(w.stateOf(KEY)?.prs['1'].checks).toBe('pass');
    expect(w.stateOf(KEY)?.prs['2']).toMatchObject({ checks: 'pending', unconfirmedSha: MERGE2 });
    await w.pollNow(KEY);
    expect(glab.parentReads).toEqual([MERGE, MERGE2]);
    // Green already at the baseline: recorded, not announced.
    expect(w.stateOf(KEY)?.prs['2'].checks).toBe('pass');
    expect(w.stateOf(KEY)?.prs['2'].unconfirmedSha).toBeUndefined();
    expect(facts.appended).toEqual([]);
  });

  it('a failed parent read waits ten polls of its own repo, however many repos are watched', async () => {
    const KEY2 = 'gitlab.example.com/group/other';
    let spec: Spec = { open: [] };
    const glab = fakeGlab(() => spec);
    const w = makeWatch(glab, fakeFacts(), { bots: [bot('bot-00000001'), bot('bot-00000002', KEY2)] });
    await w.start();
    await w.pollNow(KEY);
    await w.pollNow(KEY2);
    spec = { open: [{ iid: 1, head: HEAD, pipeline: { sha: MERGE, status: 'SUCCESS', type: 'MERGED_RESULT' } }] };
    await w.pollNow(KEY);
    expect(glab.parentReads).toEqual([MERGE]);
    // Another repo's polls do not shorten this repo's wait.
    for (let i = 0; i < 12; i++) await w.pollNow(KEY2);
    glab.parentReads.length = 0;
    for (let i = 0; i < 9; i++) await w.pollNow(KEY);
    expect(glab.parentReads).toEqual([]);
    await w.pollNow(KEY);
    expect(glab.parentReads).toEqual([MERGE]);
  });

  it('a commit whose parents never read does not take every poll\'s read', async () => {
    const OTHER_MERGE = 'e'.repeat(40);
    let spec: Spec = { open: [] };
    const glab = fakeGlab(() => spec, { [OTHER_MERGE]: [TARGET, HEAD2] });
    const facts = fakeFacts();
    const w = makeWatch(glab, facts);
    await w.start();
    await w.pollNow(KEY);
    now += 60_000;
    spec = { open: [
      { iid: 1, head: HEAD, pipeline: { sha: MERGE, status: 'SUCCESS', type: 'MERGED_RESULT' } },
      { iid: 2, head: HEAD2, pipeline: { sha: OTHER_MERGE, status: 'SUCCESS', type: 'MERGED_RESULT' } },
    ] };
    await w.pollNow(KEY);
    await w.pollNow(KEY);
    expect(glab.parentReads).toEqual([MERGE, OTHER_MERGE]);
    expect(kinds(facts)).toEqual(['pr.opened:1', 'pr.opened:2', 'ci.green:2']);
  });

  it('a merged-results pipeline whose parents miss the head stays pending, and its parents are read once', async () => {
    let spec: Spec = { open: [{ iid: 1, head: HEAD, pipeline: null }] };
    const glab = fakeGlab(() => spec, { [MERGE]: [TARGET, HEAD2] });
    const facts = fakeFacts();
    const w = makeWatch(glab, facts);
    await w.start();
    await w.pollNow(KEY);
    spec = { open: [{ iid: 1, head: HEAD, pipeline: { sha: MERGE, status: 'SUCCESS', type: 'MERGED_RESULT' } }] };
    await w.pollNow(KEY);
    await w.pollNow(KEY);
    expect(glab.parentReads).toEqual([MERGE]);
    expect(facts.appended).toEqual([]);
  });

  it('MR opened / merged and issue events come out as on GitHub; a locked MR is not closed', async () => {
    let spec: Spec = { open: [{ iid: 1, head: HEAD }] };
    const glab = fakeGlab(() => spec);
    const facts = fakeFacts();
    const w = makeWatch(glab, facts);
    await w.start();
    await w.pollNow(KEY);
    now += 60_000;
    spec = { open: [], locked: [{ iid: 1, head: HEAD }], issues: [{ iid: 9, createdAt: now }] };
    await w.pollNow(KEY);
    expect(kinds(facts)).toEqual(['issue.opened:9']);
    spec = { open: [], merged: [1], issues: [{ iid: 9, createdAt: T0 + 60_000 }] };
    await w.pollNow(KEY);
    expect(kinds(facts)).toEqual(['issue.opened:9', 'pr.merged:1']);
  });

  it('a signed-out glab backs off and is noted once', async () => {
    const glab = fakeGlab(() => ({ ok: false, code: 'unauthenticated', message: 'not signed in' }));
    const log = vi.fn();
    const w = makeWatch(glab, fakeFacts(), { log });
    await w.start();
    expect(await w.pollNow(KEY)).toMatchObject({ ok: false, calls: 1, retryAt: T0 + REPO_WATCH_LIMITS.GITLAB_BACKOFF_MS });
    await w.pollNow(KEY);
    expect(log).toHaveBeenCalledTimes(1);
    // The loop's next poll waits out the backoff, not the usual minute.
    const first = timers.find((t) => t.ms === 0 && !t.cleared);
    first?.fn();
    await vi.waitFor(() => expect(timers.some((t) => t.ms === REPO_WATCH_LIMITS.GITLAB_BACKOFF_MS)).toBe(true), { timeout: 5_000 });
  });

  it('a network blip is an ordinary failure: no backoff, the next poll in a minute', async () => {
    const glab = fakeGlab(() => ({ ok: false, code: 'error', message: 'dial tcp: i/o timeout' }));
    const log = vi.fn();
    const w = makeWatch(glab, fakeFacts(), { log });
    await w.start();
    const out = await w.pollNow(KEY);
    expect(out).toMatchObject({ ok: false, error: 'dial tcp: i/o timeout' });
    expect(out?.retryAt).toBeUndefined();
    timers.find((t) => t.ms === 0 && !t.cleared)?.fn();
    await vi.waitFor(() => expect(glab.calls).toHaveLength(2), { timeout: 5_000 });
    expect(timers.some((t) => t.ms === REPO_WATCH_LIMITS.GITLAB_BACKOFF_MS)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('routes by host: a GitLab key never reaches the gh read, a GitHub key never the glab one', async () => {
    const glab = fakeGlab(() => ({ open: [] }));
    const graphql = vi.fn<WatchGraphql>(async () => ({ ok: false, code: 'error', message: 'offline' }));
    const w = makeWatch(glab, fakeFacts(), { graphql, bots: [bot('bot-00000001'), bot('bot-00000002', 'github.com/acme/app')] });
    await w.start();
    await w.pollNow(KEY);
    await w.pollNow('github.com/acme/app');
    expect(glab.calls.map((c) => c.vars.fullPath)).toEqual(['group/sub/app']);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0][1]).toBe('github.com/acme/app');
  });
});
