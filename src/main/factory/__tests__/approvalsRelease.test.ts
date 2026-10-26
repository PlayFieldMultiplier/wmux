// A release the owner approves (releaseAct.ts): the request pins the tag, the
// commit on the default branch and the mode; the card shows what Approve
// publishes, and its payloadHash covers each published field; only its own
// card button approves it (never typed words, the chip or a rule); after
// the Undo window main pushes the tag alone (a tag workflow publishes it) or
// publishes a draft, never one POST /releases with draft:false, re-reading
// every precondition and the tag right before the write, and settling an
// interrupted try by a read.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotBinding, BotProfile } from '../../../shared/bot';
import { APPROVAL_UNDO_MS, type ApprovalReleaseAct, type ApprovalRule } from '../../../shared/botApproval';
import { ApprovalService, releaseCardTitle, releaseFields, ruleCovers, type ApprovalActHost, type ApprovalPorts, type ApprovalWake } from '../approvals';
import { RoomWriter } from '../roomWriter';
import { ActEffectStore, actEffectId } from '../actEffectStore';
import { ActExecutor, readIssue, readLogin, readPull, readRepo, RECONCILE_AFTER_MS } from '../actExecutor';
import { payloadHashOf } from '../actPayload';
import { readReleaseAsk } from '../releaseAct';
import { FakeGithub, type FakeRelease } from './fakeGithubActs';
import { handlePhoneBotApprovalCommand } from '../../phone/PhoneBotApprovals';
import { PHONE_BOT_APPROVAL_COMMAND, PHONE_BOT_APPROVAL_DECIDE_COMMAND, parsePhoneBotApproval } from '../../../shared/phoneBotApprovals';

const WS = 'ws-1';
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);
const OFF = '9'.repeat(40);
const TAG = 'v1.2.3';
const TAG_REF = `repos/o/r/git/ref/tags/${TAG}`;
const RELEASE_YML = 'name: release\non:\n  push:\n    tags: [\'v*\']\n';
const CI_YML = 'name: ci\non:\n  push:\n    branches: [main]\n';

const bot = (id: string): BotProfile => ({
  version: 1, id, workspaceId: WS, role: 'lead', name: `Bot ${id}`, engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { maxTurnsPerDay: 9, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 } as BotProfile['budget'],
  repo: { repoKey: 'o/r', repoPath: '/repo' }, enabled: true, createdAt: 0, updatedAt: 0,
});
const DEV = bot('bot-0000abcd');
const binding = (b: BotProfile): BotBinding => ({ workspaceId: b.workspaceId, botId: b.id, role: 'lead' });

/** The fenced blocks of a Markdown text, as CommonMark reads them. */
function fences(md: string): Array<{ info: string; text: string }> {
  const lines = md.split('\n');
  const out: Array<{ info: string; text: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) continue;
    const run = open[1];
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-release-'));
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A repository whose default branch `main` is C1, C2, C3, green on every
 *  commit, with package.json at 1.2.3; `workflow`: a release workflow on
 *  `v*` tags (workflow mode), else none (release mode). */
function rig(opts: { workflow?: boolean; wake?: Partial<ApprovalWake>; ports?: Partial<ApprovalPorts> } = {}) {
  const base = fs.mkdtempSync(path.join(dir, 'rig-'));
  const gh = new FakeGithub();
  gh.history = [C1, C2, C3];
  gh.otherCommits.add(OFF);
  for (const c of [C1, C2, C3, OFF]) gh.checkRuns.set(c, [{ status: 'completed', conclusion: 'success' }]);
  gh.files.set('package.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
  if (opts.workflow) gh.files.set('.github/workflows/release.yml', RELEASE_YML);
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
    release: (k, input) => readReleaseAsk(gh, k, input),
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
    acts: () => host,
    notice: (n) => notices.push(n.title),
    now: () => Date.now(),
    log: () => undefined,
    ...opts.ports,
  };
  svc = new ApprovalService(ports);
  const ask = async (params: Record<string, unknown> = {}) => {
    const res = await (svc as ApprovalService).request(binding(DEV), { action: 'release', tagName: TAG, reason: 'ship 1.2.3', ...params });
    if (!res.ok) throw new Error(`refused: ${res.code} ${res.message}`);
    return res.request;
  };
  const approve = (requestId: string, extra: Record<string, unknown> = {}) => (svc as ApprovalService).decide({ requestId, decision: 'approve', ...extra }, 'desktop');
  const cardBody = (cardId: string | undefined) => r0.writer.get(WS, cardId as string)?.body ?? '';
  /** Approve with the card's hash and let the Undo window pass. */
  const run = async (req: { requestId: string; payloadHash?: string }) => {
    expect(approve(req.requestId, { payloadHash: req.payloadHash })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await executor.idle();
  };
  /** Past the read window, the sweep settles what may have run. */
  const sweep = async () => {
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    await executor.reconcileAll();
  };
  const outcome = (requestId: string) => writer.read(WS, {}).cards.find((c) => c.clientPostId === `approval-outcome:${requestId}`);
  const r0 = { base, svc: svc as ApprovalService, gh, writer, effects, executor, ports, notices, ask, approve, cardBody, run, sweep, outcome };
  return r0;
}

const NOTES = { title: 'wmux 1.2.3', notes: 'Fixes.\n\n- one\n- two' };

/** A release request's stored act. */
function actOf(r: ReturnType<typeof rig>, requestId: string): ApprovalReleaseAct {
  const act = r.svc.get(requestId)?.act;
  if (act?.kind !== 'release') throw new Error('not a release');
  return act;
}

describe('a release card', () => {
  it('release mode: shows what Approve publishes, what main read, and five payload fences the hash is recomputable from', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    const card = r.writer.get(WS, req.cardId as string);
    expect(card?.title).toBe(`Publish release ${TAG} of o/r at 3333333 — publishes a release, cannot be undone`);
    expect(card?.title).toBe(releaseCardTitle(actOf(r, req.requestId), 'o/r'));
    const body = r.cardBody(req.cardId);
    expect(body).toContain('Approve publishes this release on GitHub as @owner, 10 s after you approve (Undo until then). A published release and its tag cannot be taken back by wmux.');
    expect(body).toContain('\nMarked Latest.\n');
    expect(body).toContain('Default branch main: 3333333 is its head.');
    expect(body).toContain('Checks on 3333333: passed.');
    expect(body).toContain('package.json version: 1.2.3.');
    expect(fences(body).map((f) => [f.info, f.text])).toEqual([
      ['wmux-payload', TAG], ['wmux-payload', C3], ['wmux-payload', NOTES.title], ['wmux-payload', NOTES.notes], ['wmux-payload', 'release'],
    ]);
    expect(req.payloadHash).toBe(hashFromCard(body));
    expect(req).toMatchObject({ action: 'release', headSha: C3, act: { kind: 'release', mode: 'release', tagName: TAG, targetSha: C3, defaultBranch: 'main', draft: false } });
    // An older commit, a prerelease, no title: the tag names it.
    r.gh.files.set('package.json', JSON.stringify({ version: '1.2.4-rc.1' }));
    const old = await r.ask({ tagName: 'v1.2.4-rc.1', targetSha: C1, prerelease: true, clientRequestId: 'k2' });
    const ob = r.cardBody(old.cardId);
    expect(ob).toContain('\nPrerelease, never Latest.\n');
    expect(ob).toContain('Default branch main: 1111111 is 2 commits behind its head.');
    expect(fences(ob).map((f) => f.text)).toEqual(['v1.2.4-rc.1', C1, 'v1.2.4-rc.1', '', 'prerelease']);
    expect(old.payloadHash).toBe(hashFromCard(ob));
  });

  it('workflow mode: the tag, the commit and the workflow it starts are the payload; title and notes are not used', async () => {
    const r = rig({ workflow: true });
    const req = await r.ask(NOTES);
    expect(r.writer.get(WS, req.cardId as string)?.title).toBe(`Push tag ${TAG} to o/r at 3333333 — starts its release workflow, cannot be undone`);
    const body = r.cardBody(req.cardId);
    expect(body).toContain(`Approve pushes the tag ${TAG} at 3333333 as @owner, 10 s after you approve (Undo until then); the workflow .github/workflows/release.yml runs on it`);
    expect(fences(body).map((f) => f.text)).toEqual([TAG, C3, '.github/workflows/release.yml']);
    expect(req.payloadHash).toBe(hashFromCard(body));
    expect(actOf(r, req.requestId)).toMatchObject({ mode: 'workflow', title: '', notes: '', prerelease: false, workflows: ['.github/workflows/release.yml'] });
  });

  it('the card says what the checks are when the bot asks: failed, running, not started', async () => {
    const r = rig();
    r.gh.checkRuns.set(C3, [{ status: 'completed', conclusion: 'failure' }]);
    expect(r.cardBody((await r.ask()).cardId)).toContain('Checks on 3333333: one failed; wmux does not publish while a check fails.');
    r.gh.checkRuns.set(C2, [{ status: 'in_progress', conclusion: null }]);
    expect(r.cardBody((await r.ask({ targetSha: C2, clientRequestId: 'k2' })).cardId)).toContain('Checks on 2222222: still running');
    r.gh.checkRuns.delete(C1);
    r.gh.files.set('.github/workflows/ci.yml', CI_YML);
    expect(r.cardBody((await r.ask({ targetSha: C1, clientRequestId: 'k3' })).cardId)).toContain('Checks on 1111111: not started yet');
  });
});

describe('asking for a release', () => {
  it('is refused with no card: a number, a bad tag or SHA, GitLab, a version that is not the tag\'s, a tag or release that exists', async () => {
    const r = rig();
    await expect(r.ask({ prNumber: 1 })).rejects.toThrow(/tagName, no number/);
    await expect(r.ask({ tagName: 'v1..2' })).rejects.toThrow(/tagName cannot be used/);
    await expect(r.ask({ tagName: undefined })).rejects.toThrow(/names its tagName/);
    await expect(r.ask({ targetSha: 'abc1234' })).rejects.toThrow(/full 40-character/);
    await expect(r.ask({ prerelease: 'yes' })).rejects.toThrow(/true or false/);
    await expect(r.ask({ title: 'two\nlines' })).rejects.toThrow(/one line/);
    r.gh.files.set('package.json', JSON.stringify({ version: '1.2.2' }));
    await expect(r.ask()).rejects.toThrow(/invalid version-mismatch: package.json says 1.2.2/);
    r.gh.files.set('package.json', JSON.stringify({ version: '1.2.3' }));
    r.gh.tags.set(TAG, { sha: C1 });
    await expect(r.ask()).rejects.toThrow(/invalid tag-taken/);
    expect(r.writer.read(WS, {}).cards.filter((c) => c.kind === 'approval')).toEqual([]);
    const gitlab = rig({ ports: { bots: () => ({ listEnabled: () => [], get: () => ({ ...DEV, repo: { repoKey: 'gitlab.com/o/r', repoPath: '/repo' } }) }) } });
    await expect(gitlab.ask()).rejects.toThrow(/GitHub only/);
  });
});

describe('who approves a release', () => {
  it('only its card button with the card\'s hash: typed words and the chip leave it pending, no rule covers it', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    const said = r.writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: 'ok', threadId: req.threadId, refs: { botId: DEV.id } });
    if (!said.ok) throw new Error('post failed');
    expect(r.svc.onOwnerCard(said.card)).toEqual([]);
    expect(r.approve(req.requestId, { payloadHash: req.payloadHash, source: 'chip' })).toMatchObject({ ok: false, code: 'not_here', message: expect.stringMatching(/a release is approved with Approve on its card/) });
    expect(r.svc.decide({ requestId: req.requestId, decision: 'always' }, 'desktop')).toMatchObject({ ok: false, code: 'not_ruleable' });
    const rule: ApprovalRule = { ruleId: 'rule-1', action: 'release' as ApprovalRule['action'], repoKey: req.repoKey, scope: { botId: DEV.id }, createdAt: 0 };
    expect(ruleCovers(rule, req)).toBe(false);
    expect(r.svc.get(req.requestId)?.state).toBe('pending');
  });

  it('the phone: no hash is client_update_required, the hash approves; a hash with any one of the five fields changed is `changed`', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    const view = handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_COMMAND, { requestId: req.requestId }, () => r.svc);
    if (!view || !('request' in view)) throw new Error('no view');
    expect(view.request).toMatchObject({ action: 'release', headSha: C3, payloadHash: req.payloadHash, canAlwaysAllow: false });
    expect(parsePhoneBotApproval(JSON.parse(JSON.stringify(view.request)))).toEqual(view.request);
    expect(handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_DECIDE_COMMAND, { requestId: req.requestId, decision: 'approve' }, () => r.svc))
      .toEqual({ refused: { code: 'client_update_required', message: expect.any(String) } });
    const fields = releaseFields(actOf(r, req.requestId));
    expect(payloadHashOf(fields)).toBe(req.payloadHash);
    for (let i = 0; i < fields.length; i += 1) {
      const other = fields.map((f, j) => (j === i ? `${f}x` : f));
      expect(r.approve(req.requestId, { payloadHash: payloadHashOf(other) }), `field ${i}`).toMatchObject({ ok: false, code: 'changed' });
    }
    expect(handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_DECIDE_COMMAND, { requestId: req.requestId, decision: 'approve', payloadHash: req.payloadHash }, () => r.svc))
      .toMatchObject({ request: { action: 'release', state: 'approved' } });
  });

  it('a release request an older build stored (no act) stays recorded only', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    const file = path.join(r.base, 'factory', 'approvals.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { requests: Array<Record<string, unknown>> };
    for (const q of raw.requests) for (const k of ['act', 'payloadHash', 'actRepo', 'contentKey']) delete q[k];
    fs.writeFileSync(file, JSON.stringify(raw));
    const older = new ApprovalService(r.ports);
    expect(older.decide({ requestId: req.requestId, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'approved' } });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS * 3);
    expect(r.gh.writes).toEqual([]);
  });
});

describe('publishing a release (release mode)', () => {
  it('posts a draft, then publishes it: two writes, these bodies, never a POST with draft:false', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    await r.run(req);
    const id = r.gh.releases[0]?.id;
    expect(r.gh.writes).toEqual([
      { method: 'POST', endpoint: 'repos/o/r/releases', body: { tag_name: TAG, target_commitish: C3, name: NOTES.title, body: NOTES.notes, draft: true, prerelease: false } },
      { method: 'PATCH', endpoint: `repos/o/r/releases/${id}`, body: { draft: false, make_latest: 'true' } },
    ]);
    expect(r.gh.tags.get(TAG)).toEqual({ sha: C3 });
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'executed', result: { url: `https://github.com/o/r/releases/tag/${TAG}`, id } });
    expect(r.outcome(req.requestId)).toMatchObject({ kind: 'status', title: `Published release ${TAG} of o/r (approved by you)`, body: `https://github.com/o/r/releases/tag/${TAG}` });
    expect(r.notices.some((t) => t.startsWith(`Done: Publish a release of github.com/o/r (${TAG})`))).toBe(true);
    await r.executor.reconcileAll();
    expect(r.gh.writes).toHaveLength(2);
  });

  it('a prerelease is published with make_latest "false"', async () => {
    const r = rig();
    const req = await r.ask({ ...NOTES, prerelease: true });
    await r.run(req);
    expect(r.gh.writes.at(-1)?.body).toEqual({ draft: false, make_latest: 'false' });
    expect(r.svc.get(req.requestId)?.state).toBe('executed');
  });

  it('a 422 on the draft refuses it and sends nothing more', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    r.gh.nextWrite = { answer: { ok: false, kind: 'http', status: 422, message: 'gh: Validation Failed (HTTP 422)' }, landed: false };
    await r.run(req);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'gh-422' });
    expect(r.gh.writes.map((w) => w.method)).toEqual(['POST']);
    await r.sweep();
    expect(r.gh.writes).toHaveLength(1);
  });

  it('a 4xx on publishing is read back at once: nothing published deletes the draft and refuses; published is done', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    r.gh.onWrite = (w) => {
      if (w.method === 'PATCH') r.gh.nextWrite = { answer: { ok: false, kind: 'http', status: 422, message: 'gh: Validation Failed (HTTP 422)' }, landed: false };
    };
    await r.run(req);
    expect(r.gh.writes.map((w) => w.method)).toEqual(['POST', 'PATCH', 'DELETE']);
    expect(r.gh.releases).toEqual([]);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'gh-422' });
    // GitHub answered 4xx and published it all the same: done, as it is.
    const p = rig();
    const two = await p.ask(NOTES);
    p.gh.onWrite = (w) => {
      if (w.method === 'PATCH') p.gh.nextWrite = { answer: { ok: false, kind: 'http', status: 422, message: 'gh: Validation Failed (HTTP 422)' }, landed: true };
    };
    await p.run(two);
    expect(p.gh.writes.map((w) => w.method)).toEqual(['POST', 'PATCH']);
    expect(p.svc.get(two.requestId)?.state).toBe('executed');
  });

  it('a tag made between the late read and publishing: the release is reported published on another commit, with its link', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    r.gh.onWrite = (w) => {
      if (w.method === 'PATCH') r.gh.tags.set(TAG, { sha: C2 });
    };
    await r.run(req);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'published-other-target', result: { url: `https://github.com/o/r/releases/tag/${TAG}` } });
    expect(r.outcome(req.requestId)).toMatchObject({ kind: 'refusal', title: expect.stringMatching(/its tag points at another commit/), body: `https://github.com/o/r/releases/tag/${TAG}` });
  });

  it('an answer that is not the release as approved is uncertain; a read settles it without a second write', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    r.gh.onWrite = (w) => {
      if (w.method === 'PATCH') r.gh.nextWrite = { answer: { ok: true, value: { id: 1, draft: true } }, landed: true };
    };
    await r.run(req);
    expect(r.effects.get(actEffectId(req.requestId))).toMatchObject({ status: 'uncertain', reason: 'unexpected-response' });
    await r.sweep();
    expect(r.gh.writes).toHaveLength(2);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'executed', result: { id: r.gh.releases[0]?.id } });
  });
});

describe('pushing a tag (workflow mode)', () => {
  it('one write, the tag ref alone; the done card says the workflow is building it and links its run', async () => {
    const r = rig({ workflow: true });
    const req = await r.ask();
    r.gh.onWrite = () => r.gh.workflowRuns.push({ head_sha: C3, event: 'push', head_branch: TAG, status: 'queued', conclusion: null, html_url: 'https://github.com/o/r/actions/runs/77' });
    await r.run(req);
    expect(r.gh.writes).toEqual([{ method: 'POST', endpoint: 'repos/o/r/git/refs', body: { ref: `refs/tags/${TAG}`, sha: C3 } }]);
    expect(r.gh.tags.get(TAG)).toEqual({ sha: C3 });
    expect(r.gh.releases).toEqual([]);
    expect(r.outcome(req.requestId)).toMatchObject({ kind: 'status', title: `Tag pushed — the release workflow is building it (${TAG} on o/r, approved by you)`, body: 'https://github.com/o/r/actions/runs/77' });
  });

  it('a run that cannot be read yet: done all the same, with no link', async () => {
    const r = rig({ workflow: true });
    const req = await r.ask();
    await r.run(req);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'executed', result: { url: '' } });
    expect(r.outcome(req.requestId)?.body).toBeUndefined();
  });

  it('a 422 "already exists" is tag-taken and sends nothing more', async () => {
    const r = rig({ workflow: true });
    const req = await r.ask();
    r.gh.onWrite = () => r.gh.tags.set(TAG, { sha: C2 });
    await r.run(req);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'tag-taken' });
    expect(r.gh.writes).toHaveLength(1);
    await r.sweep();
    expect(r.gh.writes).toHaveLength(1);
  });
});

describe('what is read again right before the write', () => {
  const refusedBeforeAnyWrite = async (mutate: (r: ReturnType<typeof rig>) => void, refusal: string, workflow = false) => {
    const r = rig({ workflow });
    const req = await r.ask(NOTES);
    mutate(r);
    await r.run(req);
    expect(r.svc.get(req.requestId), refusal).toMatchObject({ state: 'refused', refusal });
    expect(r.gh.writes, refusal).toEqual([]);
  };

  it('the default branch, the commit on it, the tag, a release or a draft of it', async () => {
    await refusedBeforeAnyWrite((r) => { r.gh.repo.default_branch = 'trunk'; }, 'default-branch-changed');
    // A force-push left the commit off the branch.
    await refusedBeforeAnyWrite((r) => { r.gh.history = [C1, C2]; r.gh.otherCommits.add(C3); }, 'not-on-default-branch');
    await refusedBeforeAnyWrite((r) => { r.gh.tags.set(TAG, { sha: C3 }); }, 'tag-taken');
    await refusedBeforeAnyWrite((r) => { r.gh.tags.set(TAG, { sha: C3 }); }, 'tag-taken', true);
    const someone = (draft: boolean): FakeRelease => ({
      id: 500, tag_name: TAG, draft, prerelease: false, name: 'x', body: '', target_commitish: C3, author: { login: 'someone' }, html_url: 'https://github.com/o/r/releases/tag/x',
    });
    await refusedBeforeAnyWrite((r) => { r.gh.releases.push(someone(true)); }, 'release-exists');
    await refusedBeforeAnyWrite((r) => { r.gh.releases.push(someone(false)); }, 'release-exists');
    await refusedBeforeAnyWrite((r) => { r.gh.releases.push(someone(true)); }, 'release-exists', true);
  });

  it('the checks on the commit: failing, still running, not started; none at all is allowed', async () => {
    await refusedBeforeAnyWrite((r) => { r.gh.checkRuns.set(C3, [{ status: 'completed', conclusion: 'failure' }]); }, 'checks-failing');
    await refusedBeforeAnyWrite((r) => { r.gh.statuses.set(C3, { state: 'failure', total_count: 1 }); }, 'checks-failing');
    await refusedBeforeAnyWrite((r) => { r.gh.checkRuns.set(C3, [{ status: 'in_progress', conclusion: null }]); }, 'checks-pending', true);
    await refusedBeforeAnyWrite((r) => { r.gh.checkRuns.delete(C3); r.gh.files.set('.github/workflows/ci.yml', CI_YML); }, 'checks-not-started');
    // A repository without CI releases.
    const r = rig();
    r.gh.checkRuns.delete(C3);
    const req = await r.ask(NOTES);
    await r.run(req);
    expect(r.svc.get(req.requestId)?.state).toBe('executed');
  });

  it('the late read of the tag: one made after the checks refuses the push, and deletes the draft a release made', async () => {
    for (const workflow of [true, false]) {
      const r = rig({ workflow });
      const req = await r.ask(NOTES);
      let reads = 0;
      r.gh.onRead = (e) => {
        if (e === TAG_REF && ++reads === 2) r.gh.tags.set(TAG, { sha: C2 });
      };
      await r.run(req);
      expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'tag-taken' });
      expect(r.gh.writes.map((w) => w.method)).toEqual(workflow ? [] : ['POST', 'DELETE']);
      expect(r.gh.releases).toEqual([]);
    }
  });

  it('a check that fails after the draft was made deletes it on the next try', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    // The publish timed out without landing; then a check failed.
    r.gh.onWrite = (w) => {
      if (w.method === 'PATCH') r.gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'timeout' }, landed: false };
    };
    await r.run(req);
    expect(r.effects.get(actEffectId(req.requestId))).toMatchObject({ status: 'uncertain', draftId: r.gh.releases[0]?.id });
    r.gh.onWrite = null;
    r.gh.checkRuns.set(C3, [{ status: 'completed', conclusion: 'failure' }]);
    await r.sweep();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'checks-failing' });
    expect(r.gh.writes.map((w) => w.method)).toEqual(['POST', 'PATCH', 'DELETE']);
    expect(r.gh.releases).toEqual([]);
  });
});

describe('a try that may have run, settled by a read', () => {
  /** A publish (or a tag push) that timed out; `landed`: GitHub took it. */
  const timedOut = async (opts: { workflow?: boolean; landed: boolean }) => {
    const r = rig({ workflow: opts.workflow });
    const req = await r.ask(NOTES);
    r.gh.onWrite = (w) => {
      if (w.method === 'PATCH' || w.endpoint === 'repos/o/r/git/refs') r.gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'timeout' }, landed: opts.landed };
    };
    await r.run(req);
    r.gh.onWrite = null;
    expect(r.effects.get(actEffectId(req.requestId))?.status).toBe('uncertain');
    return { r, req };
  };

  it('release mode: published as approved is done; by someone else, on another commit, or other than approved is refused', async () => {
    let { r, req } = await timedOut({ landed: true });
    await r.sweep();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'executed', result: { id: r.gh.releases[0]?.id } });
    expect(r.gh.writes).toHaveLength(2);

    ({ r, req } = await timedOut({ landed: true }));
    (r.gh.releases[0] as FakeRelease).author = { login: 'someone' };
    await r.sweep();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'release-by-other' });

    ({ r, req } = await timedOut({ landed: true }));
    r.gh.tags.set(TAG, { sha: C2 });
    await r.sweep();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'published-other-target', result: { url: expect.stringMatching(/^https:/) } });

    ({ r, req } = await timedOut({ landed: true }));
    (r.gh.releases[0] as FakeRelease).prerelease = true;
    await r.sweep();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'found-different' });
  });

  it('release mode: a tag with no release (at the commit or not) is not this act\'s: tag-taken, and its draft deleted', async () => {
    for (const sha of [C3, C2]) {
      const { r, req } = await timedOut({ landed: false });
      r.gh.tags.set(TAG, { sha });
      await r.sweep();
      expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'tag-taken' });
      expect(r.gh.writes.map((w) => w.method)).toEqual(['POST', 'PATCH', 'DELETE']);
      expect(r.gh.releases).toEqual([]);
    }
  });

  it('release mode: nothing published, the draft still there: the next try publishes that draft, never a second one', async () => {
    const { r, req } = await timedOut({ landed: false });
    await r.sweep();
    expect(r.gh.writes.map((w) => w.method)).toEqual(['POST', 'PATCH', 'PATCH']);
    expect(r.gh.releases).toHaveLength(1);
    expect(r.svc.get(req.requestId)?.state).toBe('executed');
  });

  it('a read that cannot say sends nothing', async () => {
    const { r, req } = await timedOut({ landed: false });
    r.gh.answerRead = (e) => (e.startsWith('repos/o/r/releases?') ? { ok: false, kind: 'error', message: 'gh: Server Error (HTTP 502)' } : null);
    await r.sweep();
    expect(r.effects.get(actEffectId(req.requestId))?.status).toBe('uncertain');
    expect(r.gh.writes).toHaveLength(2);
  });

  it('workflow mode: the tag at the commit is done, elsewhere tag-taken, absent tried again', async () => {
    let { r, req } = await timedOut({ workflow: true, landed: true });
    await r.sweep();
    expect(r.svc.get(req.requestId)?.state).toBe('executed');
    expect(r.gh.writes).toHaveLength(1);

    ({ r, req } = await timedOut({ workflow: true, landed: false }));
    r.gh.tags.set(TAG, { sha: C2 });
    await r.sweep();
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'tag-taken' });
    expect(r.gh.writes).toHaveLength(1);

    ({ r, req } = await timedOut({ workflow: true, landed: false }));
    await r.sweep();
    expect(r.gh.writes.map((w) => w.endpoint)).toEqual(['repos/o/r/git/refs', 'repos/o/r/git/refs']);
    expect(r.svc.get(req.requestId)?.state).toBe('executed');
  });

  it('a try given back once its draft exists stays counted: a restart keeps the approval, and the draft is published, never a second one', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    let first = true;
    r.gh.onWrite = (w) => {
      if (w.method === 'PATCH' && first) {
        first = false;
        r.gh.nextWrite = { answer: { ok: false, kind: 'rate-limited', message: 'GitHub rate limit' }, landed: false };
      }
    };
    await r.run(req);
    const id = actEffectId(req.requestId);
    const draft = r.gh.releases[0]?.id;
    expect(r.effects.get(id)).toMatchObject({ status: 'pending', attempt: 1, reason: 'rate-limited', draftId: draft });
    // A restart: the request is not handed back to the owner, its row stays.
    const again = new ApprovalService(r.ports);
    again.resume();
    expect(again.get(req.requestId)?.state).toBe('approved');
    expect(r.effects.get(id)).not.toBeNull();
    await r.executor.reconcileAll();
    expect(r.gh.writes.map((w) => `${w.method} ${w.endpoint}`)).toEqual(['POST repos/o/r/releases', `PATCH repos/o/r/releases/${draft}`, `PATCH repos/o/r/releases/${draft}`]);
    expect(r.svc.get(req.requestId)?.state).toBe('executed');
  });

  it('a crash between the draft\'s answer and its journal: a restart finds the draft by its tag, login and content, and publishes it', async () => {
    const r = rig();
    const req = await r.ask(NOTES);
    // The draft landed; its answer never reached the journal (the app died).
    r.gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'killed' }, landed: true };
    await r.run(req);
    const id = actEffectId(req.requestId);
    expect(r.effects.get(id)).toMatchObject({ status: 'uncertain' });
    expect(r.effects.get(id)?.draftId).toBeUndefined();
    // Next start: a fresh outbox over the same file.
    const effects = new ActEffectStore(path.join(r.base, 'factory', 'act-effects.json'));
    const executor = new ActExecutor({
      effects, gh: r.gh,
      approval: { request: (q) => r.svc.get(q), authorize: (e) => r.svc.authorizeAct(e) },
      emit: (e) => r.svc.onActEffect(e),
    });
    vi.setSystemTime(Date.now() + RECONCILE_AFTER_MS + 1);
    await executor.reconcileAll();
    const draft = r.gh.releases[0]?.id;
    expect(r.gh.writes).toEqual([
      expect.objectContaining({ method: 'POST', endpoint: 'repos/o/r/releases' }),
      { method: 'PATCH', endpoint: `repos/o/r/releases/${draft}`, body: { draft: false, make_latest: 'true' } },
    ]);
    expect(effects.get(id)).toMatchObject({ status: 'done', draftId: draft });
    expect(r.svc.get(req.requestId)?.state).toBe('executed');
  });
});
