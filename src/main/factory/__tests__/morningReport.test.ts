// The morning wake: one schedule.fired fact for the HQ workspace whose
// payload is the day's data (trust, merged, blocked, rooms, corrections),
// bounded to a fact payload; and the owner's answer to a plan goes back to
// Moa (approve / edit) or nowhere (decline).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOT_BUDGETS, type BotProfile, type BotRole } from '../../../shared/bot';
import { FACT_LIMITS, type FactDraft } from '../../../shared/facts';
import type { RoomCard } from '../../../shared/room';
import { createFactLog } from '../factLog';
import { RoomWriter } from '../roomWriter';
import {
  boundMorningPayload,
  buildMorningData,
  factsSince,
  fireMorningReport,
  hqBot,
  parseResolution,
  routePlanAnswer,
  TRUST_SNAPSHOTS_FILENAME,
  type MorningData,
  type MorningPorts,
} from '../morningReport';

const NOW = Date.parse('2026-10-12T09:00:00Z');
const HOUR = 3_600_000;

function bot(id: string, role: BotRole, workspaceId: string, repoPath?: string, createdAt = 1): BotProfile {
  return {
    version: 1, id, workspaceId, role, name: role, engine: { kind: 'claude-sdk' }, triggers: [], budget: { ...DEFAULT_BOT_BUDGETS[role] },
    ...(repoPath ? { repo: { repoKey: 'x', repoPath } } : {}), enabled: true, createdAt, updatedAt: 1,
  };
}

const BOTS = [bot('bot-00000001', 'moa', 'ws-hq', undefined, 1), bot('bot-00000002', 'lead', 'ws-a', '/repo/a', 2), bot('bot-00000003', 'verifier', 'ws-a', '/repo/a', 3)];
const directory = (bots: BotProfile[] = BOTS) => ({ listEnabled: () => bots, get: (id: string) => bots.find((b) => b.id === id) ?? null });

function rig(over: Partial<MorningPorts> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp6-morning-'));
  const log = createFactLog(path.join(dir, 'factory'), { now: () => NOW });
  log.start();
  const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), now: () => NOW });
  const add = (d: Omit<FactDraft, 'at'> & { at?: number }) => log.append({ at: NOW - HOUR, ...d } as FactDraft);
  const trust = vi.fn(async (_p: string, since: number, now: number) => ({
    ok: true as const, ref: 'origin/main', unattributedCommits: 0,
    analysis: { since, now, totals: { merged: 9, revertPrs: 1, reverted: 1, revertRate: 1 / 9, eligible7d: 5, survived7d: 4, survivalRate7d: 0.8, medianTimeToRevertHours: 5 }, reverted: [], revertPrs: [] },
  }));
  const ports: MorningPorts = {
    factLog: () => log,
    bots: () => directory(),
    rooms: () => writer,
    trust,
    repoKeyOf: async (p) => (p === '/repo/a' ? 'github.com/o/a' : null),
    corrections: () => [{ key: 'lead:missing-test', count: 3, factIds: ['f1', 'f2', 'f3'], workspaceIds: ['ws-a'], notes: [] }],
    factoryDir: path.join(dir, 'factory'),
    now: () => NOW,
    ...over,
  };
  return { ports, log, writer, add, trust, dir };
}

describe('morning report', () => {
  it('assembles trust, merged, blocked, rooms and correction patterns from the last day', async () => {
    const r = rig();
    r.add({ kind: 'merge.done', repoKey: 'github.com/o/a', ref: { pr: 11 }, workspaceId: 'ws-a', payload: {} });
    r.add({ kind: 'merge.done', repoKey: 'github.com/o/a', ref: { pr: 9 }, at: NOW - 30 * HOUR, payload: {} });
    r.add({ kind: 'merge.refused', repoKey: 'github.com/o/a', ref: { pr: 12, headSha: 'b'.repeat(40) }, payload: { reasons: ['no-required-checks', 'external-author'] } });
    r.add({ kind: 'task.failed', ref: { taskId: 'task-9' }, workspaceId: 'ws-a', payload: {} });
    r.add({ kind: 'bot.budget_exhausted', ref: { botId: 'bot-00000003' }, payload: {} });
    r.writer.append({ workspaceId: 'ws-a', threadId: 'pr:github.com/o/a#12', kind: 'status', actor: { kind: 'system' }, title: 'blocked on checks' });
    const d = await buildMorningData(r.ports);
    expect(d.trust).toEqual([{ repoKey: 'github.com/o/a', totals: expect.objectContaining({ merged: 9, survivalRate7d: 0.8 }) }]);
    expect(r.trust).toHaveBeenCalledWith('/repo/a', NOW - 30 * 86_400_000, NOW);
    expect(d.merged).toEqual([{ repoKey: 'github.com/o/a', pr: 11, workspaceId: 'ws-a' }]);
    expect(d.mergedCount).toBe(1);
    expect(d.blocked).toEqual([
      { kind: 'merge.refused', repoKey: 'github.com/o/a', pr: 12, reasons: ['no-required-checks', 'external-author'] },
      { kind: 'task.failed', taskId: 'task-9', workspaceId: 'ws-a' },
    ]);
    expect(d.budgetExhausted).toEqual(['bot-00000003']);
    expect(d.rooms.find((x) => x.workspaceId === 'ws-a')).toMatchObject({ openThreads: 1, newest: [{ threadId: 'pr:github.com/o/a#12', title: 'blocked on checks' }] });
    expect(d.gardener).toEqual([{ key: 'lead:missing-test', count: 3, factIds: ['f1', 'f2', 'f3'] }]);
    const snap = fs.readFileSync(path.join(r.dir, 'factory', TRUST_SNAPSHOTS_FILENAME), 'utf8').trim().split('\n');
    expect(JSON.parse(snap[0])).toMatchObject({ at: NOW, repoKey: 'github.com/o/a', totals: { merged: 9 } });
  });

  it('another bot\'s 1:1 counts as an open thread, but its title is not listed; the Coordinator\'s own 1:1 is', async () => {
    const r = rig();
    r.writer.append({ workspaceId: 'ws-a', threadId: 'dm:bot-00000002', kind: 'human', actor: { kind: 'human' }, title: 'Q3 revenue is 4.2M' });
    r.writer.append({ workspaceId: 'ws-a', threadId: 'pr:github.com/o/a#12', kind: 'status', actor: { kind: 'system' }, title: 'blocked on checks' });
    r.writer.append({ workspaceId: 'ws-hq', threadId: 'dm:bot-00000001', kind: 'human', actor: { kind: 'human' }, title: 'plan the week' });
    const d = await buildMorningData(r.ports);
    expect(d.rooms.find((x) => x.workspaceId === 'ws-a')).toMatchObject({ openThreads: 2, newest: [{ threadId: 'pr:github.com/o/a#12', title: 'blocked on checks' }] });
    expect(JSON.stringify(d)).not.toContain('Q3 revenue');
    expect(d.rooms.find((x) => x.workspaceId === 'ws-hq')?.newest).toEqual([{ threadId: 'dm:bot-00000001', title: 'plan the week' }]);
  });

  it('fires ONE schedule.fired fact for the HQ workspace per schedule per day', async () => {
    const r = rig();
    const first = await fireMorningReport('morning', r.ports);
    expect(first).toMatchObject({ ok: true, hqBotId: 'bot-00000001', fact: { kind: 'schedule.fired', workspaceId: 'ws-hq', ref: { scheduleId: 'morning', botId: 'bot-00000001' } } });
    const payload = (first as unknown as { fact: { payload: { morning: MorningData } } }).fact.payload;
    expect(payload.morning.trust).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(FACT_LIMITS.PAYLOAD_MAX_BYTES);
    expect(await fireMorningReport('morning', r.ports)).toMatchObject({ ok: false, code: 'duplicate' });
  });

  it('reads the whole retained window: recent facts behind many older ones are found', () => {
    const old = Array.from({ length: 25_000 }, (_, i) => ({ id: `o${i}`, seq: i + 1, kind: 'merge.done', at: NOW - 9 * 86_400_000, dedupeKey: `o${i}`, payload: {} }));
    const all = [...old, { id: 'recent', seq: 25_001, kind: 'merge.done', at: NOW - HOUR, dedupeKey: 'r', payload: {} }] as unknown as import('../../../shared/facts').Fact[];
    const log = {
      append: () => null, subscribe: () => () => undefined,
      readSince: (cursor: string | null, _f: unknown, limit = 200) => {
        const n = cursor ? Number(cursor) : 0;
        const facts = all.slice(n, n + limit);
        return { facts, cursor: String(n + facts.length) };
      },
      readWhere: (after: number, match: (f: (typeof all)[number]) => boolean, limit: number) => {
        const facts = all.filter((f) => f.seq > after && match(f)).slice(0, limit);
        return { facts, lastSeq: all.length };
      },
    };
    expect(factsSince(log, NOW - 86_400_000).map((f) => f.id)).toEqual(['recent']);
  });

  it('the fact it writes fits the payload limit even when the data had to be trimmed', async () => {
    const r = rig();
    const many = Array.from({ length: 60 }, (_, i) => bot(`bot-1${String(i).padStart(7, '0')}`, 'lead', `ws-${'w'.repeat(40)}-${i}`, undefined, 10 + i));
    for (let i = 0; i < 40; i++) r.add({ kind: 'merge.refused', repoKey: `github.com/some-owner/some-repository-${i}`, ref: { pr: i + 1, headSha: 'c'.repeat(40) }, payload: { reasons: Array.from({ length: 5 }, (_, k) => `${'reason-'.repeat(8)}${k}`) } });
    for (let i = 0; i < 20; i++) r.add({ kind: 'merge.done', repoKey: `github.com/${'o'.repeat(60)}/${'r'.repeat(60)}-${i}`, ref: { pr: 100 + i }, workspaceId: `ws-${'x'.repeat(60)}`, payload: {} });
    const res = await fireMorningReport('m2', { ...r.ports, bots: () => directory([...BOTS, ...many]) });
    expect(res.ok).toBe(true);
    const fact = (res as unknown as { fact: { payload: Record<string, unknown> } }).fact;
    expect(fact.payload.trimmed).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(fact.payload))).toBeLessThanOrEqual(FACT_LIMITS.PAYLOAD_MAX_BYTES);
  });

  it('without an HQ bot or a fact log nothing is written', async () => {
    expect(await fireMorningReport('m', rig({ bots: () => directory(BOTS.slice(1)) }).ports)).toMatchObject({ ok: false, code: 'no_hq_bot' });
    expect(await fireMorningReport('m', rig({ factLog: () => null }).ports)).toMatchObject({ ok: false, code: 'no_fact_log' });
    expect(hqBot(directory([bot('bot-0000000a', 'moa', 'ws-2', undefined, 5), bot('bot-0000000b', 'moa', 'ws-1', undefined, 2)]))?.id).toBe('bot-0000000b');
  });

  it('a failing source is left out, never fails the report', async () => {
    const r = rig({ trust: async () => { throw new Error('git'); }, rooms: () => null, corrections: () => { throw new Error('x'); } });
    const d = await buildMorningData(r.ports);
    expect(d.trust[0]).toMatchObject({ repoKey: 'github.com/o/a', error: expect.stringContaining('git') });
    expect(d.rooms.every((x) => x.openThreads === 0)).toBe(true);
    expect(d.gardener).toEqual([]);
  });

  it('bounds the payload: lists shrink, counts stay', () => {
    const big: MorningData = {
      at: NOW, windowHours: 24, trust: [], mergedCount: 500, blockedCount: 500, budgetExhausted: [],
      merged: Array.from({ length: 15 }, (_, i) => ({ repoKey: `github.com/some-long-owner-name/some-long-repository-name-${i}`, pr: i, workspaceId: `ws-${'x'.repeat(60)}` })),
      blocked: Array.from({ length: 10 }, (_, i) => ({ kind: 'merge.refused' as const, repoKey: `github.com/o/r${i}`, pr: i, reasons: Array.from({ length: 5 }, () => 'x'.repeat(60)) })),
      rooms: Array.from({ length: 10 }, (_, i) => ({ workspaceId: `ws-${i}`, openThreads: 3, openQuestions: 1, newest: Array.from({ length: 3 }, () => ({ threadId: `task:${'t'.repeat(60)}`, title: 'y'.repeat(80) })) })),
      gardener: [],
    };
    const { morning, trimmed } = boundMorningPayload(big);
    expect(trimmed).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ morning }))).toBeLessThanOrEqual(FACT_LIMITS.PAYLOAD_MAX_BYTES);
    expect(morning.mergedCount).toBe(500);
    expect(boundMorningPayload({ ...big, merged: [], blocked: [], rooms: [] }).trimmed).toBe(false);
  });
});

describe('the owner\'s answer to a plan', () => {
  const card = (over: Partial<RoomCard> = {}): RoomCard => ({
    version: 1, id: 'c-1', seq: 3, workspaceId: 'ws-hq', threadId: 'plan:p-1', kind: 'plan', at: 1,
    actor: { kind: 'bot', workspaceId: 'ws-hq', botId: 'bot-00000001' }, title: 'Plan for Monday', state: 'resolved', ...over,
  });

  it('parses approve / decline / edit', () => {
    expect(parseResolution('Approve')).toBe('approve');
    expect(parseResolution('yes, items 1 and 3')).toBe('approve');
    expect(parseResolution('LGTM')).toBe('approve');
    expect(parseResolution('decline')).toBe('decline');
    expect(parseResolution('no')).toBe('decline');
    expect(parseResolution('drop item 2, then go')).toBe('edit');
    expect(parseResolution('nothing like this')).toBe('edit');
  });

  it('approve and edit wake Moa in the plan\'s thread with the owner\'s words; decline wakes nobody', () => {
    const wake = vi.fn();
    const ports = { bots: () => directory(), wake };
    expect(routePlanAnswer({ workspaceId: 'ws-hq', card: card(), resolution: 'approve' }, ports)).toBe('woken');
    expect(wake).toHaveBeenLastCalledWith({
      botId: 'bot-00000001', workspaceId: 'ws-hq', priority: 0, threadId: 'plan:p-1',
      reason: { kind: 'human', source: 'desktop', text: 'I approved your plan "Plan for Monday" (card c-1): approve' },
    });
    expect(routePlanAnswer({ workspaceId: 'ws-hq', card: card(), resolution: 'swap 1 and 2' }, ports)).toBe('woken');
    expect(wake.mock.calls[1][0].reason.text).toMatch(/^I answered your plan/);
    expect(routePlanAnswer({ workspaceId: 'ws-hq', card: card(), resolution: 'decline' }, ports)).toBe('declined');
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('a guest-sourced plan card\'s answer wakes nobody', () => {
    const wake = vi.fn();
    expect(routePlanAnswer({ workspaceId: 'ws-hq', card: card({ origin: 'guest' }), resolution: 'approve' }, { bots: () => directory(), wake })).toBe('ignored');
    expect(wake).not.toHaveBeenCalled();
  });

  it('only plan cards a bot posted: any enabled bot\'s plan answer wakes its author', () => {
    const wake = vi.fn();
    const ports = { bots: () => directory(), wake };
    expect(routePlanAnswer({ workspaceId: 'ws-hq', card: card({ kind: 'proposal' }), resolution: 'approve' }, ports)).toBe('ignored');
    expect(routePlanAnswer({ workspaceId: 'ws-hq', card: card({ actor: { kind: 'human' } }), resolution: 'approve' }, ports)).toBe('ignored');
    expect(routePlanAnswer({ workspaceId: 'ws-a', card: card({ actor: { kind: 'bot', workspaceId: 'ws-a', botId: 'bot-0000ffff' } }), resolution: 'approve' }, ports)).toBe('ignored');
    expect(wake).not.toHaveBeenCalled();
    expect(routePlanAnswer({ workspaceId: 'ws-a', card: card({ actor: { kind: 'bot', workspaceId: 'ws-a', botId: 'bot-00000002' } }), resolution: 'approve' }, ports)).toBe('woken');
    expect(wake.mock.calls[0][0]).toMatchObject({ botId: 'bot-00000002' });
  });
});
