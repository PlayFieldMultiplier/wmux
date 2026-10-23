// The receiver side of remote spawn on real folders: the cheap checks and
// the answer, the decision's checks (agent, root, containment, symlinks),
// replay and resend, room, the policy store, and what a result may carry.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { SPAWN_DECIDED_PER_HOST_MAX, SPAWN_REQUEST_KEEP_MS, SPAWN_TARGETS_LINK_ID } from '../../../shared/a2aSpawn';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { acceptInbound, type InboundDeps } from '../inbound';
import { LinkStore } from '../linkStore';
import { linkAlias } from '../outbound';
import { A2aSpawnReceiver, registerSpawnRpc, type SpawnReceiverDeps } from '../spawnReceiver';
import { SpawnPolicyStore, samePath } from '../spawnPolicyStore';
import { SpawnRequestStore } from '../spawnRequestStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const quiet = (): void => undefined;

let dir: string;
let a2aDir: string;
let repo: string;
let policy: SpawnPolicyStore;
let requests: SpawnRequestStore;
let sent: Array<{ hostId: string; env: A2aRemoteEnvelope }>;
let installed: Set<string>;
let receiver: A2aSpawnReceiver;

function makeReceiver(over: Partial<SpawnReceiverDeps> = {}): A2aSpawnReceiver {
  return new A2aSpawnReceiver({
    policy,
    requests,
    enqueue: (hostId, env) => void sent.push({ hostId, env }),
    agentInstalled: async (agent) => installed.has(agent),
    refusalCoalesceMs: 0,
    log: quiet,
    ...over,
  });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-spawn-')));
  a2aDir = path.join(dir, 'a2a');
  repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'apps', 'site'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  policy = new SpawnPolicyStore({ dir: a2aDir, scheduleHarden: quiet });
  requests = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet });
  sent = [];
  installed = new Set(['claude']);
  receiver = makeReceiver();
});
afterEach(() => {
  receiver.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function allowHost(over: Record<string, unknown> = {}): Promise<void> {
  const res = await policy.set({
    v: 1, enabled: true, approval: 'ask', followUps: 'ask', permissionMode: 'auto',
    hosts: { [HOST]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: repo }], agents: ['claude', 'codex'], rules: [],
    version: policy.get().version,
    ...over,
  });
  expect(res.ok).toBe(true);
}

function envelope(over: { spawn?: Record<string, unknown>; sentAt?: number; expiresIn?: number } = {}): A2aRemoteEnvelope {
  const spawnId = (over.spawn?.['spawnId'] as string | undefined) ?? `sp-${crypto.randomUUID()}`;
  const sentAt = over.sentAt ?? Date.now();
  return {
    protocol: A2A_REMOTE_PROTOCOL,
    linkId: spawnId,
    linkVersion: 0,
    messageId: 'req',
    kind: 'link',
    link: { state: 'spawn', version: 0 },
    spawn: {
      v: 1, spawnId, agent: 'claude', folder: { root: 'web' }, text: 'fix the build',
      expiresAt: new Date(sentAt + (over.expiresIn ?? 3600_000)).toISOString(), from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
      ...over.spawn,
    } as A2aRemoteEnvelope['spawn'],
    sentAt: new Date(sentAt).toISOString(),
  };
}

const resultsFor = (env: A2aRemoteEnvelope) => sent.filter((s) => s.env.linkId === env.linkId);

async function decide(env: A2aRemoteEnvelope, hostId = HOST, r = receiver): Promise<string | undefined> {
  const answer = r.applyInbound(env, { hostId });
  expect(answer).toEqual({ ok: true, duplicate: false });
  await r.idle();
  return resultsFor(env)[0]?.env.spawnResult?.code;
}

describe('cheap checks: answered ok, refused with a code', () => {
  it('the feature off and a PC not allowed get the same code, and nothing is kept', async () => {
    expect(await decide(envelope())).toBe('not-allowed');
    await allowHost();
    expect(await decide(envelope(), OTHER)).toBe('not-allowed');
    await allowHost({ enabled: false });
    expect(await decide(envelope())).toBe('not-allowed');
    expect(requests.summaries()).toEqual([]);
  });

  it('B\'s clock: a request sent from the future, or living past 72 h, is refused as expired', async () => {
    await allowHost();
    expect(await decide(envelope({ sentAt: Date.now() + 11 * 60_000 }))).toBe('expired');
    expect(await decide(envelope({ expiresIn: 73 * 3600_000 }))).toBe('expired');
    expect(await decide(envelope({ sentAt: Date.now() - 2 * 3600_000, expiresIn: 3600_000 }))).toBe('expired');
  });

  it('an unreadable body, extra fields, or a linkId that is not the spawnId are bad requests', () => {
    expect(receiver.applyInbound(envelope({ spawn: { env: { PATH: '/tmp' } } }), { hostId: HOST })).toEqual({ ok: false, error: 'bad-request' });
    expect(receiver.applyInbound(envelope({ spawn: { folder: { root: 'web', sub: '../..' } } }), { hostId: HOST })).toEqual({ ok: false, error: 'bad-request' });
    expect(receiver.applyInbound({ ...envelope(), linkId: 'sp-other' }, { hostId: HOST })).toEqual({ ok: false, error: 'bad-request' });
  });

  it('a prompt that is only control characters is unreadable, never stored as an empty prompt', async () => {
    await allowHost();
    expect(receiver.applyInbound(envelope({ spawn: { text: '\u001b[2J\u0007' } }), { hostId: HOST })).toEqual({ ok: false, error: 'bad-request' });
    expect(requests.summaries()).toEqual([]);
  });

  it('refusals of requests that are not stored answer once per code per PC per window', async () => {
    const coalescing = makeReceiver({ refusalCoalesceMs: 60_000 });
    for (let i = 0; i < 5; i++) expect(coalescing.applyInbound(envelope(), { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    expect(sent).toHaveLength(1);
    expect(coalescing.applyInbound(envelope(), { hostId: OTHER })).toEqual({ ok: true, duplicate: false });
    expect(sent).toHaveLength(2);
  });

  it('a refusal that cannot be queued is answered unavailable, so the asker sends it again', () => {
    const full = makeReceiver({ enqueue: () => { throw new Error('outbox full'); } });
    expect(full.applyInbound(envelope(), { hostId: HOST })).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('the decision', () => {
  it('an allowed request in this build is refused as not supported, and its text is not kept', async () => {
    await allowHost();
    const env = envelope({ spawn: { folder: { root: 'web', sub: 'apps/site' } } });
    expect(await decide(env)).toBe('not-supported');
    const stored = JSON.parse(fs.readFileSync(requests.filePath, 'utf8')) as { records: unknown[] };
    expect(stored.records).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('fix the build');
    expect(requests.summaries()[0]).toMatchObject({ hostId: HOST, state: 'decided', code: 'not-supported', rootId: 'web' });
  });

  it('an agent B did not list, and one that is not installed', async () => {
    await allowHost({ agents: ['codex'] });
    expect(await decide(envelope())).toBe('agent-not-allowed');
    await allowHost();
    installed.clear();
    expect(await decide(envelope())).toBe('agent-not-installed');
  });

  it('an unknown root, a missing sub, a symlink that leaves the root, and a file', async () => {
    await allowHost();
    expect(await decide(envelope({ spawn: { folder: { root: 'nope' } } }))).toBe('folder-not-allowed');
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'missing' } } }))).toBe('folder-not-allowed');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, 'escape'), 'dir');
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'escape' } } }))).toBe('folder-not-allowed');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'x');
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'file.txt' } } }))).toBe('folder-not-allowed');
  });

  it('a root replaced by a link elsewhere after it was allowed is refused', async () => {
    await allowHost();
    fs.renameSync(repo, path.join(dir, 'repo-old'));
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, repo, 'dir');
    expect(await decide(envelope())).toBe('folder-not-allowed');
  });

  it('containment compares realpaths as they are: a sibling differing only by case is outside', async () => {
    await allowHost();
    // A filesystem that resolves `Repo` to a different folder than `repo` (a case-sensitive volume).
    const sibling = repo.replace(/repo$/, 'Repo');
    const caseSensitive = makeReceiver({
      realpath: async (p) => (p.endsWith(`${path.sep}linked`) ? sibling : p),
      isDirectory: async () => true,
    });
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'linked' } } }), HOST, caseSensitive)).toBe('folder-not-allowed');
  });

  it('a folder resolved differently after the directory check is refused', async () => {
    await allowHost();
    let n = 0;
    const swapping = makeReceiver({
      realpath: async (p) => (p === repo ? repo : (n++ === 0 ? path.join(repo, 'apps') : path.join(dir, 'outside'))),
      isDirectory: async () => true,
    });
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'apps' } } }), HOST, swapping)).toBe('folder-not-allowed');
  });

  it('a check that never answers ends the request as failed instead of holding its place', async () => {
    await allowHost();
    const stalled = makeReceiver({ agentInstalled: () => new Promise(() => undefined), checkTimeoutMs: 30 });
    expect(await decide(envelope(), HOST, stalled)).toBe('failed');
    expect(requests.pendingCount(HOST)).toBe(0);
  });

  it('an unexpected error keeps the request pending and tries again', async () => {
    await allowHost();
    let calls = 0;
    const flaky = makeReceiver({
      agentInstalled: async () => { calls += 1; if (calls === 1) throw new Error('PATH probe crashed'); return true; },
      retryMinMs: 20,
    });
    const env = envelope();
    expect(flaky.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    await vi.waitFor(() => expect(resultsFor(env)[0]?.env.spawnResult?.code).toBe('not-supported'), { timeout: 5_000 });
    expect(calls).toBe(2);
    flaky.stop();
  });

  it('the policy is read again when deciding: a PC turned off meanwhile is not allowed', async () => {
    await allowHost();
    let release!: (v: boolean) => void;
    const slow = makeReceiver({ agentInstalled: () => new Promise((r) => { release = r; }) });
    const env = envelope();
    // The decision is already waiting on the agent check when this returns.
    expect(slow.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    await allowHost({ enabled: false });
    release(true);
    await slow.idle();
    expect(resultsFor(env)[0]?.env.spawnResult?.code).toBe('not-allowed');
  });

  it('a PC forgotten while its request was decided gets no answer', async () => {
    await allowHost();
    let release!: (v: boolean) => void;
    const slow = makeReceiver({ agentInstalled: () => new Promise((r) => { release = r; }) });
    const env = envelope();
    slow.applyInbound(env, { hostId: HOST });
    requests.forgetHost(HOST);
    release(true);
    await slow.idle();
    expect(resultsFor(env)).toEqual([]);
  });
});

describe('replay, resend and room', () => {
  it('every result is its own message: one id per request and outcome', async () => {
    await allowHost();
    const a = envelope();
    const b = envelope();
    await decide(a);
    await decide(b);
    const ids = sent.map((s) => s.env.messageId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe(`res-${a.linkId}-not-supported`);
  });

  it('a resend gets the stored answer again (the first may have been lost); another body under the same id is a conflict', async () => {
    await allowHost();
    const env = envelope();
    await decide(env);
    // Even with the PC turned off since, the stored outcome is what it gets.
    await allowHost({ enabled: false });
    expect(receiver.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: true });
    expect(resultsFor(env).map((s) => s.env.spawnResult?.code)).toEqual(['not-supported', 'not-supported']);
    const other = envelope({ spawn: { spawnId: env.linkId, text: 'something else' } });
    expect(receiver.applyInbound(other, { hostId: HOST })).toEqual({ ok: false, error: 'conflict' });
  });

  it('a pending request nobody is deciding (after a restart) is decided on its resend; one decided but never sent goes out on recover', async () => {
    await allowHost();
    const env = envelope();
    // Stored pending by a receiver that stopped before deciding.
    requests.receive(HOST, { ...env.spawn! });
    const fresh = makeReceiver();
    expect(fresh.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: true });
    await fresh.idle();
    expect(resultsFor(env)[0]?.env.spawnResult?.code).toBe('not-supported');

    const lost = envelope();
    requests.receive(HOST, { ...lost.spawn! });
    requests.decide(HOST, lost.linkId, 'agent-not-allowed');
    expect(requests.unsent().map((r) => r.spawnId)).toContain(lost.linkId);
    makeReceiver().recover();
    expect(resultsFor(lost)[0]?.env.spawnResult?.code).toBe('agent-not-allowed');
    expect(requests.unsent().map((r) => r.spawnId)).not.toContain(lost.linkId);
  });

  it('at most 3 pending per PC: the next one is refused as rate-limited', async () => {
    await allowHost();
    const hang = makeReceiver({ agentInstalled: () => new Promise(() => undefined), checkTimeoutMs: 60_000 });
    for (let i = 0; i < 3; i++) expect(hang.applyInbound(envelope(), { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    const fourth = envelope();
    expect(hang.applyInbound(fourth, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    expect(resultsFor(fourth)[0]?.env.spawnResult?.code).toBe('rate-limited');
  });

  it('every result carries a code and the spawnId only: no path, errno or message', async () => {
    await allowHost();
    installed.clear();
    await decide(envelope({ spawn: { folder: { root: 'web', sub: 'missing' } } }));
    await decide(envelope(), OTHER);
    for (const { env } of sent) {
      expect(Object.keys(env.spawnResult ?? {}).sort()).toEqual(['code', 'spawnId', 'v']);
      expect(JSON.stringify(env)).not.toContain(dir);
      expect(JSON.stringify(env)).not.toMatch(/ENOENT|EACCES|Error/);
    }
  });
});

describe('SpawnRequestStore', () => {
  const req = (expiresIn = 3600_000) => ({ ...envelope({ expiresIn }).spawn! });

  it('a write that fails leaves nothing behind: no ghost record holding a slot', () => {
    const failing = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet, write: () => { throw new Error('disk full'); } });
    expect(() => failing.receive(HOST, req())).toThrow(/disk full/);
    expect(failing.pendingCount(HOST)).toBe(0);
    expect(failing.summaries()).toEqual([]);
  });

  it('decided records go a day after their decision, whatever expiry the asker chose; one PC cannot fill the store', () => {
    let now = Date.now();
    const store = new SpawnRequestStore({ dir: a2aDir, scheduleHarden: quiet, now: () => now });
    const long = req(72 * 3600_000);
    store.receive(HOST, long);
    store.decide(HOST, long.spawnId, 'not-supported');
    now += SPAWN_REQUEST_KEEP_MS + 1000;
    expect(store.prune()).toBe(1);

    for (let i = 0; i < SPAWN_DECIDED_PER_HOST_MAX; i++) {
      const r = req();
      store.receive(HOST, r);
      store.decide(HOST, r.spawnId, 'not-supported');
    }
    expect(store.receive(HOST, req())).toEqual({ kind: 'full' });
    expect(store.receive(OTHER, req()).kind).toBe('new');
  });
});

describe('as the asker: answers and targets', () => {
  it('an answer nobody here asked for, or one already answered, is not handed on; targets only when newer', () => {
    const got: unknown[] = [];
    const outstanding = new Set<string>();
    const asker = makeReceiver({ isOutstanding: (_h, id) => outstanding.has(id), onResult: (_h, r) => got.push(r), onTargets: (_h, t) => got.push(t) });
    const spawnId = `sp-${crypto.randomUUID()}`;
    const result = (code: string): A2aRemoteEnvelope => ({
      protocol: A2A_REMOTE_PROTOCOL, linkId: spawnId, linkVersion: 0, messageId: `res-${spawnId}-${code}`, kind: 'link',
      link: { state: 'spawn-result', version: 0 }, spawnResult: { v: 1, spawnId, code: code as 'not-supported' }, sentAt: new Date().toISOString(),
    });
    expect(asker.applyInbound(result('not-supported'), { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    expect(got).toEqual([]);
    outstanding.add(spawnId);
    asker.applyInbound(result('not-supported'), { hostId: HOST });
    asker.applyInbound(result('not-supported'), { hostId: HOST });
    expect(got).toHaveLength(1);

    const targets = (version: number): A2aRemoteEnvelope => ({
      protocol: A2A_REMOTE_PROTOCOL, linkId: SPAWN_TARGETS_LINK_ID, linkVersion: 0, messageId: `st-${version}`, kind: 'link',
      link: { state: 'spawn-targets', version: 0 }, spawnTargets: { v: 1, version, roots: [], agents: [] }, sentAt: new Date().toISOString(),
    });
    asker.applyInbound(targets(2), { hostId: HOST });
    asker.applyInbound(targets(1), { hostId: HOST });
    asker.applyInbound(targets(2), { hostId: HOST });
    expect(got).toHaveLength(2);
  });
});

describe('through acceptInbound', () => {
  it('is answered before any link check; an older build without it refuses the unknown link without failing', async () => {
    const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
    log.open();
    const deps: InboundDeps = {
      linkStore: new LinkStore({ dir: path.join(dir, 'links'), scheduleHarden: quiet }),
      taskService: new A2aTaskService({ log, origin: { machineId: 'm', daemonEpoch: 1 } }),
      broadcast: quiet,
      aliasFor: (l) => linkAlias(l, 'pc'),
    };
    expect(await acceptInbound(envelope(), { hostId: HOST }, { ...deps, spawn: receiver })).toEqual({ ok: true, duplicate: false });
    const older = await acceptInbound(envelope(), { hostId: HOST }, deps);
    expect(older.ok).toBe(false);
    log.close();
  });
});

describe('SpawnPolicyStore', () => {
  it('stores each root as its realpath, and refuses a folder that is not a repository\'s top level', async () => {
    const link = path.join(dir, 'repo-link');
    fs.symlinkSync(repo, link, 'dir');
    await allowHost({ roots: [{ id: 'web', label: 'Web', path: link }] });
    expect(policy.get().roots[0].path).toBe(repo);
    for (const p of [path.join(repo, 'apps'), path.join(dir, 'missing'), 'relative/path']) {
      const res = await policy.set({ ...policy.get(), roots: [{ id: 'x', label: 'X', path: p }] });
      expect(res.ok).toBe(false);
    }
    expect(policy.get().roots[0].path).toBe(repo);
  });

  it('a save made from an older read is a conflict, and a PC removed during a save stays removed', async () => {
    await allowHost();
    const read = policy.get();
    await allowHost({ agents: ['claude'] });
    expect(await policy.set({ ...read, agents: ['codex'] })).toMatchObject({ ok: false, conflict: true });

    // The save waits on the folder checks; the PC is removed meanwhile.
    let releaseTop!: () => void;
    const slow = new SpawnPolicyStore({
      dir: a2aDir, scheduleHarden: quiet,
      repoToplevel: (d) => new Promise((r) => { releaseTop = () => r(d); }),
    });
    const pending = slow.set({ ...slow.get(), followUps: 'direct' });
    await vi.waitFor(() => expect(releaseTop).toBeTypeOf('function'), { timeout: 5_000 });
    expect(slow.forgetHost(HOST)).toBe(true);
    releaseTop();
    expect(await pending).toMatchObject({ ok: false, conflict: true });
    expect(slow.get().hosts[HOST]).toBeUndefined();
  });

  it('a removed PC is no longer allowed even when the file cannot be written', async () => {
    await allowHost();
    const lines: string[] = [];
    const broken = new SpawnPolicyStore({ dir: a2aDir, scheduleHarden: quiet, write: () => { throw new Error('read-only'); }, log: (_l, m) => lines.push(m) });
    expect(broken.get().hosts[HOST]).toEqual({ allowed: true });
    expect(broken.forgetHost(HOST)).toBe(true);
    expect(broken.get().hosts[HOST]).toBeUndefined();
    expect(lines.join('\n')).toMatch(/not saved/);
  });

  it('a rule for a folder that is no longer listed is dropped, so a folder added later cannot inherit it', async () => {
    await allowHost({ rules: [{ hostId: HOST, rootId: 'web', agent: 'claude' }] });
    expect(policy.get().rules).toHaveLength(1);
    await allowHost({ roots: [], rules: policy.get().rules });
    expect(policy.get().rules).toEqual([]);
  });

  it('versions every save itself, keeps it across a restart, and a removed PC is forgotten', async () => {
    await allowHost();
    await allowHost();
    expect(policy.get().version).toBe(2);
    const again = new SpawnPolicyStore({ dir: a2aDir, scheduleHarden: quiet });
    expect(again.get().hosts[HOST]).toEqual({ allowed: true });
    expect(again.forgetHost(HOST)).toBe(true);
    expect(again.get().hosts[HOST]).toBeUndefined();
  });

  it('the RPCs read and set it; the requests list has no prompt', async () => {
    const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
    registerSpawnRpc((m, h) => void handlers.set(m, h), { policy, requests });
    expect(await handlers.get('a2a.remote.spawnPolicy.get')!({})).toMatchObject({ policy: { enabled: false } });
    expect(await handlers.get('a2a.remote.spawnPolicy.set')!({ policy: { v: 1 } })).toMatchObject({ ok: false });
    await allowHost();
    await decide(envelope());
    expect(JSON.stringify(await handlers.get('a2a.remote.spawnRequests.list')!({}))).not.toContain('fix the build');
  });

  it('samePath folds case only on Windows', () => {
    expect(samePath('C:\\Repo', 'c:\\repo', 'win32')).toBe(true);
    expect(samePath('/Users/a/Repo', '/Users/a/repo', 'darwin')).toBe(false);
    expect(samePath('/home/a/Repo', '/home/a/repo', 'linux')).toBe(false);
    expect(samePath('/home/a/repo', '/home/a/repo/', 'linux')).toBe(true);
  });
});
