// An approved act no try of which started has a bounded life (#2742): a try
// whose reads keep failing gives itself back (its count stays 0), so the
// sweep would run it forever. A day after the decision it is refused
// `approval-stale` before a try is claimed: nothing is read or sent, the
// outcome card and the bot say why, and the phone reads the code and its
// sentence. A row that may have reached GitHub (claimed with a try counted,
// uncertain, or a release with its draft journaled) is left to its read.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotBinding, BotProfile } from '../../../shared/bot';
import { APPROVAL_UNDO_MS } from '../../../shared/botApproval';
import type { GhActAnswer } from '../../github/GhActService';
import { APPROVAL_LIMITS, ApprovalService, type ApprovalActHost, type ApprovalPorts } from '../approvals';
import { RoomWriter } from '../roomWriter';
import { ActEffectStore, actEffectId } from '../actEffectStore';
import { ActExecutor, readIssue, readLogin, readPull, readRepo, RECONCILE_AFTER_MS } from '../actExecutor';
import { readReleaseAsk } from '../releaseAct';
import { laneRefusalSentence } from '../laneRefusalText';
import { FakeGithub } from './fakeGithubActs';

const WS = 'ws-1';
const HEAD = 'a'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);
const DAY = APPROVAL_LIMITS.APPROVED_TTL_MS;
const SENTENCE = 'The approval is more than a day old and nothing was done: the bot asks again if it is still wanted';

const DEV: BotProfile = {
  version: 1, id: 'bot-0000abcd', workspaceId: WS, role: 'lead', name: 'Bot dev', engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { maxTurnsPerDay: 9, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 } as BotProfile['budget'],
  repo: { repoKey: 'o/r', repoPath: '/repo' }, enabled: true, createdAt: 0, updatedAt: 0,
};
const binding: BotBinding = { workspaceId: WS, botId: DEV.id, role: 'lead' };

const COMMENT = { action: 'comment', prNumber: 1, reason: 'the fix is in', body: 'Fixed in this PR.' };
const RELEASE = { action: 'release', tagName: 'v1.2.3', reason: 'ship 1.2.3', title: 'wmux 1.2.3', notes: 'Fixes.' };

/** A read GitHub did not answer (no HTTP status): the try is given back. */
const READ_FAILS: GhActAnswer = { ok: false, kind: 'error', message: 'gh: timeout' };

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-act-stale-'));
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** PR #1 at HEAD; a default branch `main` at C1, C2, C3, green, with
 *  package.json at 1.2.3 and no tag workflow (a release publishes a draft). */
function rig() {
  const gh = new FakeGithub();
  gh.addPull(1, HEAD);
  gh.history = [C1, C2, C3];
  for (const c of [C1, C2, C3]) gh.checkRuns.set(c, [{ status: 'completed', conclusion: 'success' }]);
  gh.files.set('package.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
  const writer = new RoomWriter({ dir: path.join(dir, 'rooms') });
  const effects = new ActEffectStore(path.join(dir, 'factory', 'act-effects.json'));
  let svc: ApprovalService | null = null;
  const executor = new ActExecutor({
    effects,
    gh,
    approval: { request: (id) => svc?.get(id) ?? null, authorize: (e) => (svc ? svc.authorizeAct(e) : 'approval-not-running') },
    emit: (e) => svc?.onActEffect(e),
  });
  const host: ApprovalActHost = {
    login: () => readLogin(gh, 'github.com'),
    repo: (k) => readRepo(gh, k),
    issue: (k, n) => readIssue(gh, k, n),
    pull: (k, n) => readPull(gh, k, n),
    release: (k, input) => readReleaseAsk(gh, k, input),
    enqueue: (r) => (r.act && r.payloadHash ? effects.enqueue({ requestId: r.requestId, action: r.act.kind, repoKey: r.repoKey, payloadHash: r.payloadHash }) : null),
    run: (id) => executor.run(id),
    effect: (id) => effects.get(id),
    remove: (id) => effects.remove(id),
  };
  const notices: string[] = [];
  const ports: ApprovalPorts = {
    file: path.join(dir, 'factory', 'approvals.json'),
    bots: () => ({ listEnabled: () => [DEV], get: (id) => (id === DEV.id ? DEV : null) }),
    runningWake: () => ({ wakeId: 'w-1', attempt: 1, threadId: null, tainted: false, guest: false, signedIn: false }),
    readPr: async () => { throw new Error('not used'); },
    ghLogin: async () => 'owner',
    rooms: () => writer,
    merge: () => null,
    acts: () => host,
    notice: (n) => notices.push(n.title),
    now: () => Date.now(),
    log: () => undefined,
  };
  svc = new ApprovalService(ports);
  const service = svc;
  /** Ask, approve from the card, and let the Undo window pass (`before`:
   *  after the request's own reads, before the first try); the decision's
   *  time. */
  const approved = async (params: Record<string, unknown>, before?: () => void) => {
    const res = await service.request(binding, params);
    if (!res.ok) throw new Error(`refused: ${res.code} ${res.message}`);
    expect(service.decide({ requestId: res.request.requestId, decision: 'approve', payloadHash: res.request.payloadHash }, 'desktop')).toMatchObject({ ok: true });
    const decidedAt = service.get(res.request.requestId)?.decidedAt as number;
    before?.();
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await executor.idle();
    return { requestId: res.request.requestId, id: actEffectId(res.request.requestId), decidedAt };
  };
  /** The sweep at a given time. */
  const sweepAt = async (at: number) => {
    vi.setSystemTime(at);
    await executor.reconcileAll();
  };
  const outcome = (requestId: string) => writer.read(WS, {}).cards.find((c) => c.clientPostId === `approval-outcome:${requestId}`);
  return { svc: service, gh, effects, executor, notices, approved, sweepAt, outcome };
}

describe('an approved act no try of which started', () => {
  it('whose reads keep failing is tried until a day after its approval, then refused approval-stale with nothing read or sent', async () => {
    const r = rig();
    const a = await r.approved(COMMENT, () => { r.gh.answerRead = () => READ_FAILS; });
    // The #2742 case: the failed read gave the try back, so the count is 0.
    expect(r.effects.get(a.id)).toMatchObject({ status: 'pending', attempt: 0, reason: 'read-failed' });
    expect(r.gh.reads.length).toBeGreaterThan(0);

    // Just under a day: still approved, still tried.
    let reads = r.gh.reads.length;
    await r.sweepAt(a.decidedAt + DAY - 1);
    expect(r.gh.reads.length).toBeGreaterThan(reads);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'pending', attempt: 0, reason: 'read-failed' });
    expect(r.svc.get(a.requestId)?.state).toBe('approved');
    expect(r.outcome(a.requestId)).toBeUndefined();

    // A day: refused before a try is claimed; GitHub is neither read nor written.
    reads = r.gh.reads.length;
    await r.sweepAt(a.decidedAt + DAY);
    expect(r.gh.reads).toHaveLength(reads);
    expect(r.gh.writes).toEqual([]);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'refused', attempt: 0, reason: 'approval-stale' });
    expect(r.svc.get(a.requestId)).toMatchObject({ state: 'refused', refusal: 'approval-stale' });

    // The card, the phone's view and the bot say why, in words.
    expect(r.outcome(a.requestId)).toMatchObject({ kind: 'refusal', title: `Not done: Comment on PR #1 (${SENTENCE})` });
    expect(r.svc.listForOperator(WS).find((v) => v.requestId === a.requestId)).toMatchObject({ state: 'refused', refusal: 'approval-stale', refusalText: SENTENCE });
    expect(r.notices).toContain(`Not done: Comment on PR #1 (${SENTENCE}).`);

    // Ended: a later sweep does nothing more.
    await r.sweepAt(a.decidedAt + DAY + RECONCILE_AFTER_MS);
    expect(r.gh.reads).toHaveLength(reads);
    expect(r.gh.writes).toEqual([]);
  });

  it('is aged out by the gate only while no try of its row started', async () => {
    const r = rig();
    const a = await r.approved(COMMENT, () => { r.gh.answerRead = () => READ_FAILS; });
    const row = r.effects.get(a.id);
    if (!row) throw new Error('no row');
    vi.setSystemTime(a.decidedAt + DAY - 1);
    expect(r.svc.authorizeAct(row)).toBeNull();
    vi.setSystemTime(a.decidedAt + DAY);
    expect(r.svc.authorizeAct(row)).toBe('approval-stale');
    // A row that may have reached GitHub is its read's to settle.
    expect(r.svc.authorizeAct({ ...row, attempt: 1 })).toBeNull();
    expect(r.svc.authorizeAct({ ...row, draftId: 7 })).toBeNull();
    expect(r.svc.authorizeAct({ ...row, status: 'uncertain' })).toBeNull();
    expect(r.svc.authorizeAct({ ...row, status: 'inFlight', attempt: 1 })).toBeNull();
  });
});

describe('an approved act whose try started is not aged out', () => {
  it('a row an earlier try left claimed (attempt 1) whose reads before the write keep failing', async () => {
    const r = rig();
    // The first write timed out and did not land: uncertain.
    r.gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'timeout' }, landed: false };
    const a = await r.approved(COMMENT);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'uncertain', attempt: 1 });
    // The read finds nothing (pending at attempt 1), then the next try's
    // identity read fails and gives that try back.
    r.gh.answerRead = (e) => (e === 'user' ? READ_FAILS : null);
    await r.sweepAt(a.decidedAt + APPROVAL_UNDO_MS + RECONCILE_AFTER_MS + 1_000);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'pending', attempt: 1, reason: 'read-failed' });
    await r.sweepAt(a.decidedAt + DAY + 3600_000);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'pending', attempt: 1, reason: 'read-failed' });
    expect(r.svc.get(a.requestId)?.state).toBe('approved');
    expect(r.gh.writes).toHaveLength(1);
  });

  it('an uncertain row whose read cannot say', async () => {
    const r = rig();
    r.gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'timeout' }, landed: false };
    const a = await r.approved(COMMENT);
    r.gh.answerRead = () => READ_FAILS;
    await r.sweepAt(a.decidedAt + DAY + 3600_000);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'uncertain', attempt: 1 });
    expect(r.svc.get(a.requestId)?.state).toBe('approved');
  });

  it('a release whose draft is journaled, even with its try given back (attempt 0)', async () => {
    const r = rig();
    // The publish was rate limited: the draft is on GitHub and journaled.
    let first = true;
    r.gh.onWrite = (w) => {
      if (w.method !== 'PATCH' || !first) return;
      first = false;
      r.gh.nextWrite = { answer: { ok: false, kind: 'rate-limited', message: 'GitHub rate limit' }, landed: false };
    };
    const a = await r.approved(RELEASE);
    r.gh.onWrite = null;
    const draftId = r.gh.releases[0]?.id;
    expect(draftId).toBeDefined();
    expect(r.effects.get(a.id)).toMatchObject({ status: 'pending', attempt: 0, draftId });
    r.gh.answerRead = () => READ_FAILS;
    await r.sweepAt(a.decidedAt + DAY + 3600_000);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'pending', attempt: 0, draftId });
    expect(r.svc.get(a.requestId)?.state).toBe('approved');
    // The draft stays: nothing deleted it.
    expect(r.gh.writes.map((w) => w.method)).toEqual(['POST', 'PATCH']);
    expect(r.gh.releases.map((x) => x.id)).toEqual([draftId]);
  });
});

describe('the approval-stale sentence', () => {
  it('is the owner\'s words for the code', () => {
    expect(laneRefusalSentence('approval-stale')).toBe(SENTENCE);
  });
});
