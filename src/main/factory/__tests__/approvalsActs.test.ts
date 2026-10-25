// Acts the owner approves and main carries out on GitHub (a comment, a new
// issue, closing an issue or a PR): the request pins what it acts on, the
// card shows the text the post sends (its payloadHash recomputable from the
// card's fences), only a card button echoing that hash approves a text act,
// and after the Undo window the act outbox runs it once, under the same
// gates as a merge.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotBinding, BotProfile } from '../../../shared/bot';
import { APPROVAL_UNDO_MS } from '../../../shared/botApproval';
import { ApprovalService, type ApprovalActHost, type ApprovalPorts, type ApprovalWake } from '../approvals';
import { RoomWriter } from '../roomWriter';
import { ActEffectStore, actEffectId } from '../actEffectStore';
import { ActExecutor, readIssue, readLogin, readPull, readRepo, RECONCILE_AFTER_MS } from '../actExecutor';
import { actMarker } from '../actPayload';
import { FakeGithub } from './fakeGithubActs';
import { handlePhoneBotApprovalCommand } from '../../phone/PhoneBotApprovals';
import { PHONE_BOT_APPROVAL_COMMAND, PHONE_BOT_APPROVAL_DECIDE_COMMAND } from '../../../shared/phoneBotApprovals';

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
    r2.approve(req2.requestId);
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r2.executor.idle();
    expect(r2.svc.get(req2.requestId)).toMatchObject({ state: 'refused', refusal: 'identity-changed' });
    expect(r2.gh.writes).toEqual([]);
  });

  it('a renamed or moved repository is refused repo-changed before any write', async () => {
    const r = rig();
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    r.gh.repo = { full_name: 'o/renamed', node_id: 'R_1' };
    r.approve(req.requestId);
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'repo-changed' });
    expect(r.gh.writes).toEqual([]);
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
    r.approve(pr.requestId, { source: 'chip' });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await r.executor.idle();
    expect(r.gh.writes.at(-1)).toEqual({ method: 'PATCH', endpoint: 'repos/o/r/pulls/1', body: { state: 'closed' } });
    expect(r.svc.get(pr.requestId)?.state).toBe('executed');
  });

  it('an issue someone else closed first is refused already-closed, nothing written', async () => {
    const r = rig();
    const req = await r.ask({ action: 'issue_close', issueNumber: 3, reason: 'fixed' });
    r.approve(req.requestId);
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
