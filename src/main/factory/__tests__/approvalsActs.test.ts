// Acts the owner approves and main carries out on GitHub (a comment, a new
// issue, closing an issue or a PR): the request pins what it acts on, the
// card shows the text the post sends (its payloadHash recomputable from the
// card's fences), only a card button echoing that hash approves a text act,
// and after the Undo window the act outbox runs it once, under the same
// gates as a merge.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotBinding, BotProfile } from '../../../shared/bot';
import { ACT_ACTIONS, APPROVAL_UNDO_MS } from '../../../shared/botApproval';
import type { GhActAnswer } from '../../github/GhActService';
import { ApprovalService, type ApprovalActHost, type ApprovalPorts, type ApprovalWake } from '../approvals';
import { RoomWriter } from '../roomWriter';
import { ActEffectStore, actEffectId } from '../actEffectStore';
import { ActExecutor, readIssue, readLogin, readPull, readRepo, RECONCILE_AFTER_MS } from '../actExecutor';
import { actMarker } from '../actPayload';
import { FakeGithub, type FakeIssue } from './fakeGithubActs';
import { handlePhoneBotApprovalCommand } from '../../phone/PhoneBotApprovals';
import { PHONE_APPROVAL_ACTIONS, PHONE_BOT_APPROVAL_COMMAND, PHONE_BOT_APPROVAL_DECIDE_COMMAND, parsePhoneBotApproval } from '../../../shared/phoneBotApprovals';

const WS = 'ws-1';
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);

const bot = (id: string): BotProfile => ({
  version: 1, id, workspaceId: WS, role: 'lead', name: `Bot ${id}`, engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { maxTurnsPerDay: 9, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 } as BotProfile['budget'],
  repo: { repoKey: 'o/r', repoPath: '/repo' }, enabled: true, createdAt: 0, updatedAt: 0,
});
const DEV = bot('bot-0000abcd');
const binding = (b: BotProfile): BotBinding => ({ workspaceId: b.workspaceId, botId: b.id, role: 'lead' });

/** The fenced blocks of a Markdown text, scanned the way CommonMark reads
 *  them: an opening run of 3+ backticks or tildes (up to 3 spaces in), its
 *  info string's first word, and the lines up to a closing run of the same
 *  character at least as long. */
function fences(md: string): Array<{ info: string; text: string }> {
  const lines = md.split('\n');
  const out: Array<{ info: string; text: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) continue;
    const run = open[1];
    if (run[0] === '`' && open[2].includes('`')) continue;
    const close = new RegExp(`^ {0,3}${run[0] === '`' ? '`' : '~'}{${run.length},}[ \\t]*$`);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !close.test(lines[j]); j += 1) body.push(lines[j]);
    out.push({ info: open[2].trim().split(/\s+/)[0] ?? '', text: body.join('\n') });
    i = j;
  }
  return out;
}

/** payloadHash as the phone recomputes it from the card. */
function hashFromCard(md: string): string {
  const payload = fences(md).filter((f) => f.info === 'wmux-payload').map((f) => f.text);
  return createHash('sha256').update(payload.join('\u0000'), 'utf8').digest('hex');
}

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-acts-'));
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function rig(opts: { wake?: Partial<ApprovalWake>; ports?: Partial<ApprovalPorts>; actsUp?: boolean } = {}) {
  const base = fs.mkdtempSync(path.join(dir, 'rig-'));
  const gh = new FakeGithub();
  gh.addPull(1, HEAD);
  gh.addIssue(3);
  const writer = new RoomWriter({ dir: path.join(base, 'rooms') });
  const wakes = new Map<string, ApprovalWake>([[DEV.id, { wakeId: 'w-1', attempt: 1, threadId: null, tainted: false, guest: false, signedIn: false, ...opts.wake }]]);
  const effects = new ActEffectStore(path.join(base, 'factory', 'act-effects.json'));
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
    enqueue: (r) => (r.act && r.payloadHash ? effects.enqueue({ requestId: r.requestId, action: r.act.kind, repoKey: r.repoKey, payloadHash: r.payloadHash }) : null),
    run: (id) => executor.run(id),
    effect: (id) => effects.get(id),
    remove: (id) => effects.remove(id),
  };
  const notices: string[] = [];
  const ports: ApprovalPorts = {
    file: path.join(base, 'factory', 'approvals.json'),
    bots: () => ({ listEnabled: () => [DEV], get: (id) => (id === DEV.id ? DEV : null) }),
    runningWake: (id) => wakes.get(id) ?? null,
    readPr: async () => { throw new Error('not used'); },
    ghLogin: async () => 'owner',
    rooms: () => writer,
    merge: () => null,
    acts: () => (opts.actsUp === false ? null : host),
    notice: (n) => notices.push(n.title),
    now: () => Date.now(),
    log: () => undefined,
    ...opts.ports,
  };
  svc = new ApprovalService(ports);
  const ask = async (params: Record<string, unknown>) => {
    const res = await (svc as ApprovalService).request(binding(DEV), params);
    if (!res.ok) throw new Error(`refused: ${res.code} ${res.message}`);
    return res.request;
  };
  const approve = (requestId: string, extra: Record<string, unknown> = {}) => (svc as ApprovalService).decide({ requestId, decision: 'approve', ...extra }, 'desktop');
  const cardBody = (cardId: string | undefined) => writer.get(WS, cardId as string)?.body ?? '';
  return { base, svc: svc as ApprovalService, gh, writer, effects, executor, ports, notices, ask, approve, cardBody, wakes };
}

const COMMENT = { action: 'comment', prNumber: 1, reason: 'the fix is in', body: 'Fixed in this PR.\n\n```ts\nconst a = 1;\n```\n~~~~ and ```` runs' };

describe('a comment the owner approves', () => {
  it('is posted once after the Undo window, as the owner, with exactly the text the card showed', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    const body = r.cardBody(req.cardId);
    expect(body).toContain('Approve to post this comment on PR #1 as @owner');
    expect(req.payloadHash).toBe(hashFromCard(body));
    expect(r.approve(req.requestId, { payloadHash: hashFromCard(body), source: 'card' })).toMatchObject({ ok: true, request: { state: 'approved' } });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS - 1);
    expect(r.gh.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    await r.executor.idle();
    expect(r.gh.writes).toEqual([{ method: 'POST', endpoint: 'repos/o/r/issues/1/comments', body: { body: `${COMMENT.body}\n\n${actMarker(req.requestId)}` } }]);
    const done = r.svc.get(req.requestId);
    expect(done).toMatchObject({ state: 'executed', result: { url: expect.stringMatching(/^https:\/\/github.com\/o\/r\/issues\/1#issuecomment-/) } });
    const outcome = r.writer.read(WS, {}).cards.find((c) => c.clientPostId === `approval-outcome:${req.requestId}`);
    expect(outcome).toMatchObject({ kind: 'status', title: 'Commented on PR #1 (approved by you)' });
    expect(r.notices.some((t) => t.startsWith('Done: Comment on PR #1'))).toBe(true);
    // Run again (a sweep, a retry): nothing more is sent.
    await r.executor.reconcileAll();
    expect(r.gh.writes).toHaveLength(1);
  });

  it('the card fences each payload field longer than any backtick or tilde run in it, at column 0, and the hash is recomputable', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    const body = r.cardBody(req.cardId);
    const blocks = fences(body);
    // The PR's GitHub title is context (`text`), not payload.
    expect(blocks.map((b) => b.info)).toEqual(['text', 'wmux-payload']);
    expect(blocks[0].text).toBe('pr 1');
    expect(blocks[1].text).toBe(`${COMMENT.body}\n\n${actMarker(req.requestId)}`);
    expect(body).toContain('\n`````wmux-payload\n');
    const issue = await r.ask({ action: 'issue_create', reason: 'file it', title: 'Crash on ~~~ start', body: 'Steps:\n```\nrun\n```' });
    const ib = r.cardBody(issue.cardId);
    expect(fences(ib).filter((f) => f.info === 'wmux-payload').map((f) => f.text)).toEqual(['Crash on ~~~ start', `Steps:\n\`\`\`\nrun\n\`\`\`\n\n${actMarker(issue.requestId)}`]);
    expect(issue.payloadHash).toBe(hashFromCard(ib));
  });

  it('a text act is approved only by a card button echoing the card\'s hash: not without it, not with another, not by the chip or typed words', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    expect(r.approve(req.requestId)).toMatchObject({ ok: false, code: 'client_update_required' });
    expect(r.approve(req.requestId, { payloadHash: 'f'.repeat(64) })).toMatchObject({ ok: false, code: 'changed' });
    expect(r.approve(req.requestId, { payloadHash: req.payloadHash, source: 'chip' })).toMatchObject({ ok: false, code: 'not_here' });
    const said = r.writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: 'ok', threadId: req.threadId, refs: { botId: DEV.id } });
    if (!said.ok) throw new Error('post failed');
    expect(r.svc.onOwnerCard(said.card)).toEqual([]);
    expect(r.svc.get(req.requestId)?.state).toBe('pending');
    // The phone: an old app (no hash) is told to update; the view carries the hash.
    const view = handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_COMMAND, { requestId: req.requestId }, () => r.svc);
    expect(view).toMatchObject({ request: { action: 'comment', payloadHash: req.payloadHash } });
    expect(handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_DECIDE_COMMAND, { requestId: req.requestId, decision: 'approve' }, () => r.svc))
      .toEqual({ refused: { code: 'client_update_required', message: expect.any(String) } });
    expect(handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_DECIDE_COMMAND, { requestId: req.requestId, decision: 'approve', payloadHash: req.payloadHash }, () => r.svc))
      .toMatchObject({ request: { state: 'approved' } });
  });

  it('Undo inside the window sends nothing; once the row is claimed it is too late', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS - 1000);
    expect(r.svc.decide({ requestId: req.requestId, decision: 'undo' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'pending' } });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS * 3);
    await r.executor.idle();
    expect(r.gh.writes).toEqual([]);
    // Approved again: the window starts over, and the write is sent once.
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    let undo: unknown = null;
    r.gh.onRead = (e) => {
      if (e === 'user' && undo === null) undo = r.svc.decide({ requestId: req.requestId, decision: 'undo' }, 'desktop');
    };
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(undo).toMatchObject({ ok: false, code: 'too_late' });
    expect(r.gh.writes).toHaveLength(1);
  });

  it('a request not approved when the executor asks gives its try back: nothing written, the row waits, a later approval runs once', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.gh.writes).toHaveLength(1);
    // A second request whose approval is taken back between claim and authorize.
    const two = await r.ask({ ...COMMENT, body: 'Another note.' });
    const row = r.effects.enqueue({ requestId: two.requestId, action: 'comment', repoKey: 'github.com/o/r', payloadHash: two.payloadHash as string });
    await r.executor.run(row?.id as string);
    expect(r.effects.get(actEffectId(two.requestId))).toMatchObject({ status: 'pending', attempt: 0, reason: 'approval-not-approved' });
    expect(r.gh.writes).toHaveLength(1);
    r.approve(two.requestId, { payloadHash: two.payloadHash });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.gh.writes).toHaveLength(2);
    expect(r.svc.get(two.requestId)?.state).toBe('executed');
  });

  it('a write whose answer is not the comment as approved is uncertain, never done; a read settles it later without a second POST', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    // GitHub took it, but the answer is not the shape (another login).
    r.gh.nextWrite = { answer: { ok: true, value: { id: 1, html_url: 'https://github.com/x', user: { login: 'someone-else' }, body: 'x' } }, landed: true };
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.effects.get(actEffectId(req.requestId))).toMatchObject({ status: 'uncertain', reason: 'unexpected-response' });
    expect(r.svc.get(req.requestId)?.state).toBe('approved');
    expect(r.svc.listForOperator(WS).find((v) => v.requestId === req.requestId)?.actStatus).toBe('uncertain');
    // Too soon: nothing read or sent.
    await r.executor.reconcileAll();
    expect(r.gh.writes).toHaveLength(1);
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    await r.executor.reconcileAll();
    expect(r.gh.writes).toHaveLength(1);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'executed' });
  });

  it('a timeout that did not land: the read finds nothing, and the one retry sends it once', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    r.gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'timeout' }, landed: false };
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.effects.get(actEffectId(req.requestId))?.status).toBe('uncertain');
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    await r.executor.reconcileAll();
    expect(r.gh.writes).toHaveLength(2);
    expect(r.gh.comments).toHaveLength(1);
    expect(r.svc.get(req.requestId)?.state).toBe('executed');
  });

  it('a post with this request\'s marker but other text is found-different: refused, nothing sent again', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    r.gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'timeout' }, landed: false };
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    r.gh.comments.push({ id: 7, issue: 1, body: `edited\n\n${actMarker(req.requestId)}`, user: { login: 'owner' }, html_url: 'https://github.com/o/r/issues/1#c7' });
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    await r.executor.reconcileAll();
    expect(r.gh.writes).toHaveLength(1);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'found-different' });
  });

  it('a PR whose head moved since the request is refused head-moved; a changed login refuses before any write', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    r.gh.pulls.set(1, { head: HEAD2, merged: false });
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'head-moved' });
    const r2 = rig();
    const req2 = await r2.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    r2.gh.login = 'someone-else';
    r2.approve(req2.requestId, { payloadHash: req2.payloadHash });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r2.executor.idle();
    expect(r2.svc.get(req2.requestId)).toMatchObject({ state: 'refused', refusal: 'identity-changed' });
    expect(r2.gh.writes).toEqual([]);
  });

  it('a bot directory that cannot be read gives the try back; a bot moved to another repository is refused', async () => {
    let directory: 'up' | 'throws' | 'moved' = 'up';
    const r = rig({
      ports: {
        bots: () => {
          if (directory === 'throws') throw new Error('directory unreadable');
          const profile = directory === 'moved' ? { ...DEV, repo: { repoKey: 'o/other', repoPath: '/other' } } : DEV;
          return { listEnabled: () => [profile], get: (id: string) => (id === DEV.id ? profile : null) };
        },
      },
    });
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    directory = 'throws';
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.effects.get(actEffectId(req.requestId))).toMatchObject({ status: 'pending', attempt: 0, reason: 'bots-unreadable' });
    expect(r.svc.get(req.requestId)?.state).toBe('approved');
    expect(r.gh.writes).toEqual([]);
    directory = 'moved';
    await r.executor.reconcileAll();
    await r.executor.run(actEffectId(req.requestId));
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'repo-changed' });
    expect(r.gh.writes).toEqual([]);
  });

  it('a renamed or moved repository is refused repo-changed before any write', async () => {
    const r = rig();
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    r.gh.repo = { full_name: 'o/renamed', node_id: 'R_1', id: 4242 };
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'repo-changed' });
    expect(r.gh.writes).toEqual([]);
    // Same name, another numeric id: a repository made again under that name.
    const again = rig();
    const two = await again.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    expect(again.svc.get(two.requestId)?.actRepo).toEqual({ fullName: 'o/r', nodeId: 'R_1', id: 4242 });
    again.gh.repo = { full_name: 'o/r', node_id: 'R_1', id: 9999 };
    again.approve(two.requestId, { payloadHash: two.payloadHash });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await again.executor.idle();
    expect(again.svc.get(two.requestId)).toMatchObject({ state: 'refused', refusal: 'repo-changed' });
    expect(again.gh.writes).toEqual([]);
  });
});

describe('the other acts', () => {
  it('an approved issue_create opens one issue with the card\'s title and body', async () => {
    const r = rig();
    const req = await r.ask({ action: 'issue_create', reason: 'file it', title: 'Crash on start', body: 'Steps to reproduce.' });
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.gh.writes).toEqual([{ method: 'POST', endpoint: 'repos/o/r/issues', body: { title: 'Crash on start', body: `Steps to reproduce.\n\n${actMarker(req.requestId)}` } }]);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'executed', result: { number: expect.any(Number) } });
  });

  it('issue_close and pr_close: typed words may approve them; each closes once', async () => {
    const r = rig();
    const close = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed by #1', stateReason: 'not_planned' });
    expect(r.cardBody(close.cardId)).toContain('Approve to close issue #3 as not planned as @owner');
    const said = r.writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: 'ok', threadId: close.threadId, refs: { botId: DEV.id } });
    if (!said.ok) throw new Error('post failed');
    expect(r.svc.onOwnerCard(said.card)).toEqual([close.requestId]);
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.gh.writes).toEqual([{ method: 'PATCH', endpoint: 'repos/o/r/issues/3', body: { state: 'closed', state_reason: 'not_planned' } }]);
    expect(r.svc.get(close.requestId)?.state).toBe('executed');
    const pr = await r.ask({ action: 'pr_close', prNumber: 1, reason: 'superseded' });
    expect(pr).toMatchObject({ action: 'pr_close', headSha: HEAD });
    r.approve(pr.requestId, { source: 'chip', payloadHash: pr.payloadHash });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.gh.writes.at(-1)).toEqual({ method: 'PATCH', endpoint: 'repos/o/r/pulls/1', body: { state: 'closed' } });
    expect(r.svc.get(pr.requestId)?.state).toBe('executed');
  });

  it('a close is approved only with its payloadHash, the empty text\'s: an older phone app sending none is refused and nothing runs', async () => {
    const r = rig();
    const close = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    expect(close.payloadHash).toBe(createHash('sha256').update('', 'utf8').digest('hex'));
    expect(handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_DECIDE_COMMAND, { requestId: close.requestId, decision: 'approve' }, () => r.svc))
      .toEqual({ refused: { code: 'client_update_required', message: expect.any(String) } });
    expect(r.approve(close.requestId, { source: 'chip' })).toMatchObject({ ok: false, code: 'client_update_required' });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.svc.get(close.requestId)?.state).toBe('pending');
    expect(r.effects.get(actEffectId(close.requestId))).toBeNull();
    expect(r.gh.writes).toEqual([]);
    expect(handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_DECIDE_COMMAND, { requestId: close.requestId, decision: 'approve', payloadHash: close.payloadHash }, () => r.svc))
      .toMatchObject({ request: { state: 'approved' } });
  });

  it('an issue someone else closed first is refused already-closed, nothing written', async () => {
    const r = rig();
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    (r.gh.issues.get(3) as { state: string }).state = 'closed';
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'already-closed' });
    expect(r.gh.writes).toEqual([]);
  });
});

describe('asking for an act', () => {
  it('refuses text that cannot be shown as it is posted, a marker of its own, a guest\'s turn, GitLab, and a reused key with other text', async () => {
    const r = rig();
    await expect(r.ask({ ...COMMENT, body: 'hidden \u202e text' })).rejects.toThrow(/bidi/);
    await expect(r.ask({ ...COMMENT, body: 'see <!-- WMUX-APPROVAL:apr-xxxxxxxxx -->' })).rejects.toThrow(/wmux-approval/);
    await expect(r.ask({ ...COMMENT, clientRequestId: 'k1' })).resolves.toMatchObject({ state: 'pending' });
    await expect(r.ask({ ...COMMENT, body: 'other', clientRequestId: 'k1' })).rejects.toThrow(/clientRequestId/);
    // The same content while it waits is the same request.
    const again = await r.svc.request(binding(DEV), { ...COMMENT, clientRequestId: 'k2' });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    await expect(r.ask({ action: 'issue_close', prNumber: 1, reason: 'x' })).rejects.toThrow(/issueNumber/);
    await expect(r.ask({ action: 'comment', issueNumber: 1, reason: 'x', body: 'y' })).rejects.toThrow(/pull request: name it with prNumber/);
    await expect(r.ask({ action: 'push_default', reason: 'x' })).rejects.toThrow(/no executor/);
    const guest = rig({ wake: { guest: true } });
    await expect(guest.ask(COMMENT)).rejects.toThrow(/not_now/);
    const gitlab = rig({ ports: { bots: () => ({ listEnabled: () => [], get: () => ({ ...DEV, repo: { repoKey: 'gitlab.com/o/r', repoPath: '/repo' } }) }) } });
    await expect(gitlab.ask(COMMENT)).rejects.toThrow(/GitHub only/);
  });

  it('a conversation holding a signed-in task\'s data says so on the card', async () => {
    const r = rig({ wake: { signedIn: true } });
    const req = await r.ask(COMMENT);
    expect(r.cardBody(req.cardId)).toContain('holds data from a task you signed in to');
  });
});

describe('restarts', () => {
  it('an approved act whose row was never claimed waits for the owner again; one that may have run stays approved and is settled by a read, never sent twice', async () => {
    const r = rig();
    const waiting = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    const sent = await r.ask(COMMENT);
    r.approve(waiting.requestId);
    r.approve(sent.requestId, { payloadHash: sent.payloadHash });
    // The comment's try was journaled and landed, then the app quit.
    r.gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'killed' }, landed: true };
    r.svc.stop();
    vi.setSystemTime(Date.now() + APPROVAL_UNDO_MS + 1);
    r.effects.enqueue({ requestId: sent.requestId, action: 'comment', repoKey: 'github.com/o/r', payloadHash: sent.payloadHash as string });
    await r.executor.run(actEffectId(sent.requestId));
    expect(r.gh.writes).toHaveLength(1);
    // Next start: a fresh store and outbox over the same files.
    const effects = new ActEffectStore(path.join(r.base, 'factory', 'act-effects.json'));
    let svc: ApprovalService | null = null;
    const executor = new ActExecutor({
      effects, gh: r.gh,
      approval: { request: (id) => svc?.get(id) ?? null, authorize: (e) => (svc ? svc.authorizeAct(e) : 'approval-not-running') },
      emit: (e) => svc?.onActEffect(e),
    });
    svc = new ApprovalService({ ...r.ports, acts: () => ({
      login: async () => 'owner', repo: (k) => readRepo(r.gh, k), issue: (k, n) => readIssue(r.gh, k, n), pull: (k, n) => readPull(r.gh, k, n),
      enqueue: (q) => (q.act ? effects.enqueue({ requestId: q.requestId, action: q.act.kind, repoKey: q.repoKey, payloadHash: q.payloadHash as string }) : null),
      run: (id) => executor.run(id), effect: (id) => effects.get(id), remove: (id) => effects.remove(id),
    }) });
    svc.resume();
    expect(svc.get(waiting.requestId)?.state).toBe('pending');
    expect(svc.get(sent.requestId)?.state).toBe('approved');
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    await executor.reconcileAll();
    expect(r.gh.writes).toHaveLength(1);
    expect(svc.get(sent.requestId)?.state).toBe('executed');
  });

  it('a comment request an older build stored (no act) stays recorded only', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    const file = path.join(r.base, 'factory', 'approvals.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { requests: Array<Record<string, unknown>> };
    for (const q of raw.requests) {
      delete q.act;
      delete q.payloadHash;
      delete q.actRepo;
      delete q.contentKey;
    }
    fs.writeFileSync(file, JSON.stringify(raw));
    const older = new ApprovalService(r.ports);
    expect(older.decide({ requestId: req.requestId, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'approved' } });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS * 3);
    expect(r.gh.writes).toEqual([]);
    expect(older.get(req.requestId)?.state).toBe('approved');
  });
});

/** Make every write of the act outbox's file fail until the returned undo runs. */
function failOutboxWrites(): () => void {
  const realWrite = fsDefault.writeFileSync;
  const spy = vi.spyOn(fsDefault, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof file === 'string' && path.basename(file).startsWith('act-effects')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return (realWrite as (...a: unknown[]) => void)(file, ...rest);
  }) as typeof fsDefault.writeFileSync);
  return () => spy.mockRestore();
}

/** A try that timed out without landing, left uncertain. */
async function timedOut(r: ReturnType<typeof rig>, requestId: string, payloadHash: string | undefined): Promise<void> {
  r.approve(requestId, { payloadHash });
  r.gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'timeout' }, landed: false };
  await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
  await r.executor.idle();
  expect(r.effects.get(actEffectId(requestId))?.status).toBe('uncertain');
}

describe('reading GitHub around a try', () => {
  it('a login that cannot be read now gives the try back; only a 401 refuses it as identity-unknown', async () => {
    const r = rig();
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    const id = actEffectId(req.requestId);
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    let answer: GhActAnswer = { ok: false, kind: 'rate-limited', message: 'GitHub rate limit' };
    r.gh.answerRead = (e) => (e === 'user' ? answer : null);
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.effects.get(id)).toMatchObject({ status: 'pending', attempt: 0, reason: 'read-failed' });
    for (const transient of [
      { ok: false, kind: 'error', message: 'gh: Server Error (HTTP 502)' },
      { ok: false, kind: 'unsent', message: 'gh could not be started (ENOENT)' },
    ] as GhActAnswer[]) {
      answer = transient;
      await r.executor.reconcileAll();
      expect(r.effects.get(id)).toMatchObject({ status: 'pending', attempt: 0, reason: 'read-failed' });
      expect(r.svc.get(req.requestId)?.state).toBe('approved');
    }
    answer = { ok: false, kind: 'http', status: 401, message: 'gh: Bad credentials (HTTP 401)' };
    await r.executor.reconcileAll();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'identity-unknown' });
    expect(r.gh.writes).toEqual([]);
  });

  it('a reconcile reads every page since the try: a post past the first hundred is found, and an incomplete listing sends nothing', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    for (let i = 0; i < 120; i += 1) r.gh.comments.push({ id: 1000 + i, issue: 1, body: `note ${i}`, user: { login: 'someone' }, html_url: `https://github.com/o/r/issues/1#c${i}` });
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    r.gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'timeout' }, landed: true };
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.effects.get(actEffectId(req.requestId))?.status).toBe('uncertain');
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    // The second page cannot be read: the listing says nothing, nothing is sent.
    r.gh.answerRead = (e) => (/[?&]page=2(&|$)/.test(e) ? { ok: false, kind: 'error', message: 'gh: Server Error (HTTP 502)' } : null);
    await r.executor.reconcileAll();
    expect(r.gh.writes).toHaveLength(1);
    expect(r.effects.get(actEffectId(req.requestId))?.status).toBe('uncertain');
    r.gh.answerRead = null;
    await r.executor.reconcileAll();
    expect(r.gh.writes).toHaveLength(1);
    expect(r.gh.comments.filter((c) => c.body.includes(actMarker(req.requestId)))).toHaveLength(1);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'executed' });
  });

  it('a comment is not posted on an issue closed since the request, nor on a PR closed or merged since', async () => {
    const r = rig();
    const onIssue = await r.ask({ action: 'comment', issueNumber: 3, reason: 'note', body: 'A note.' });
    r.approve(onIssue.requestId, { payloadHash: onIssue.payloadHash });
    (r.gh.issues.get(3) as FakeIssue).state = 'closed';
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.svc.get(onIssue.requestId)).toMatchObject({ state: 'refused', refusal: 'already-closed' });
    expect(r.gh.writes).toEqual([]);
    for (const merged of [true, false]) {
      const p = rig();
      const onPr = await p.ask(COMMENT);
      p.approve(onPr.requestId, { payloadHash: onPr.payloadHash });
      (p.gh.issues.get(1) as FakeIssue).state = 'closed';
      p.gh.pulls.set(1, { head: HEAD, merged });
      await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
      await p.executor.idle();
      expect(p.svc.get(onPr.requestId)).toMatchObject({ state: 'refused', refusal: merged ? 'merged' : 'already-closed' });
      expect(p.gh.writes).toEqual([]);
    }
  });

  it('a close found on a reconcile is done only when it is this try: its reason, its head, who closed it and when', async () => {
    // Closed by the owner's login, with another reason than the one approved.
    const r = rig();
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed', stateReason: 'not_planned' });
    await timedOut(r, req.requestId, req.payloadHash);
    Object.assign(r.gh.issues.get(3) as FakeIssue, { state: 'closed', closed_by: { login: 'owner' }, closed_at: new Date(Date.now()).toISOString(), state_reason: 'completed' });
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    await r.executor.reconcileAll();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'closed-differently' });
    expect(r.gh.writes).toHaveLength(1);
    // A PR closed by the owner's login at another head than the card's.
    const p = rig();
    const pr = await p.ask({ action: 'pr_close', prNumber: 1, reason: 'superseded' });
    await timedOut(p, pr.requestId, pr.payloadHash);
    Object.assign(p.gh.issues.get(1) as FakeIssue, { state: 'closed', closed_by: { login: 'owner' }, closed_at: new Date(Date.now()).toISOString() });
    p.gh.pulls.set(1, { head: HEAD2, merged: false });
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    await p.executor.reconcileAll();
    expect(p.svc.get(pr.requestId)).toMatchObject({ state: 'refused', refusal: 'head-moved' });
    expect(p.gh.writes).toHaveLength(1);
    // GitHub names nobody: done only when it closed after the first try started.
    for (const after of [false, true]) {
      const n = rig();
      const q = await n.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
      await timedOut(n, q.requestId, q.payloadHash);
      const started = n.effects.get(actEffectId(q.requestId))?.firstStartedAt as number;
      Object.assign(n.gh.issues.get(3) as FakeIssue, { state: 'closed', closed_by: null, closed_at: new Date(started + (after ? 1_000 : -1_000)).toISOString(), state_reason: 'completed' });
      vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
      await n.executor.reconcileAll();
      expect(n.svc.get(q.requestId)).toMatchObject(after ? { state: 'executed' } : { state: 'refused', refusal: 'closed-by-other' });
      expect(n.gh.writes).toHaveLength(1);
    }
  });
});

describe('rows that may have run', () => {
  it('a row tried once is claimed: Undo is too late, a restart keeps the approval, an expiry keeps the row', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    r.svc.stop();
    const id = actEffectId(req.requestId);
    // A try that may have landed, then a read that found nothing; the app
    // quit before the next claim.
    r.effects.enqueue({ requestId: req.requestId, action: 'comment', repoKey: 'github.com/o/r', payloadHash: req.payloadHash as string });
    r.effects.claim(id);
    r.effects.finish(id, 'uncertain', 'write-error');
    r.effects.settle(id, 'pending', 'not-found');
    expect(r.effects.get(id)).toMatchObject({ status: 'pending', attempt: 1 });
    expect(r.svc.decide({ requestId: req.requestId, decision: 'undo' }, 'desktop')).toMatchObject({ ok: false, code: 'too_late' });
    const again = new ApprovalService(r.ports);
    again.resume();
    expect(again.get(req.requestId)?.state).toBe('approved');
    r.effects.remove(id);
    expect(r.effects.get(id)).toMatchObject({ status: 'pending', attempt: 1 });
  });

  it('a restart that hands an unclaimed approval back to the owner drops its row', async () => {
    const r = rig();
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    r.svc.stop();
    r.effects.enqueue({ requestId: req.requestId, action: 'issue_close', repoKey: 'github.com/o/r', payloadHash: req.payloadHash as string });
    const again = new ApprovalService(r.ports);
    again.resume();
    expect(again.get(req.requestId)?.state).toBe('pending');
    expect(r.effects.get(actEffectId(req.requestId))).toBeNull();
  });

  it('the sweep settles a waiting row whose request can never run again', async () => {
    let directory: 'up' | 'throws' | 'moved' = 'up';
    const r = rig({
      ports: {
        bots: () => {
          if (directory === 'throws') throw new Error('directory unreadable');
          const profile = directory === 'moved' ? { ...DEV, repo: { repoKey: 'o/other', repoPath: '/other' } } : DEV;
          return { listEnabled: () => [profile], get: (id: string) => (id === DEV.id ? profile : null) };
        },
      },
    });
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    directory = 'throws';
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.effects.get(actEffectId(req.requestId))).toMatchObject({ status: 'pending', reason: 'bots-unreadable' });
    directory = 'moved';
    await r.executor.reconcileAll();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'repo-changed' });
    expect(r.gh.writes).toEqual([]);
  });

  it('a row whose request is gone is dropped, a claimed one only once its read window passed; a store not up keeps both', async () => {
    const r = rig();
    const req = await r.ask(COMMENT);
    const waiting = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    await timedOut(r, req.requestId, req.payloadHash);
    r.effects.enqueue({ requestId: waiting.requestId, action: 'issue_close', repoKey: 'github.com/o/r', payloadHash: waiting.payloadHash as string });
    const lines: string[] = [];
    let answer = 'approval-not-running';
    const orphans = new ActExecutor({ effects: r.effects, gh: r.gh, approval: { request: () => null, authorize: () => answer }, log: (l) => lines.push(l) });
    await orphans.reconcileAll();
    expect(r.effects.get(actEffectId(waiting.requestId))).not.toBeNull();
    answer = 'approval-missing';
    await orphans.reconcileAll();
    expect(r.effects.get(actEffectId(waiting.requestId))).toBeNull();
    expect(r.effects.get(actEffectId(req.requestId))?.status).toBe('uncertain');
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    answer = 'approval-not-running';
    await orphans.reconcileAll();
    expect(r.effects.get(actEffectId(req.requestId))?.status).toBe('uncertain');
    answer = 'approval-missing';
    await orphans.reconcileAll();
    expect(r.effects.get(actEffectId(req.requestId))).toBeNull();
    expect(lines.some((l) => l.includes(req.requestId) && l.includes('dropped'))).toBe(true);
    expect(r.gh.writes).toHaveLength(1);
  });

  it('a try given back whose journal fails is uncertain in memory, and a later read settles it', async () => {
    const r = rig();
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    let undo: (() => void) | null = null;
    r.gh.answerRead = (e) => {
      if (e !== 'repos/o/r' || undo) return null;
      undo = failOutboxWrites();
      return { ok: false, kind: 'rate-limited', message: 'GitHub rate limit' };
    };
    try {
      await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
      await r.executor.idle();
    } finally {
      (undo as (() => void) | null)?.();
    }
    expect(r.effects.get(actEffectId(req.requestId))).toMatchObject({ status: 'uncertain', reason: 'write-failed' });
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    await r.executor.reconcileAll();
    expect(r.gh.writes).toHaveLength(1);
    expect(r.svc.get(req.requestId)?.state).toBe('executed');
  });

  it('an approval whose act could not be put in the outbox waits for the owner again', async () => {
    const r = rig();
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    const undo = failOutboxWrites();
    try {
      await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
      await r.executor.idle();
    } finally {
      undo();
    }
    expect(r.svc.get(req.requestId)?.state).toBe('pending');
    expect(r.effects.get(actEffectId(req.requestId))).toBeNull();
    expect(r.gh.writes).toEqual([]);
    r.approve(req.requestId, { payloadHash: req.payloadHash });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.svc.get(req.requestId)?.state).toBe('executed');
    expect(r.gh.writes).toHaveLength(1);
  });
});

describe('the phone', () => {
  it('shows and decides every act main carries out, pr_close included, through its own parser', async () => {
    // APPROVAL_ACTIONS less the card-only ones (shared/phoneBotApprovals.ts).
    for (const a of ACT_ACTIONS) expect(PHONE_APPROVAL_ACTIONS).toContain(a);
    const r = rig();
    const req = await r.ask({ action: 'pr_close', prNumber: 1, reason: 'superseded' });
    const view = handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_COMMAND, { requestId: req.requestId }, () => r.svc);
    if (!view || !('request' in view)) throw new Error('no view');
    expect(view.request).toMatchObject({ action: 'pr_close', prNumber: 1, headSha: HEAD, payloadHash: req.payloadHash, state: 'pending' });
    expect(parsePhoneBotApproval(JSON.parse(JSON.stringify(view.request)))).toEqual(view.request);
    expect(handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_DECIDE_COMMAND, { requestId: req.requestId, decision: 'approve', payloadHash: req.payloadHash }, () => r.svc))
      .toMatchObject({ request: { action: 'pr_close', state: 'approved' } });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.gh.writes).toEqual([{ method: 'PATCH', endpoint: 'repos/o/r/pulls/1', body: { state: 'closed' } }]);
  });
});
