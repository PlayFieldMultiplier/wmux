// The receiving side of continuing a conversation from another PC: each
// refusal and who may hear it, the card, the manifest, status queries, claim
// and start, the sweep, and a restart.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { defaultContinuePolicy, parseContinueRequest, type A2aContinuePolicyV1 } from '../../../shared/a2aContinue';
import { defaultSpawnPolicy, type A2aSpawnPolicyV1 } from '../../../shared/a2aSpawn';
import { A2aContinueReceiver, type ContinueReceiverDeps } from '../continueReceiver';
import { ContinueRequestStore } from '../continueRequestStore';
import { SpawnChecks } from '../spawnChecks';

const HOST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const HEAD = 'a'.repeat(40);
const ORIGIN = 'github.com/acme/widget';
const quiet = (): void => undefined;

let dir: string;
let clock: number;
let requests: ContinueRequestStore;
let continuePolicy: A2aContinuePolicyV1;
let spawn: A2aSpawnPolicyV1;
let origins: Record<string, string | null>;
let free: number;
let live: Set<string>;
let sent: Array<{ hostId: string; env: A2aRemoteEnvelope }>;
let receiver: A2aContinueReceiver;

function makeReceiver(over: Partial<ContinueReceiverDeps> = {}): A2aContinueReceiver {
  return new A2aContinueReceiver({
    policy: { get: () => structuredClone(continuePolicy) },
    spawnPolicy: { get: () => structuredClone(spawn) },
    requests,
    enqueue: (hostId, env) => void sent.push({ hostId, env }),
    originKeyOf: async (p) => origins[p] ?? null,
    freeBytes: async () => free,
    sessionLive: (s) => live.has(s),
    cardAvailable: () => true,
    now: () => clock,
    checks: new SpawnChecks(8),
    resendCoalesceMs: 0,
    log: quiet,
    ...over,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-continue-'));
  clock = Date.parse('2026-10-29T12:00:00.000Z');
  requests = new ContinueRequestStore({ dir, scheduleHarden: quiet, now: () => clock });
  continuePolicy = { ...defaultContinuePolicy(), in: { enabled: true, permissionMode: 'acceptEdits' } };
  spawn = {
    ...defaultSpawnPolicy(), enabled: true, hosts: { [HOST]: { allowed: true } }, agents: ['claude'],
    roots: [{ id: 'web', label: 'Web', path: '/repos/web' }, { id: 'api', label: 'API', path: '/repos/api' }],
  };
  origins = { '/repos/web': ORIGIN, '/repos/api': 'github.com/acme/api' };
  free = 1024 ** 3;
  live = new Set();
  sent = [];
  receiver = makeReceiver();
});
afterEach(() => {
  receiver.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, continueId: `ct-${crypto.randomUUID()}`, sessionId: crypto.randomUUID(), agent: 'claude',
    repo: { origin: ORIGIN, branch: 'main', head: HEAD }, estimate: { bytes: 1024, files: 2 },
    expiresAt: new Date(clock + 3600_000).toISOString(), ...over,
  };
}

function link(state: string, continueId: string, body: Record<string, unknown>): A2aRemoteEnvelope {
  return {
    protocol: A2A_REMOTE_PROTOCOL, linkId: continueId, linkVersion: 0, messageId: 'm1', kind: 'link',
    link: { state, version: 0 } as A2aRemoteEnvelope['link'], ...body, sentAt: new Date(clock).toISOString(),
  } as A2aRemoteEnvelope;
}

const id = (req: Record<string, unknown>): string => req['continueId'] as string;
const manifest = (req: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  v: 1, continueId: id(req), head: HEAD, transcript: { sha256: 'b'.repeat(64), bytes: 600 },
  files: [{ rel: 'tool-results/1.txt', sha256: 'c'.repeat(64), bytes: 400 }], ...over,
});
const codes = (continueId: string, hostId = HOST): Array<string | undefined> =>
  sent.filter((s) => s.hostId === hostId && s.env.linkId === continueId).map((s) => s.env.continueResult?.code);
const state = (req: Record<string, unknown>, hostId = HOST) => requests.get(hostId, id(req))?.state;

async function ask(req: Record<string, unknown>, hostId = HOST, r = receiver): Promise<Array<string | undefined>> {
  r.applyInbound(link('continue', id(req), { continue: req }), { hostId });
  await r.idle();
  return codes(id(req), hostId);
}

async function sendManifest(req: Record<string, unknown>, m: Record<string, unknown> = manifest(req), r = receiver) {
  const answer = await r.applyInbound(link('continue-manifest', id(req), { continueManifest: m }), { hostId: HOST });
  await r.idle();
  return answer;
}

/** A request taken all the way to `received`. */
async function toReceived(req = request()): Promise<Record<string, unknown>> {
  await ask(req);
  expect(receiver.decide(HOST, id(req), 'once')).toEqual({ ok: true });
  await sendManifest(req);
  expect(receiver.received(HOST, id(req))).toEqual({ ok: true });
  return req;
}

describe('a request: who may ask, and what each refusal says', () => {
  it('a PC this PC takes nothing from, an agent not listed, or the feature off: not-allowed, and nothing is kept', async () => {
    expect(await ask(request(), OTHER)).toEqual(['not-allowed']);
    spawn.agents = ['codex'];
    expect(await ask(request())).toEqual(['not-allowed']);
    spawn.agents = ['claude'];
    continuePolicy.in.enabled = false;
    expect(await ask(request())).toEqual(['not-allowed']);
    continuePolicy.in.enabled = true;
    spawn.enabled = false;
    expect(await ask(request())).toEqual(['not-allowed']);
    expect(requests.inState('pending')).toEqual([]);
    expect(requests.unsent()).toEqual([]);
  });

  it('the repository codes go only to a PC the policy allows', async () => {
    const unknownRepo = { origin: 'github.com/acme/other', branch: 'main', head: HEAD };
    expect(await ask(request({ repo: unknownRepo }))).toEqual(['repo-not-found']);
    expect(await ask(request({ repo: unknownRepo }), OTHER)).toEqual(['not-allowed']);
    origins['/repos/api'] = ORIGIN;
    expect(await ask(request())).toEqual(['repo-ambiguous']);
    // Turned off while the roots were read: the PC hears not-allowed, not what this PC holds.
    const flipping = makeReceiver({ originKeyOf: async () => { continuePolicy.in.enabled = false; return null; } });
    expect(await ask(request(), HOST, flipping)).toEqual(['not-allowed']);
  });

  it('B\'s clock: one sent from the future, or living past the longest wait, is refused as expired and not kept', async () => {
    const future = request();
    future['expiresAt'] = new Date(clock + 3600_000).toISOString();
    receiver.applyInbound({ ...link('continue', id(future), { continue: future }), sentAt: new Date(clock + 11 * 60_000).toISOString() }, { hostId: HOST });
    expect(codes(id(future))).toEqual(['expired']);
    expect(await ask(request({ expiresAt: new Date(clock + 25 * 3600_000).toISOString() }))).toEqual(['expired']);
    expect(requests.inState('pending')).toEqual([]);
  });

  it('over this PC\'s caps: too-large; less free disk than the estimate: no-space', async () => {
    const small = makeReceiver({ limits: { bytes: 1000, files: 5 } });
    expect(await ask(request(), HOST, small)).toEqual(['too-large']);
    expect(await ask(request({ estimate: { bytes: 10, files: 6 } }), HOST, small)).toEqual(['too-large']);
    free = 1000;
    expect(await ask(request())).toEqual(['no-space']);
  });

  it('busy: another open request carries the conversation, or a pane here runs it', async () => {
    const first = request();
    expect(await ask(first)).toEqual(['waiting-for-approval']);
    const again = request({ sessionId: first['sessionId'] });
    expect(await ask(again)).toEqual(['busy']);
    expect(state(again)).toBeUndefined();
    const running = request();
    live.add(running['sessionId'] as string);
    expect(await ask(running)).toEqual(['busy']);
    expect(state(running)).toBe('decided');
  });

  it('with no card to show: not-allowed after the checks; a check that fails: failed', async () => {
    expect(await ask(request(), HOST, makeReceiver({ cardAvailable: undefined }))).toEqual(['not-allowed']);
    expect(await ask(request(), HOST, makeReceiver({ freeBytes: async () => { throw new Error('EIO'); } }))).toEqual(['failed']);
  });

  it('the asker is the authenticated peer, never a field of the body; a malformed body is refused', async () => {
    spawn.hosts[OTHER] = { allowed: true };
    const req = request();
    await ask(req);
    expect(await ask({ ...req, sessionId: crypto.randomUUID() }, OTHER)).toEqual(['waiting-for-approval']);
    expect(requests.get(HOST, id(req))?.hostId).toBe(HOST);
    expect(requests.get(OTHER, id(req))?.hostId).toBe(OTHER);
    const bad = (env: A2aRemoteEnvelope) => receiver.applyInbound(env, { hostId: HOST });
    expect(bad(link('continue', id(req), { continue: { ...request(), hostId: OTHER } }))).toEqual({ ok: false, error: 'bad-request' });
    expect(bad(link('continue', `ct-${crypto.randomUUID()}`, { continue: request() }))).toEqual({ ok: false, error: 'bad-request' });
    expect(bad({ ...link('continue', id(req), { continue: req }), linkVersion: 1 })).toEqual({ ok: false, error: 'bad-request' });
    expect(bad(link('continue-status', id(req), { continueStatus: { v: 1 } }))).toEqual({ ok: false, error: 'bad-request' });
  });

  it('a resend is answered from the record; the same id with another body is a conflict', async () => {
    const req = request();
    await ask(req);
    expect(receiver.applyInbound(link('continue', id(req), { continue: req }), { hostId: HOST })).toEqual({ ok: true, duplicate: true });
    expect(codes(id(req))).toEqual(['waiting-for-approval', 'waiting-for-approval']);
    const other = { ...req, estimate: { bytes: 1, files: 0 } };
    expect(receiver.applyInbound(link('continue', id(req), { continue: other }), { hostId: HOST })).toEqual({ ok: false, error: 'conflict' });
  });
});

describe('the card', () => {
  it('once approves (ready); deny declines; always, or anything else, is refused', async () => {
    const req = request();
    await ask(req);
    expect(state(req)).toBe('awaiting');
    expect(receiver.decide(HOST, id(req), 'always')).toMatchObject({ ok: false });
    expect(receiver.decide(HOST, id(req), 'yes')).toMatchObject({ ok: false });
    expect(state(req)).toBe('awaiting');
    expect(receiver.decide(HOST, id(req), 'once')).toEqual({ ok: true });
    expect(codes(id(req))).toEqual(['waiting-for-approval', 'ready']);
    expect(receiver.decide(HOST, id(req), 'once')).toMatchObject({ ok: false });
    const denied = request();
    await ask(denied);
    expect(receiver.decide(HOST, id(denied), 'deny')).toEqual({ ok: true });
    expect(codes(id(denied))).toEqual(['waiting-for-approval', 'declined']);
  });
});

describe('the manifest', () => {
  async function ready(): Promise<Record<string, unknown>> {
    const req = request();
    await ask(req);
    receiver.decide(HOST, id(req), 'once');
    return req;
  }

  it('one taken at another commit: diverged', async () => {
    const req = await ready();
    await sendManifest(req, manifest(req, { head: 'd'.repeat(40) }));
    expect(codes(id(req)).at(-1)).toBe('diverged');
    expect(state(req)).toBe('decided');
  });

  it('its real totals over this PC\'s caps: too-large; over the free disk: no-space', async () => {
    const small = makeReceiver({ limits: { bytes: 1500, files: 5 } });
    const req = request();
    await ask(req, HOST, small);
    small.decide(HOST, id(req), 'once');
    const big = manifest(req, { transcript: { sha256: 'b'.repeat(64), bytes: 1200 } });
    await sendManifest(req, big, small);
    expect(codes(id(req)).at(-1)).toBe('too-large');
    const tight = await ready();
    free = 900;
    await sendManifest(tight);
    expect(codes(id(tight)).at(-1)).toBe('no-space');
  });

  it('a good one is taken (receiving); a resend is a duplicate, another one a conflict', async () => {
    const req = await ready();
    expect(await sendManifest(req)).toEqual({ ok: true, duplicate: false });
    expect(requests.get(HOST, id(req))).toMatchObject({ state: 'receiving', manifest: manifest(req), rootId: 'web' });
    expect(await sendManifest(req)).toEqual({ ok: true, duplicate: true });
    expect(await sendManifest(req, manifest(req, { files: [] }))).toEqual({ ok: false, error: 'conflict' });
    expect(codes(id(req))).toEqual(['waiting-for-approval', 'ready']);
  });

  it('one before approval, or for no request, changes nothing: the asker hears where it is', async () => {
    const req = request();
    await ask(req);
    await sendManifest(req);
    expect(state(req)).toBe('awaiting');
    expect(codes(id(req))).toEqual(['waiting-for-approval', 'waiting-for-approval']);
    const none = request();
    await sendManifest(none);
    expect(codes(id(none))).toEqual(['unknown']);
  });
});

describe('status queries', () => {
  const query = (req: Record<string, unknown>) => {
    sent = [];
    receiver.applyInbound(link('continue-status', id(req), { continueStatus: { v: 1, continueId: id(req) } }), { hostId: HOST });
    return codes(id(req))[0];
  };

  it('answer where the request is in each state, and unknown without one', async () => {
    const req = request();
    expect(query(req)).toBe('unknown');
    receiver.applyInbound(link('continue', id(req), { continue: req }), { hostId: HOST });
    expect(state(req)).toBe('pending');
    expect(query(req)).toBe('waiting-for-approval');
    await receiver.idle();
    expect(query(req)).toBe('waiting-for-approval');
    receiver.decide(HOST, id(req), 'once');
    expect(query(req)).toBe('ready');
    await sendManifest(req);
    expect(query(req)).toBe('ready');
    receiver.received(HOST, id(req));
    expect(query(req)).toBe('received');
    receiver.claim(HOST, id(req));
    expect(state(req)).toBe('starting');
    expect(query(req)).toBe('received');
    receiver.started(HOST, id(req));
    expect(query(req)).toBe('started');
    // Another PC asking about the same id learns nothing of it.
    sent = [];
    receiver.applyInbound(link('continue-status', id(req), { continueStatus: { v: 1, continueId: id(req) } }), { hostId: OTHER });
    expect(codes(id(req), OTHER)).toEqual(['unknown']);
  });
});

describe('claim and start', () => {
  it('only a received request is claimed, once; a started one never starts again', async () => {
    const req = request();
    await ask(req);
    expect(receiver.claim(HOST, id(req))).toMatchObject({ ok: false });
    receiver.decide(HOST, id(req), 'once');
    await sendManifest(req);
    expect(receiver.claim(HOST, id(req))).toMatchObject({ ok: false });
    receiver.received(HOST, id(req));
    const claim = receiver.claim(HOST, id(req));
    expect(claim).toMatchObject({ ok: true, claim: { hostId: HOST, rootId: 'web', rootPath: '/repos/web', permissionMode: 'acceptEdits' } });
    expect(receiver.claim(HOST, id(req))).toMatchObject({ ok: false });
    expect(receiver.started(HOST, id(req))).toEqual({ ok: true });
    expect(receiver.claim(HOST, id(req))).toMatchObject({ ok: false });
    expect(receiver.started(HOST, id(req))).toMatchObject({ ok: false });
    // A resend of the request is answered `started`, and starts nothing.
    expect(await ask(req)).toEqual(['waiting-for-approval', 'ready', 'received', 'started', 'started']);
    expect(state(req)).toBe('decided');
  });

  it('never after the expiry: a claim, or bytes that came late, end it expired', async () => {
    const late = await toReceived();
    clock += 3601_000;
    expect(receiver.claim(HOST, id(late))).toEqual({ ok: false, error: 'expired' });
    expect(codes(id(late)).at(-1)).toBe('expired');
    clock -= 3601_000;
    const slow = request();
    await ask(slow);
    receiver.decide(HOST, id(slow), 'once');
    await sendManifest(slow);
    clock += 3601_000;
    expect(receiver.received(HOST, id(slow))).toEqual({ ok: false, error: 'expired' });
    expect(codes(id(slow)).at(-1)).toBe('expired');
  });

  it('a start that failed, or bytes that did not arrive, end it failed', async () => {
    const req = await toReceived();
    receiver.claim(HOST, id(req));
    expect(receiver.failed(HOST, id(req))).toEqual({ ok: true });
    expect(codes(id(req)).at(-1)).toBe('failed');
    const lost = request();
    await ask(lost);
    receiver.decide(HOST, id(lost), 'once');
    await sendManifest(lost);
    expect(receiver.receiveFailed(HOST, id(lost))).toEqual({ ok: true });
    expect(codes(id(lost)).at(-1)).toBe('failed');
  });
});

describe('the sweep and a restart', () => {
  it('the sweep expires an unclaimed request past its expiry, never a claimed one', async () => {
    const waiting = request();
    await ask(waiting);
    const claimed = await toReceived();
    receiver.claim(HOST, id(claimed));
    clock += 3601_000;
    receiver.sweep();
    expect(codes(id(waiting)).at(-1)).toBe('expired');
    expect(state(claimed)).toBe('starting');
  });

  it('a restart sends what was never queued, checks what was pending, and never starts twice', async () => {
    let outboxUp = false;
    const down = makeReceiver({ enqueue: (hostId, env) => { if (!outboxUp) throw new Error('no outbox'); sent.push({ hostId, env }); } });
    const unsent = request();
    await ask(unsent, HOST, down);
    expect(state(unsent)).toBe('awaiting');
    expect(codes(id(unsent))).toEqual([]);
    const started = await toReceived();
    receiver.claim(HOST, id(started));
    receiver.started(HOST, id(started));
    const starting = await toReceived();
    receiver.claim(HOST, id(starting));
    // Stored, then the daemon stopped before its checks ran.
    const pending = request();
    requests.receive(HOST, parseContinueRequest(pending)!);
    down.stop();
    receiver.stop();

    outboxUp = true;
    requests = new ContinueRequestStore({ dir, scheduleHarden: quiet, now: () => clock });
    const after = makeReceiver();
    after.recover();
    await after.idle();
    expect(codes(id(unsent))).toEqual(['waiting-for-approval']);
    expect(codes(id(pending))).toEqual(['waiting-for-approval']);
    expect(after.claim(HOST, id(started))).toMatchObject({ ok: false });
    expect(after.claim(HOST, id(starting))).toMatchObject({ ok: false });
    expect(state(starting)).toBe('starting');
    after.stop();
  });
});

describe('answers from the other PC', () => {
  it('a continue-result is taken and dropped here; a malformed one is refused', () => {
    const cid = `ct-${crypto.randomUUID()}`;
    expect(receiver.applyInbound(link('continue-result', cid, { continueResult: { v: 1, continueId: cid, code: 'ready' } }), { hostId: HOST }))
      .toEqual({ ok: true, duplicate: false });
    expect(receiver.applyInbound(link('continue-result', cid, { continueResult: { v: 1, continueId: cid, code: 'yes' } }), { hostId: HOST }))
      .toEqual({ ok: false, error: 'bad-request' });
    expect(sent).toEqual([]);
  });
});
