// The receiver side of remote spawn on real folders: the cheap checks and
// the answer, the decision's checks (agent, root, containment, symlinks),
// replay, the policy store, and what a result may carry.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { acceptInbound, type InboundDeps } from '../inbound';
import { LinkStore } from '../linkStore';
import { linkAlias } from '../outbound';
import { A2aSpawnReceiver, registerSpawnRpc } from '../spawnReceiver';
import { SpawnPolicyStore, samePath } from '../spawnPolicyStore';
import { SpawnRequestStore } from '../spawnRequestStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const quiet = (): void => undefined;

let dir: string;
let repo: string;
let policy: SpawnPolicyStore;
let requests: SpawnRequestStore;
let sent: Array<{ hostId: string; env: A2aRemoteEnvelope }>;
let installed: Set<string>;
let receiver: A2aSpawnReceiver;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-spawn-')));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'apps', 'site'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  policy = new SpawnPolicyStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet });
  requests = new SpawnRequestStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet });
  sent = [];
  installed = new Set(['claude']);
  receiver = new A2aSpawnReceiver({
    policy,
    requests,
    enqueue: (hostId, env) => void sent.push({ hostId, env }),
    agentInstalled: async (agent) => installed.has(agent),
    log: quiet,
  });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function allowHost(over: Record<string, unknown> = {}): Promise<void> {
  const res = await policy.set({
    v: 1, enabled: true, approval: 'ask', followUps: 'ask', permissionMode: 'auto',
    hosts: { [HOST]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: repo }], agents: ['claude', 'codex'], rules: [], version: 0,
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

async function decide(env: A2aRemoteEnvelope, hostId = HOST): Promise<string | undefined> {
  const answer = receiver.applyInbound(env, { hostId });
  expect(answer).toEqual({ ok: true, duplicate: false });
  await receiver.idle();
  const result = sent.find((s) => s.env.linkId === env.linkId)?.env.spawnResult;
  return result?.code;
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

  it('an unknown root, a missing sub, and a symlink that leaves the root', async () => {
    await allowHost();
    expect(await decide(envelope({ spawn: { folder: { root: 'nope' } } }))).toBe('folder-not-allowed');
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'missing' } } }))).toBe('folder-not-allowed');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, 'escape'), 'dir');
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'escape' } } }))).toBe('folder-not-allowed');
    // A file is not a folder to work in.
    fs.writeFileSync(path.join(repo, 'file.txt'), 'x');
    expect(await decide(envelope({ spawn: { folder: { root: 'web', sub: 'file.txt' } } }))).toBe('folder-not-allowed');
  });

  it('a root replaced by a link elsewhere after it was allowed is refused', async () => {
    await allowHost();
    const moved = path.join(dir, 'repo-old');
    fs.renameSync(repo, moved);
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, repo, 'dir');
    expect(await decide(envelope())).toBe('folder-not-allowed');
  });

  it('the policy is read again when deciding: a PC turned off meanwhile is not allowed', async () => {
    await allowHost();
    let release!: (v: boolean) => void;
    const slow = new A2aSpawnReceiver({
      policy, requests, enqueue: (hostId, env) => void sent.push({ hostId, env }), log: quiet,
      agentInstalled: () => new Promise((r) => { release = r; }),
    });
    const env = envelope();
    // The decision is already waiting on the agent check when this returns.
    expect(slow.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    await allowHost({ enabled: false });
    release(true);
    await slow.idle();
    expect(sent.find((s) => s.env.linkId === env.linkId)?.env.spawnResult?.code).toBe('not-allowed');
  });
});

describe('replay, room and results', () => {
  it('a resend is a duplicate with no second result; the same id with another body is a conflict', async () => {
    await allowHost();
    const env = envelope();
    await decide(env);
    expect(receiver.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: true });
    await receiver.idle();
    expect(sent.filter((s) => s.env.linkId === env.linkId)).toHaveLength(1);
    const other = envelope({ spawn: { spawnId: env.linkId, text: 'something else' } });
    expect(receiver.applyInbound(other, { hostId: HOST })).toEqual({ ok: false, error: 'conflict' });
  });

  it('at most 3 pending per PC: the next one is refused as rate-limited', async () => {
    await allowHost();
    const hang = new A2aSpawnReceiver({
      policy, requests, enqueue: (hostId, env) => void sent.push({ hostId, env }), log: quiet,
      agentInstalled: () => new Promise(() => undefined),
    });
    for (let i = 0; i < 3; i++) expect(hang.applyInbound(envelope(), { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    const fourth = envelope();
    expect(hang.applyInbound(fourth, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    expect(sent.find((s) => s.env.linkId === fourth.linkId)?.env.spawnResult?.code).toBe('rate-limited');
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
    const env = envelope();
    expect(await acceptInbound(env, { hostId: HOST }, { ...deps, spawn: receiver })).toEqual({ ok: true, duplicate: false });
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

  it('versions every save itself, keeps it across a restart, and a removed PC is forgotten', async () => {
    await allowHost();
    await allowHost();
    expect(policy.get().version).toBe(2);
    const again = new SpawnPolicyStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet });
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

  it('samePath folds case where the file system does', () => {
    expect(samePath('C:\\Repo', 'c:\\repo', 'win32')).toBe(true);
    expect(samePath('/Users/a/Repo', '/users/a/repo', 'darwin')).toBe(true);
    expect(samePath('/home/a/Repo', '/home/a/repo', 'linux')).toBe(false);
  });
});
