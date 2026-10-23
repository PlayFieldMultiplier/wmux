// The receiving PC's start of a remote spawn on real folders: the card (or a
// rule), the expiry of an unanswered card, the claim that checks everything
// again, the caps, the link the start makes (pane shown, prompt queued as its
// first task), what that link means while it lives (no images, follow-ups
// held for their card, redacted text out) and what its end puts back.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { spawnFirstMessageId, spawnLinkId, type A2aSpawnRequestState } from '../../../shared/a2aSpawn';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { ExposureStore } from '../exposureStore';
import { remoteTaskId } from '../ids';
import { acceptInbound, type InboundDeps } from '../inbound';
import { LinkStore } from '../linkStore';
import { linkAlias, syncRemoteTask } from '../outbound';
import { OutboxStore } from '../outboxStore';
import { SpawnChecks } from '../spawnChecks';
import { SpawnLinkStore } from '../spawnLinkStore';
import { SpawnPolicyStore } from '../spawnPolicyStore';
import { A2aSpawnReceiver, type SpawnReceiverDeps } from '../spawnReceiver';
import { SpawnRequestStore } from '../spawnRequestStore';
import { A2aSpawnStarter } from '../spawnStarter';

const HOST = '11111111-1111-4111-8111-111111111111';
const quiet = (): void => undefined;

let dir: string;
let a2aDir: string;
let repo: string;
let policy: SpawnPolicyStore;
let requests: SpawnRequestStore;
let links: LinkStore;
let exposures: ExposureStore;
let tasks: A2aTaskService;
let starter: A2aSpawnStarter;
let sent: Array<{ hostId: string; env: A2aRemoteEnvelope }>;
let changes: Array<{ spawnId: string; state: A2aSpawnRequestState }>;
let ready: boolean;
let clock: number | undefined;
let receiver: A2aSpawnReceiver;

function makeReceiver(over: Partial<SpawnReceiverDeps> = {}): A2aSpawnReceiver {
  return new A2aSpawnReceiver({
    policy,
    requests,
    enqueue: (hostId, env) => void sent.push({ hostId, env }),
    agentInstalled: async () => true,
    checks: new SpawnChecks(8),
    refusalCoalesceMs: 0,
    appReady: () => ready,
    liveSpawns: (h) => starter.liveCount(h),
    onChange: (_h, spawnId, state) => void changes.push({ spawnId, state }),
    hostName: () => 'HOME-A',
    mint: (rec, req, end) => starter.mint(rec, req, end),
    now: () => clock ?? Date.now(),
    log: quiet,
    ...over,
  });
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-spawn-start-')));
  a2aDir = path.join(dir, 'a2a');
  repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'apps', 'site'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const store = { dir: a2aDir, scheduleHarden: quiet };
  policy = new SpawnPolicyStore(store);
  requests = new SpawnRequestStore(store);
  links = new LinkStore({ ...store, onTransition: (l) => starter?.onLinkTransition(l) });
  exposures = new ExposureStore(store);
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: quiet });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'b', daemonEpoch: 1 } });
  starter = new A2aSpawnStarter({
    links, spawnLinks: new SpawnLinkStore(store), exposures, taskService: tasks, policy,
    hostName: () => 'HOME-A', aliasFor: (l) => linkAlias(l, 'HOME-A'), broadcast: quiet, log: quiet,
  });
  sent = [];
  changes = [];
  ready = true;
  clock = undefined;
  receiver = makeReceiver();
});
afterEach(() => {
  receiver.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function allow(over: Record<string, unknown> = {}): Promise<void> {
  const res = await policy.set({
    v: 1, enabled: true, approval: 'ask', followUps: 'ask', permissionMode: 'auto',
    hosts: { [HOST]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: repo }], agents: ['claude', 'codex'], rules: [],
    version: policy.get().version,
    ...over,
  });
  expect(res.ok).toBe(true);
}

function request(over: { spawn?: Record<string, unknown>; expiresIn?: number } = {}): A2aRemoteEnvelope {
  const spawnId = `sp-${crypto.randomUUID()}`;
  const now = Date.now();
  return {
    protocol: A2A_REMOTE_PROTOCOL, linkId: spawnId, linkVersion: 0, messageId: 'req', kind: 'link',
    link: { state: 'spawn', version: 0 },
    spawn: {
      v: 1, spawnId, agent: 'claude', folder: { root: 'web', sub: 'apps' }, text: 'fix the build\nthen run the tests',
      expiresAt: new Date(now + (over.expiresIn ?? 3600_000)).toISOString(), from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
      ...over.spawn,
    } as A2aRemoteEnvelope['spawn'],
    sentAt: new Date(now).toISOString(),
  };
}

const codes = (env: A2aRemoteEnvelope): Array<string | undefined> =>
  sent.filter((s) => s.env.linkId === env.linkId).map((s) => s.env.spawnResult?.code);
const stateOf = (env: A2aRemoteEnvelope): string | undefined => requests.get(HOST, env.linkId)?.state;

async function arrive(env: A2aRemoteEnvelope, r = receiver): Promise<void> {
  expect(r.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
  await r.idle();
}

/** Through the card, the claim and a pane, to a linked agent. */
async function startOne(env: A2aRemoteEnvelope, pane = 'pane-new'): Promise<void> {
  await arrive(env);
  expect(await receiver.decideCard(HOST, env.linkId, 'once')).toEqual({ ok: true });
  expect(await receiver.claim(HOST, env.linkId)).toMatchObject({ ok: true });
  expect(await receiver.started(HOST, env.linkId, { workspaceId: `ws-${pane}`, paneId: pane })).toEqual({ ok: true });
}

describe('the card', () => {
  it('an allowed request waits for its card and says so; Allow once, the claim and the start link it and queue the prompt', async () => {
    await allow();
    const env = request();
    await arrive(env);
    expect(stateOf(env)).toBe('awaiting');
    expect(codes(env)).toEqual(['waiting-for-approval']);
    expect(changes).toEqual([{ spawnId: env.linkId, state: 'awaiting' }]);
    expect(receiver.work().awaiting).toEqual([expect.objectContaining({
      hostName: 'HOME-A', agent: 'claude', folder: path.join(repo, 'apps'), permissionMode: 'auto', followUps: 'ask',
      text: 'fix the build\nthen run the tests',
    })]);

    expect(await receiver.decideCard(HOST, env.linkId, 'once')).toEqual({ ok: true });
    expect(receiver.work().approved).toEqual([{ hostId: HOST, spawnId: env.linkId }]);
    expect(await receiver.claim(HOST, env.linkId)).toEqual({
      ok: true,
      claim: { hostId: HOST, hostName: 'HOME-A', spawnId: env.linkId, agent: 'claude', repoPath: repo, sub: 'apps', permissionMode: 'auto' },
    });
    // A second claim of the same start is refused: it is starting already.
    expect(await receiver.claim(HOST, env.linkId)).toMatchObject({ ok: false });

    expect(await receiver.started(HOST, env.linkId, { workspaceId: 'ws-new', paneId: 'pane-new' })).toEqual({ ok: true });
    const linkId = spawnLinkId(env.linkId);
    expect(sent.at(-1)!.env.spawnResult).toEqual({
      v: 1, spawnId: env.linkId, code: 'started', endpoint: { kind: 'pane', workspaceId: 'ws-new', paneId: 'pane-new' }, linkVersion: 1,
    });
    expect(links.get(linkId)).toMatchObject({
      state: 'active', version: 1, proposer: 'remote', allow: { inbound: true, outbound: false },
      local: { kind: 'pane', workspaceId: 'ws-new', paneId: 'pane-new' },
      remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
    });
    expect(exposures.isPaneExposed(HOST, 'ws-new', 'pane-new')).toBe(true);
    const first = tasks.getTask(remoteTaskId(linkId, spawnFirstMessageId(env.linkId)))!;
    expect(first.history[0].parts).toEqual([{ kind: 'text', text: 'fix the build\nthen run the tests' }]);
    expect(first.metadata.remote).toMatchObject({ linkId, direction: 'inbound', delivered: false });
    expect(first.metadata.remote).not.toHaveProperty('held');
    // Decided: the outcome is kept, the prompt is not.
    expect(requests.get(HOST, env.linkId)).toMatchObject({ state: 'decided', code: 'started' });
    expect(requests.get(HOST, env.linkId)).not.toHaveProperty('request');
  });

  it('Deny ends it declined; a card nobody answers ends expired at the request\'s expiry', async () => {
    await allow();
    const denied = request();
    await arrive(denied);
    expect(await receiver.decideCard(HOST, denied.linkId, 'deny')).toEqual({ ok: true });
    expect(codes(denied)).toEqual(['waiting-for-approval', 'declined']);

    const late = request({ expiresIn: 60_000 });
    await arrive(late);
    clock = Date.now() + 61_000;
    receiver.sweep();
    expect(codes(late)).toEqual(['waiting-for-approval', 'expired']);
    expect(receiver.work().awaiting).toEqual([]);
  });

  it('allow-list: a matching rule skips the card, another asks; Always adds the rule', async () => {
    await allow({ approval: 'allow-list', rules: [{ hostId: HOST, rootId: 'web', agent: 'claude' }] });
    const ruled = request();
    await arrive(ruled);
    expect(stateOf(ruled)).toBe('approved');
    expect(codes(ruled)).toEqual([]);
    expect(changes).toEqual([{ spawnId: ruled.linkId, state: 'approved' }]);

    const other = request({ spawn: { agent: 'codex' } });
    await arrive(other);
    expect(stateOf(other)).toBe('awaiting');
    expect(await receiver.decideCard(HOST, other.linkId, 'always')).toEqual({ ok: true });
    expect(policy.get().rules).toContainEqual({ hostId: HOST, rootId: 'web', agent: 'codex' });
    expect(stateOf(other)).toBe('approved');
  });

  it('in ask mode a rule does not skip the card', async () => {
    await allow({ rules: [{ hostId: HOST, rootId: 'web', agent: 'claude' }] });
    const env = request();
    await arrive(env);
    expect(stateOf(env)).toBe('awaiting');
  });
});

describe('right before the start', () => {
  it.skipIf(process.platform === 'win32')('a folder swapped for a link outside between the card and the start is refused', async () => {
    await allow();
    const env = request();
    await arrive(env);
    await receiver.decideCard(HOST, env.linkId, 'once');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(repo, 'apps'), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, 'apps'));
    expect(await receiver.claim(HOST, env.linkId)).toMatchObject({ ok: false, code: 'folder-not-allowed' });
    expect(codes(env)).toEqual(['waiting-for-approval', 'folder-not-allowed']);
  });

  it('a PC turned off after its card was answered is not started', async () => {
    await allow();
    const env = request();
    await arrive(env);
    await receiver.decideCard(HOST, env.linkId, 'once');
    await allow({ enabled: false });
    expect(await receiver.claim(HOST, env.linkId)).toMatchObject({ ok: false, code: 'not-allowed' });
  });

  it('a start main had claimed when the daemon stopped ends failed on recovery, never a second pane', async () => {
    await allow();
    const env = request();
    await arrive(env);
    await receiver.decideCard(HOST, env.linkId, 'once');
    await receiver.claim(HOST, env.linkId);
    makeReceiver().recover();
    expect(codes(env)).toEqual(['waiting-for-approval', 'failed']);
  });

  it('the app not ready: the request waits for it, and ends app-not-ready at its expiry', async () => {
    await allow();
    ready = false;
    const waiting = makeReceiver({ retryMinMs: 20 });
    const env = request({ expiresIn: 400 });
    expect(waiting.applyInbound(env, { hostId: HOST })).toEqual({ ok: true, duplicate: false });
    await waiting.idle();
    expect(stateOf(env)).toBe('pending');
    await vi.waitFor(() => expect(codes(env)).toEqual(['app-not-ready']), { timeout: 5_000 });
    waiting.stop();
  });
});

describe('room', () => {
  it('two agents running per PC: a third is refused rate-limited; three starts an hour, then rate-limited', async () => {
    await allow();
    await startOne(request(), 'p1');
    await startOne(request(), 'p2');
    const third = request();
    await arrive(third);
    expect(codes(third)).toEqual(['rate-limited']);

    // Ended links free the running slots, but not the hourly count.
    for (const l of links.list()) links.revoke(l.linkId, 'local');
    await startOne(request(), 'p3');
    links.revoke(spawnLinkId(sent.at(-1)!.env.linkId), 'local');
    const fourth = request();
    await arrive(fourth);
    expect(codes(fourth)).toEqual(['rate-limited']);
  });
});

describe('the link a start made', () => {
  function inboundDeps(): InboundDeps {
    return { linkStore: links, taskService: tasks, broadcast: quiet, aliasFor: (l) => linkAlias(l, 'HOME-A'), spawnLinks: starter };
  }
  function task(linkId: string, over: Partial<A2aRemoteEnvelope> = {}): A2aRemoteEnvelope {
    return {
      protocol: A2A_REMOTE_PROTOCOL, linkId, linkVersion: 1, messageId: crypto.randomUUID(), kind: 'task',
      text: 'now also update the docs', sentAt: new Date().toISOString(), ...over,
    };
  }

  it('carries no images; a later task waits for its card in ask mode and not in direct mode', async () => {
    await allow();
    const env = request();
    await startOne(env);
    const linkId = spawnLinkId(env.linkId);
    const image = { sha256: 'a'.repeat(64), bytes: 10, mediaType: 'image/png' as const, name: 'x.png' };
    expect(await acceptInbound(task(linkId, { images: [image] }), { hostId: HOST }, inboundDeps())).toMatchObject({ ok: false, error: 'bad-request' });

    const asked = task(linkId);
    expect(await acceptInbound(asked, { hostId: HOST }, inboundDeps())).toMatchObject({ ok: true });
    expect(tasks.getTask(remoteTaskId(linkId, asked.messageId))!.metadata.remote).toMatchObject({ held: 'awaiting-approval' });
    expect(starter.followUpCards()).toEqual([expect.objectContaining({
      taskId: remoteTaskId(linkId, asked.messageId), hostName: 'HOME-A', agent: 'claude', folder: path.join(repo, 'apps'), text: 'now also update the docs',
    })]);
    expect(tasks.listRemotePending().map((t) => t.id)).not.toContain(remoteTaskId(linkId, asked.messageId));

    await allow({ followUps: 'direct' });
    const direct = task(linkId);
    await acceptInbound(direct, { hostId: HOST }, inboundDeps());
    expect(tasks.getTask(remoteTaskId(linkId, direct.messageId))!.metadata.remote).not.toHaveProperty('held');
  });

  it('what leaves on it is redacted: the state message and the evidence', async () => {
    await allow();
    const env = request();
    await startOne(env);
    const linkId = spawnLinkId(env.linkId);
    const taskId = remoteTaskId(linkId, spawnFirstMessageId(env.linkId));
    const key = `ghp_${'a1B2'.repeat(9)}`;
    await tasks.markRemote({ taskId, delivered: true });
    expect((await tasks.transition({ taskId, to: 'working', callerWorkspaceId: 'ws-pane-new' })).ok).toBe(true);
    expect((await tasks.transition({
      taskId, to: 'completed', callerWorkspaceId: 'ws-pane-new',
      evidence: { summary: `pushed with ${key}`, items: [{ kind: 'command', status: 'passed', command: `git push https://x:${key}@example.com`, summary: 'pushed', output: key }] },
      message: { kind: 'message', messageId: 'st-1', role: 'agent', parts: [{ kind: 'text', text: `done, the token was ${key}` }] },
    })).ok).toBe(true);
    const outbox = new OutboxStore({ dir: a2aDir, scheduleHarden: quiet });
    expect(await syncRemoteTask({ linkStore: links, taskService: tasks, outbox, spawnLink: (id) => starter.isSpawnLink(id) }, taskId)).toMatchObject({ ok: true });
    const out = JSON.stringify(outbox.pending(HOST).map((r) => r.envelope));
    expect(out).toContain('completed');
    expect(out).not.toContain(key);
    expect(out).toContain('[redacted]');
  });

  it('when it ends, the pane it showed is hidden again; a pane shown before stays shown', async () => {
    await allow();
    const env = request();
    await startOne(env, 'pane-x');
    links.revoke(spawnLinkId(env.linkId), 'local');
    expect(exposures.isPaneExposed(HOST, 'ws-pane-x', 'pane-x')).toBe(false);
    expect(starter.isSpawnLink(spawnLinkId(env.linkId))).toBe(false);

    exposures.addPane(HOST, 'ws-pane-y', 'pane-y');
    const shown = request();
    await startOne(shown, 'pane-y');
    links.revoke(spawnLinkId(shown.linkId), 'local');
    expect(exposures.isPaneExposed(HOST, 'ws-pane-y', 'pane-y')).toBe(true);
  });
});
