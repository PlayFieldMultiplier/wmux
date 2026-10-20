// fact.poll / fact.emit: who may call, workspace scoping, blocking, the draft
// parser, and the module's lifecycle through the real factory host + router.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import type { BotBinding } from '../../../../shared/bot';
import { factDedupeKey, type FactDraft } from '../../../../shared/facts';

vi.mock('../../../deck/taskLedgerHost', () => ({
  getTaskLedger: () => ({ findByTaskWorkspace: () => null, onTransition: () => () => undefined }),
}));

import { handleFactEmit, handleFactPoll, parseFactDraft } from '../fact.rpc';
import { createFactLog, getFactLog, type FactLog } from '../../../factory/factLog';
import { registerFactoryRpc, type FactoryHostDeps } from '../../../factory/factoryHost';
import { RpcRouter } from '../../RpcRouter';
import { mintBotToken, revokeCommanderToken } from '../../../deck/commanderTrust';

const LEAD: BotBinding = { workspaceId: 'ws-a', botId: 'bot-0000000a', role: 'lead' };
const MOA: BotBinding = { workspaceId: 'ws-hq', botId: 'bot-0000000c', role: 'moa' };
const bot = (b: BotBinding): RpcContext => ({ origin: 'local', bot: b, commanderWorkspace: b.workspaceId });
const OPERATOR: RpcContext = { origin: 'local', operator: true, firstParty: true };

const draft = (taskId: string, workspaceId: string): FactDraft => ({
  kind: 'task.done', at: Date.now(), workspaceId, ref: { taskId }, payload: {},
});

let dir: string;
let log: FactLog;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp1-factrpc-'));
  log = createFactLog(dir, { log: () => undefined });
  log.start();
});
afterEach(() => {
  log.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('fact.poll', () => {
  it('refuses a caller that is neither a bot nor the operator (wire, plugin host)', async () => {
    for (const ctx of [undefined, { origin: 'local' as const, externalWire: true as const }, { origin: 'local' as const, firstParty: true }]) {
      expect(await handleFactPoll(log, { sinceSeq: 0 }, ctx)).toMatchObject({ ok: false, code: 'forbidden' });
    }
  });

  it('a bot sees only its own workspace; a Coordinator (by its live profile) and the operator see all', async () => {
    log.append(draft('t1', 'ws-a'));
    log.append(draft('t2', 'ws-b'));
    log.append({ kind: 'merge.done', at: Date.now(), repoKey: 'h/o/r', ref: { pr: 1 }, payload: {} });
    const ids = (r: unknown) => (r as { facts: { seq: number }[] }).facts.map((f) => f.seq);
    const coordinator = (id: string) => id === MOA.botId;
    expect(ids(await handleFactPoll(log, { sinceSeq: 0 }, bot(LEAD), () => null, coordinator))).toEqual([1]);
    expect(ids(await handleFactPoll(log, { sinceSeq: 0 }, bot(MOA), () => null, coordinator))).toEqual([1, 2, 3]);
    expect(ids(await handleFactPoll(log, { sinceSeq: 0 }, OPERATOR))).toEqual([1, 2, 3]);
    // The role tag alone grants nothing: a `moa` binding whose profile is not
    // a Coordinator (or is unknown) reads its own workspace only.
    expect(ids(await handleFactPoll(log, { sinceSeq: 0 }, bot(MOA), () => null, () => false))).toEqual([]);
    expect(ids(await handleFactPoll(log, { sinceSeq: 0 }, bot(MOA)))).toEqual([]);
  });

  it('a bot also sees the facts of the repo its profile acts on (the directory, not a param)', async () => {
    log.append(draft('t2', 'ws-b'));
    log.append({ kind: 'merge.done', at: Date.now(), repoKey: 'github.com/o/r', ref: { pr: 1 }, payload: {} });
    log.append({ kind: 'merge.done', at: Date.now(), repoKey: 'github.com/o/other', ref: { pr: 2 }, payload: {} });
    const ids = (r: unknown) => (r as { facts: { seq: number }[] }).facts.map((f) => f.seq);
    const repoOf = (id: string) => (id === LEAD.botId ? 'github.com/o/r' : null);
    expect(ids(await handleFactPoll(log, { sinceSeq: 0, repoKey: 'github.com/o/other' }, bot(LEAD), repoOf))).toEqual([2]);
    // No repo on the profile: its own workspace only.
    expect(ids(await handleFactPoll(log, { sinceSeq: 0 }, bot(LEAD), () => null))).toEqual([]);
  });

  it('a bot reads no fact its guest view hides; the operator reads all; judged again after a blocking wait', async () => {
    log.append(draft('t-clean', 'ws-a'));
    log.append(draft('t-guest', 'ws-a'));
    const ids = (r: unknown) => (r as { facts: { ref?: { taskId?: string } }[] }).facts.map((f) => f.ref?.taskId);
    let guestWake = false;
    const view = () => (guestWake ? () => true : (f: { ref?: { taskId?: string } }) => !f.ref?.taskId?.startsWith('t-guest'));
    expect(ids(await handleFactPoll(log, { sinceSeq: 0 }, bot(LEAD), () => null, () => false, view))).toEqual(['t-clean']);
    expect(ids(await handleFactPoll(log, { sinceSeq: 0 }, OPERATOR, () => null, () => false, view))).toEqual(['t-clean', 't-guest']);
    guestWake = true;
    expect(ids(await handleFactPoll(log, { sinceSeq: 0 }, bot(LEAD), () => null, () => false, view))).toEqual(['t-clean', 't-guest']);
    // Waiting in a guest-sourced wake that has ended by the time the fact comes.
    const waiting = handleFactPoll(log, { blockMs: 5_000 }, bot(LEAD), () => null, () => false, view);
    guestWake = false;
    expect(log.append(draft('t-guest-2', 'ws-a'))).not.toBeNull();
    const started = Date.now();
    expect(ids(await waiting)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('a workspace param cannot widen a bot read', async () => {
    log.append(draft('t2', 'ws-b'));
    const r = await handleFactPoll(log, { sinceSeq: 0, workspaceId: 'ws-b' }, bot(LEAD));
    expect(r).toMatchObject({ ok: true, facts: [] });
  });

  it('pages with nextSeq and filters by kind', async () => {
    for (let i = 0; i < 3; i++) log.append(draft(`t${i}`, 'ws-a'));
    log.append({ kind: 'task.failed', at: Date.now(), workspaceId: 'ws-a', ref: { taskId: 'x' }, payload: {} });
    const page = await handleFactPoll(log, { sinceSeq: 0, limit: 2 }, bot(LEAD));
    expect(page).toMatchObject({ ok: true, nextSeq: 2 });
    const failed = await handleFactPoll(log, { sinceSeq: 0, kinds: ['task.failed'] }, bot(LEAD));
    expect(failed).toMatchObject({ ok: true, nextSeq: 4, facts: [{ kind: 'task.failed' }] });
  });

  it('omitted sinceSeq starts from now', async () => {
    log.append(draft('t1', 'ws-a'));
    expect(await handleFactPoll(log, {}, bot(LEAD))).toEqual({ ok: true, facts: [], nextSeq: 1 });
  });

  it('refuses bad params and answers unavailable without a log', async () => {
    expect(await handleFactPoll(log, { kinds: ['nope'] }, bot(LEAD))).toMatchObject({ code: 'invalid' });
    expect(await handleFactPoll(log, { sinceSeq: -1 }, bot(LEAD))).toMatchObject({ code: 'invalid' });
    expect(await handleFactPoll(null, {}, bot(LEAD))).toMatchObject({ code: 'unavailable' });
  });

  it('blocks until a matching fact arrives, ignoring other workspaces', async () => {
    const pending = handleFactPoll(log, { blockMs: 5_000 }, bot(LEAD));
    log.append(draft('other', 'ws-b'));
    log.append(draft('mine', 'ws-a'));
    expect(await pending).toMatchObject({ ok: true, nextSeq: 2, facts: [{ ref: { taskId: 'mine' } }] });
  });

  it('a blocking poll re-reads the Coordinator power when the wait ends: demoted meanwhile, its own workspace only', async () => {
    let coordinator = true;
    const pending = handleFactPoll(log, { blockMs: 5_000 }, bot(MOA), () => null, () => coordinator);
    coordinator = false;
    log.append(draft('elsewhere', 'ws-b'));
    log.append(draft('mine', 'ws-hq'));
    expect(await pending).toMatchObject({ ok: true, facts: [{ ref: { taskId: 'mine' } }] });
  });

  it('a blocking poll ends when the caller goes away', async () => {
    const ac = new AbortController();
    const pending = handleFactPoll(log, { blockMs: 60_000 }, { ...bot(LEAD), signal: ac.signal });
    ac.abort();
    expect(await pending).toEqual({ ok: true, facts: [], nextSeq: 0 });
  });
});

describe('fact.emit', () => {
  it('is the operator\'s only: bots (Moa included) and the wire are refused', async () => {
    for (const ctx of [bot(LEAD), bot(MOA), { origin: 'local' as const, externalWire: true as const }, { origin: 'local' as const, firstParty: true }, undefined]) {
      expect(await handleFactEmit(log, { kind: 'human.message', ref: { messageId: 'm1' } }, ctx)).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(log.latestSeq()).toBe(0);
  });

  it('writes an operator fact, then refuses its duplicate', async () => {
    const params = { kind: 'human.message', workspaceId: 'ws-a', ref: { messageId: 'm1' }, payload: { text: 'hi' } };
    expect(await handleFactEmit(log, params, OPERATOR)).toMatchObject({ ok: true, fact: { seq: 1, actor: { kind: 'human' } } });
    expect(await handleFactEmit(log, params, OPERATOR)).toMatchObject({ ok: false, code: 'duplicate' });
  });

  it('refuses a draft without its key parts', async () => {
    expect(await handleFactEmit(log, { kind: 'human.message' }, OPERATOR)).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('parseFactDraft', () => {
  it('rejects unknown fields and malformed parts', () => {
    expect(parseFactDraft({ kind: 'task.done', extra: 1 }, 0).ok).toBe(false);
    expect(parseFactDraft({ kind: 'task.done', ref: { pr: -1 } }, 0).ok).toBe(false);
    expect(parseFactDraft({ kind: 'task.done', ref: { nope: 'x' } }, 0).ok).toBe(false);
    expect(parseFactDraft({ kind: 'task.done', actor: { kind: 'root' } }, 0).ok).toBe(false);
    expect(parseFactDraft({ kind: 'task.done', payload: [] }, 0).ok).toBe(false);
    expect(parseFactDraft({ kind: 'task.done', at: 'now' }, 0).ok).toBe(false);
  });

  it('stores the repo key in its canonical spelling, so dedupe keys match repo watch', () => {
    const a = parseFactDraft({ kind: 'merge.refused', repoKey: 'Acme/App', ref: { pr: 12, headSha: 'a'.repeat(40) } }, 1);
    const b = parseFactDraft({ kind: 'merge.refused', repoKey: 'github.com/acme/app', ref: { pr: 12, headSha: 'a'.repeat(40) } }, 1);
    expect(a.ok && a.draft.repoKey).toBe('github.com/acme/app');
    expect(a.ok && b.ok && factDedupeKey(a.draft)).toBe(b.ok ? factDedupeKey(b.draft) : 'no');
    // A value that is no repo key is kept as given.
    const local = parseFactDraft({ kind: 'merge.done', repoKey: 'local', ref: { pr: 1 } }, 1);
    expect(local.ok && local.draft.repoKey).toBe('local');
  });

  it('fills at, actor and payload', () => {
    expect(parseFactDraft({ kind: 'task.done', ref: { taskId: 't' } }, 42)).toEqual({
      ok: true, draft: { kind: 'task.done', at: 42, ref: { taskId: 't' }, actor: { kind: 'human' }, payload: {} },
    });
  });
});

describe('the facts module', () => {
  let wmuxDir: string;
  const deps = (): FactoryHostDeps => ({
    getMainWindow: () => null,
    getDaemonClient: () => null,
    fanOutService: {} as FactoryHostDeps['fanOutService'],
    invokeRendererRpc: async () => undefined,
    resolvePtyWorkspace: async () => null,
    paneCwd: () => '',
    wmuxDir: () => wmuxDir,
  });
  beforeEach(() => { wmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp1-factmod-')); });
  afterEach(() => { fs.rmSync(wmuxDir, { recursive: true, force: true }); });

  it('start opens the log and ingests; the router serves bots; dispose closes it', async () => {
    const router = new RpcRouter();
    const host = registerFactoryRpc(router, deps());
    expect(host.modules).toContain('facts');
    await host.start();
    const running = getFactLog();
    expect(running).not.toBeNull();
    const emitted = await router.dispatch(
      { id: '0', method: 'fact.emit', params: { kind: 'human.message', workspaceId: 'ws-a', ref: { messageId: 'm1' } } },
      { operator: true },
    );
    expect(emitted).toMatchObject({ ok: true, result: { ok: true, fact: { seq: 1 } } });
    const token = mintBotToken(LEAD);
    try {
      const res = await router.dispatch(
        { id: '1', method: 'fact.poll', params: { sinceSeq: 0 }, commanderToken: token },
        { externalWire: true },
      );
      expect(res).toMatchObject({ ok: true, result: { ok: true, facts: [{ kind: 'human.message', workspaceId: 'ws-a' }] } });
    } finally {
      revokeCommanderToken(token);
    }
    await host.dispose();
    expect(getFactLog()).toBeNull();
    expect(fs.readFileSync(path.join(wmuxDir, 'factory', 'facts.jsonl'), 'utf8')).toContain('human.message');
  });
});
