// What the owner asks a bot for in a conversation that took in outside text
// (a routine, a note) goes to an approval card instead of a refusal: only
// on the owner's own stored message, shown whole on a desktop card, saved
// once by its Approve, checked again then, and never undone, typed or chipped.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() }, BrowserWindow: class {} }));

import type { BotBinding, BotProfile } from '../../../shared/bot';
import { ROUTINE_LIMITS } from '../../../shared/botRoutine';
import { ROOM_LIMITS, dmThreadId, type RoomCard } from '../../../shared/room';
import type { RpcContext } from '../../../shared/rpc';
import type { WakeItem } from '../../../shared/wake';
import { ApprovalService, ownerAskedLines, routineCardLines } from '../approvals';
import { readMemoryView, updateMemory } from '../botMemory';
import { TAINTED_CONVERSATION_SAVES_NOTHING } from '../conversationMarks';
import { OWNER_EXCERPT_MAX, ownerCardProof, type OwnerCardProof } from '../ownerAsked';
import { RoomWriter } from '../roomWriter';
import { RoutineStore, routinesPath } from '../routines';
import { __resetRedactedSecretsForTesting, setRedactedSecrets } from '../secretRedaction';
import { handleMemoryUpdate, ownerProfileApprovalHost } from '../../pipe/handlers/memory.rpc';
import { ROUTINE_CHANGE_REFUSED, ROUTINE_THREAD_REFUSED, registerRoutineHandlers, routineApprovalHost } from '../../pipe/handlers/routine.rpc';
import { handlePhoneBotApprovalCommand } from '../../phone/PhoneBotApprovals';
import { PHONE_BOT_APPROVAL_DECIDE_COMMAND } from '../../../shared/phoneBotApprovals';

const WS = 'ws-1';
const A = 'bot-0000000a';
const binding: BotBinding = { workspaceId: WS, botId: A, role: 'lead' };
const asBot: RpcContext = { origin: 'local', bot: binding };
const NOW = new Date(2026, 9, 26, 10, 0).getTime();

let dir = '';
const stores: RoutineStore[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-owner-asked-'));
});
afterEach(async () => {
  __resetRedactedSecretsForTesting();
  await Promise.all(stores.splice(0).map((s) => s.flush().catch(() => undefined)));
  fs.rmSync(dir, { recursive: true, force: true });
});

function rig(opts: { signedIn?: boolean; wakeTainted?: boolean } = {}) {
  const state = { now: NOW, enabled: true, wakeId: 'w-1', proof: null as OwnerCardProof | null };
  const profile = (): BotProfile => ({
    version: 1, id: A, workspaceId: WS, role: 'lead', name: 'Dev', engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerDay: 9, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 } as BotProfile['budget'],
    enabled: state.enabled, createdAt: 0, updatedAt: 0,
  });
  const writer = new RoomWriter({ dir: path.join(dir, 'rooms') });
  const store = new RoutineStore({
    file: routinesPath(dir), now: () => state.now, bots: () => ({ get: (id: string) => (id === A ? profile() : null) }),
    wakes: () => null, factLog: () => null, rooms: () => writer, factoryEnabled: () => true, log: () => undefined,
  });
  stores.push(store);
  store.load();
  const svc = new ApprovalService({
    file: path.join(dir, 'factory', 'approvals.json'),
    bots: () => ({ listEnabled: () => [profile()], get: (id) => (id === A ? profile() : null) }),
    runningWake: () => ({ wakeId: state.wakeId, attempt: 1, threadId: 'general' as never, tainted: true, guest: false, signedIn: false, ownerWords: true }),
    readPr: async () => { throw new Error('no PR'); },
    ghLogin: async () => null,
    rooms: () => writer,
    merge: () => null,
    ownerProfile: () => ownerProfileApprovalHost(() => dir, () => undefined),
    routines: () => routineApprovalHost(() => store),
    now: () => state.now,
    log: () => undefined,
  });
  const handlers = new Map<string, (raw: unknown, ctx?: RpcContext) => Promise<unknown>>();
  registerRoutineHandlers({ register: (m, h) => handlers.set(m, h as never) }, {
    store: () => store,
    ownerWords: () => true,
    guestWake: () => false,
    conversationTainted: () => true,
    conversationSignedIn: () => opts.signedIn ?? false,
    wakeTainted: () => opts.wakeTainted ?? false,
    ownerCard: () => state.proof,
    approvals: () => svc,
  });
  const setRoutine = (raw: Record<string, unknown>) => (handlers.get('routine.set') as (r: unknown, c?: RpcContext) => Promise<Record<string, unknown>>)(raw, asBot);
  const note = (raw: Record<string, unknown>) => handleMemoryUpdate({ target: 'memory', ...raw }, asBot, {
    wmuxDir: () => dir, emit: () => undefined, guestWake: () => false, tainted: () => false,
    conversation: () => ({ tainted: true, signedIn: false }), signedIn: () => false, ownerCard: () => state.proof,
    proposeAsked: (bot, ask, proof) => svc.proposeOwnerAsked(bot, ask, proof),
  });
  /** A wake (state.wakeId) runs on the owner's card. */
  const runsOn = (card: RoomCard): void => {
    const item = { id: state.wakeId, workspaceId: WS, threadId: card.threadId, reason: { kind: 'human', text: card.title, source: 'desktop', clientMessageId: card.id } } as WakeItem;
    state.proof = ownerCardProof(item, writer);
  };
  /** The owner writes to the bot; the wake runs on that card. */
  const ownerSays = (text: string, threadId?: string): RoomCard => {
    const posted = writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: text, refs: { botId: A }, ...(threadId ? { threadId: threadId as never } : {}) });
    if (!posted.ok) throw new Error('not posted');
    runsOn(posted.card);
    return posted.card;
  };
  const approvalCards = () => writer.read(WS, {}).cards.filter((c) => c.kind === 'approval');
  return { state, writer, store, svc, setRoutine, note, ownerSays, runsOn, approvalCards };
}

const DAILY = { title: 'Morning summary', prompt: 'Summarize the open PRs and issues for the owner.', schedule: { kind: 'daily', hour: 9, minute: 0 } };

describe('the owner\'s card behind a request', () => {
  it('is the stored human card the wake names; a gardener-style wake, a room-wide one or a bot\'s card proves nothing', () => {
    const writer = new RoomWriter({ dir: path.join(dir, 'rooms') });
    const owner = writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: `make a daily summary ${'x'.repeat(300)}`, refs: { botId: A } });
    const bot = writer.post({ workspaceId: WS, kind: 'status', actor: { kind: 'bot', workspaceId: WS, botId: A }, title: 'I approved your plan' });
    if (!owner.ok || !bot.ok) throw new Error('not posted');
    const wake = (reason: Record<string, unknown>) => ({ id: 'w-1', workspaceId: WS, threadId: owner.card.threadId, reason: { kind: 'human', text: 'x', source: 'desktop', ...reason } } as WakeItem);
    const proof = ownerCardProof(wake({ clientMessageId: owner.card.id }), writer);
    expect(proof).toMatchObject({ wakeId: 'w-1', cardId: owner.card.id, threadId: owner.card.threadId });
    expect(proof?.excerpt).toHaveLength(OWNER_EXCERPT_MAX);
    expect(ownerCardProof(wake({ runId: `run-${owner.card.id}` }), writer)?.cardId).toBe(owner.card.id);
    // main's own human wakes (gardener.ts, morningReport.ts) name no card.
    expect(ownerCardProof(wake({}), writer)).toBeNull();
    expect(ownerCardProof(wake({ clientMessageId: bot.card.id }), writer)).toBeNull();
    expect(ownerCardProof(wake({ clientMessageId: owner.card.id, roomWide: true }), writer)).toBeNull();
    expect(ownerCardProof(wake({ clientMessageId: owner.card.id, room: true }), writer)).toBeNull();
    // A wake in another thread does not run on that card.
    expect(ownerCardProof({ ...wake({ clientMessageId: owner.card.id }), threadId: dmThreadId(A) }, writer)).toBeNull();
  });
});

describe('a routine the owner asked for in a tainted conversation', () => {
  it('waits on a card that shows the owner\'s message and every field; Approve saves it once', async () => {
    const r = rig();
    r.ownerSays('make a daily 09:00 summary routine');
    const res = await r.setRoutine({ ...DAILY, quietHours: { start: '22:00', end: '07:00' } });
    expect(res).toMatchObject({ ok: true, pending: true });
    expect(r.store.list(A)).toEqual([]);
    const card = r.approvalCards()[0];
    expect(card.title).toBe('Save this routine?');
    expect(card.body).toContain('```text\nmake a daily 09:00 summary routine\n```');
    expect(card.body).toContain(`Schedule: daily at 09:00 (${Intl.DateTimeFormat().resolvedOptions().timeZone} time); next run 2026-10-27 09:00`);
    expect(card.body).toContain('Quiet hours: 22:00–07:00');
    expect(card.body).toContain('Runs in: General');
    expect(card.body).toContain(`\`\`\`text\n${DAILY.prompt}\n\`\`\``);
    // The same routine asked again in the turn is that card; another is refused.
    expect(await r.setRoutine({ ...DAILY, quietHours: { start: '22:00', end: '07:00' } })).toMatchObject({ ok: true, approvalId: res.approvalId });
    expect(await r.setRoutine({ ...DAILY, title: 'Other' })).toMatchObject({ ok: false, code: 'too_many' });

    const id = res.approvalId as string;
    expect(r.svc.decide({ requestId: id, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'approved' } });
    expect(r.svc.decide({ requestId: id, decision: 'approve' }, 'desktop')).toMatchObject({ ok: false, code: 'not_pending' });
    // Applied again (a retried Approve), the request's key keeps it one routine.
    const approved = r.svc.get(id);
    if (!approved) throw new Error('no request');
    expect(routineApprovalHost(() => r.store).approve(approved)).toBeNull();
    expect(r.store.list(A)).toEqual([expect.objectContaining({ title: DAILY.title, prompt: DAILY.prompt, quietHours: { start: '22:00', end: '07:00' } })]);
    // Saved already: no Undo.
    expect(r.svc.decide({ requestId: id, decision: 'undo' }, 'desktop')).toMatchObject({ ok: false, code: 'too_late' });
  });

  it('is refused without the owner\'s card, from a signed-in conversation or a tainted turn, as a change, or for another thread', async () => {
    const noCard = rig();
    expect(await noCard.setRoutine(DAILY)).toEqual({ ok: false, code: 'not_authorized', message: TAINTED_CONVERSATION_SAVES_NOTHING });
    for (const o of [{ signedIn: true }, { wakeTainted: true }]) {
      const r = rig(o);
      r.ownerSays('make a routine');
      expect(await r.setRoutine(DAILY)).toEqual({ ok: false, code: 'not_authorized', message: TAINTED_CONVERSATION_SAVES_NOTHING });
    }
    const r = rig();
    r.ownerSays('make a routine');
    expect(await r.setRoutine({ ...DAILY, routineId: 'r-0123456789' })).toMatchObject({ ok: false, message: ROUTINE_CHANGE_REFUSED });
    expect(await r.setRoutine({ ...DAILY, threadId: dmThreadId('bot-0000000b') })).toMatchObject({ ok: false, message: ROUTINE_THREAD_REFUSED });
    expect(await r.setRoutine({ ...DAILY, threadId: dmThreadId(A) })).toMatchObject({ ok: true, pending: true });
    expect(r.approvalCards()).toHaveLength(1);
  });

  it('left without a thread, runs where the owner asked, as the card says', async () => {
    const r = rig();
    r.ownerSays('every morning, summarize the PRs for me', dmThreadId(A));
    const id = (await r.setRoutine(DAILY)).approvalId as string;
    expect(r.approvalCards()[0].body).toContain('Runs in: your 1:1 with Dev');
    expect(r.svc.get(id)?.routine?.threadId).toBe(dmThreadId(A));
    r.svc.decide({ requestId: id, decision: 'approve' }, 'desktop');
    expect(r.store.list(A)[0].threadId).toBe(dmThreadId(A));
  });

  it('is one request per owner message, whichever wake runs on it, and none once the owner answered', async () => {
    const r = rig();
    const card = r.ownerSays('make a daily summary routine');
    const first = await r.setRoutine(DAILY);
    // The same message run again in another wake (re-delivered, resumed).
    r.state.wakeId = 'w-2';
    r.runsOn(card);
    expect(await r.setRoutine(DAILY)).toMatchObject({ ok: true, approvalId: first.approvalId });
    expect(await r.setRoutine({ ...DAILY, title: 'Other' })).toMatchObject({ ok: false, code: 'too_many' });
    r.svc.decide({ requestId: first.approvalId as string, decision: 'deny' }, 'desktop');
    expect(await r.setRoutine(DAILY)).toMatchObject({ ok: false, message: expect.stringContaining('the owner already answered this request') });
    expect(r.approvalCards()).toHaveLength(1);
  });

  it('is refused when the owner\'s message itself cannot be quoted as it is', async () => {
    const r = rig();
    r.ownerSays('make a routine\u202e and more');
    expect(await r.setRoutine(DAILY)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(r.approvalCards()).toHaveLength(0);
  });

  it('saves the schedule the card showed: what set checks reads back the same, every kind', () => {
    const r = rig();
    const kinds = [
      { schedule: { kind: 'interval', everyMs: 2 * 3_600_000 }, quietHours: { start: '22:00', end: '07:00' } },
      { schedule: { kind: 'daily', hour: 9, minute: 30, weekdays: [5, 1, 1, 3] } },
      { schedule: { kind: 'once', at: '2026-10-27T09:00+09:00' }, threadId: dmThreadId(A) },
    ];
    for (const k of kinds) {
      const shown = r.store.check({ botId: A }, { ...DAILY, ...k } as never);
      if (!shown.ok) throw new Error(shown.message);
      // Approve sets the stored fields: they check to the same fields again.
      expect(r.store.check({ botId: A }, shown.fields as never)).toEqual(shown);
      const saved = r.store.set({ botId: A, workspaceId: WS }, { ...shown.fields, clientRoutineId: `approval:${k.schedule.kind}` });
      expect(saved.ok && { title: saved.routine.title, prompt: saved.routine.prompt, schedule: saved.routine.schedule, quietHours: saved.routine.quietHours, threadId: saved.routine.threadId })
        .toEqual({ quietHours: undefined, threadId: undefined, ...shown.fields });
    }
  });

  it('is refused, not shown redacted, when it holds a stored secret, a key or a zero-width character', async () => {
    setRedactedSecrets([{ name: 'GH', value: 'ghp_stored_secret_value_1' }]);
    const r = rig();
    r.ownerSays('make a routine');
    for (const prompt of ['Use ghp_stored_secret_value_1 to read the PRs.', 'Read the PRs​ and reply.', 'token=Zx81qPq7Lm4Rt2Vw9Ks5Yt3Nb6Hd']) {
      expect(await r.setRoutine({ ...DAILY, prompt })).toMatchObject({ ok: false, code: 'invalid_argument' });
    }
    expect(r.approvalCards()).toHaveLength(0);
  });

  it('Approve checks it again: a one-time run that has passed, or a bot switched off', async () => {
    const r = rig();
    r.ownerSays('remind me in an hour');
    const res = await r.setRoutine({ ...DAILY, schedule: { kind: 'once', at: NOW + 3_600_000 } });
    const id = res.approvalId as string;
    r.state.enabled = false;
    expect(r.svc.decide({ requestId: id, decision: 'approve' }, 'desktop')).toMatchObject({ ok: false, code: 'not_now' });
    r.state.enabled = true;
    r.state.now = NOW + 2 * 3_600_000;
    expect(r.svc.decide({ requestId: id, decision: 'approve' }, 'desktop')).toMatchObject({ ok: false, code: 'stale', message: 'at must be in the future' });
    expect(r.svc.get(id)?.state).toBe('expired');
    expect(r.store.list(A)).toEqual([]);
  });

  it('is decided on its desktop card only: not the chip, typed words or the phone', async () => {
    const r = rig();
    r.ownerSays('make a routine');
    const id = (await r.setRoutine(DAILY)).approvalId as string;
    expect(r.svc.decide({ requestId: id, decision: 'approve', source: 'chip' }, 'desktop')).toMatchObject({ ok: false, code: 'not_here' });
    const ok = r.writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: 'ok', refs: { botId: A }, at: NOW });
    if (!ok.ok) throw new Error('not posted');
    expect(r.svc.onOwnerCard(ok.card)).toEqual([]);
    expect(handlePhoneBotApprovalCommand(PHONE_BOT_APPROVAL_DECIDE_COMMAND, { requestId: id, decision: 'approve' }, () => r.svc))
      .toEqual({ refused: { code: 'not_on_phone', message: 'a routine is approved in wmux on its card, where the change is shown' } });
    expect(r.svc.get(id)?.state).toBe('pending');
  });

  it('fits whole on one card at its longest', () => {
    const lines = [
      'Dev asks: Set up this routine you asked for.',
      ...ownerAskedLines('o'.repeat(OWNER_EXCERPT_MAX)),
      ...routineCardLines(
        { title: 't'.repeat(ROUTINE_LIMITS.TITLE_MAX), prompt: 'p'.repeat(ROUTINE_LIMITS.PROMPT_MAX), schedule: { kind: 'daily', hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5] }, quietHours: { start: '22:00', end: '07:00' }, threadId: dmThreadId(A) },
        { botId: A, botName: 'n'.repeat(64), now: NOW, timeZone: 'America/Argentina/ComodRivadavia' },
      ),
    ];
    expect(lines.join('\n').length).toBeLessThan(ROOM_LIMITS.CARD_BODY_MAX);
  });
});

describe('a note the owner asked for in a tainted conversation', () => {
  it('waits on a card; Approve writes it, and there is no Undo', () => {
    const r = rig();
    r.ownerSays('remember: blog posts end with "— E2E team"');
    const res = r.note({ action: 'add', text: 'Blog posts are polite and end with "— E2E team".' });
    expect(res).toMatchObject({ ok: true, pending: true });
    const id = res.ok ? res.approvalId as string : '';
    expect(r.approvalCards()[0].title).toBe('Add this to the bot\'s notes?');
    expect(readMemoryView(dir, 'memory', A).entries).toEqual([]);
    expect(r.svc.decide({ requestId: id, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'approved' } });
    expect(readMemoryView(dir, 'memory', A).entries).toEqual(['Blog posts are polite and end with "— E2E team".']);
    expect(r.svc.decide({ requestId: id, decision: 'undo' }, 'desktop')).toMatchObject({ ok: false, code: 'too_late' });
  });

  it('Approve of a replace whose line changed since expires it', () => {
    const r = rig();
    updateMemory(dir, 'memory', A, { action: 'add', text: 'Deploys on Fridays' });
    r.ownerSays('we deploy on Mondays now');
    const asked = r.note({ action: 'replace', match: 'Fridays', text: 'Deploys on Mondays' });
    const id = asked.ok ? asked.approvalId as string : '';
    updateMemory(dir, 'memory', A, { action: 'replace', match: 'Fridays', text: 'Deploys on Tuesdays' });
    expect(r.svc.decide({ requestId: id, decision: 'approve' }, 'desktop')).toMatchObject({ ok: false, code: 'stale' });
    expect(r.svc.get(id)?.state).toBe('expired');
    expect(readMemoryView(dir, 'memory', A).entries).toEqual(['Deploys on Tuesdays']);
  });

  it('is refused from a conversation holding a signed-in task\'s data, or without the owner\'s card', () => {
    const r = rig();
    r.ownerSays('remember my rule');
    const deps = (signedIn: boolean, proof: OwnerCardProof | null) => ({
      wmuxDir: () => dir, emit: () => undefined, guestWake: () => false as const, tainted: () => false,
      conversation: () => ({ tainted: true, signedIn }), signedIn: () => signedIn, ownerCard: () => proof,
      proposeAsked: r.svc.proposeOwnerAsked.bind(r.svc),
    });
    expect(handleMemoryUpdate({ target: 'memory', action: 'add', text: 'A rule.' }, asBot, deps(true, r.state.proof))).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(handleMemoryUpdate({ target: 'memory', action: 'add', text: 'A rule.' }, asBot, deps(false, null))).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(r.approvalCards()).toHaveLength(0);
  });

  it('a profile change from such a conversation goes to the same kind of card, and its Approve has no Undo either', () => {
    const r = rig();
    r.ownerSays('call me Kim');
    const res = handleMemoryUpdate({ target: 'user', action: 'add', text: 'The owner is Kim.' }, asBot, {
      wmuxDir: () => dir, emit: () => undefined, guestWake: () => false, tainted: () => false,
      conversation: () => ({ tainted: true, signedIn: false }), signedIn: () => false, ownerCard: () => r.state.proof,
      proposeAsked: (bot, ask, proof) => r.svc.proposeOwnerAsked(bot, ask, proof),
    });
    const id = res.ok ? res.approvalId as string : '';
    expect(r.svc.get(id)).toMatchObject({ action: 'owner_profile', ownerCardId: r.state.proof?.cardId });
    expect(r.approvalCards()[0].body).toContain('```text\ncall me Kim\n```');
    expect(r.svc.decide({ requestId: id, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true });
    expect(r.svc.decide({ requestId: id, decision: 'undo' }, 'desktop')).toMatchObject({ ok: false, code: 'too_late' });
  });
});
