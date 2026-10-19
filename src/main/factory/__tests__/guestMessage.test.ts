// main's side of a guest bot's post (`workspaces.guestPost`): one guest card
// in the guest's stored conversation, wakes only for that conversation's
// bots, and every such wake tainted.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotProfile } from '../../../shared/bot';
import { RoomWriter, type FactoryRoomPorts } from '../roomWriter';
import { handleGuestPost, postGuestMessage, setGuestPostHandler } from '../guestMessage';
import { WakeTaint } from '../wakeTaint';

const GUEST_ID = '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
let dir = '';

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-guest-post-')); });
afterEach(() => {
  setGuestPostHandler(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function bot(id: string, ws: string, enabled = true): BotProfile {
  return {
    version: 1, id, workspaceId: ws, role: 'lead', name: id, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
    enabled, createdAt: 1, updatedAt: 1,
  };
}

const A = 'bot-0000aaaa';
const B = 'bot-0000bbbb';
const OTHER = 'bot-0000cccc';

function setup(groups: Record<string, string[]> = {}) {
  const bots = [bot(A, 'ws-1'), bot(B, 'ws-1'), bot(OTHER, 'ws-2')];
  const writer = new RoomWriter({ dir, now: () => 1_000, log: () => undefined });
  const enqueue = vi.fn((item: Record<string, unknown>) => ({ id: `w-${String(item.botId)}`, ...item }));
  const ports = {
    bots: { listEnabled: () => bots.filter((b) => b.enabled), get: (id: string) => bots.find((b) => b.id === id) ?? null },
    groups: { byThread: (_ws: string, threadId: string) => (groups[threadId] ? { memberIds: groups[threadId] } : null) },
    wakes: { enqueue },
  } as unknown as Partial<FactoryRoomPorts>;
  const deps = { enabled: () => true, writer: () => writer, ports: () => ports };
  return { writer, enqueue, deps };
}

const base = {
  guestId: GUEST_ID, guestName: 'Grok', workspaceId: 'ws-1', threadId: `dm:${A}`,
  clientMessageId: 'm1', text: 'hello there', mentions: [A],
};

describe('postGuestMessage', () => {
  it('writes one guest card (system actor, labelled title) and wakes the named bot at priority 2', () => {
    const { writer, enqueue, deps } = setup();
    const r = postGuestMessage(base, deps);
    expect(r).toMatchObject({ ok: true, woke: [A] });
    const card = writer.find('ws-1', (c) => c.kind === 'guest', { guests: true });
    expect(card).toMatchObject({
      kind: 'guest', actor: { kind: 'system' }, threadId: `dm:${A}`, title: 'External guest: Grok',
      body: 'hello there', guest: { guestId: GUEST_ID, name: 'Grok' }, clientPostId: `guest:${GUEST_ID}:m1`,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      botId: A, priority: 2, reason: { kind: 'guest', guestId: GUEST_ID, cardId: card!.id, text: 'hello there' },
    });
  });

  it('a post without mentions wakes nobody', () => {
    const { enqueue, deps } = setup();
    expect(postGuestMessage({ ...base, mentions: [] }, deps)).toMatchObject({ ok: true, woke: [] });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses to name a bot outside the conversation', () => {
    const { writer, enqueue, deps } = setup();
    expect(postGuestMessage({ ...base, mentions: [B] }, deps)).toEqual({ ok: false, code: 'mention_refused' });
    expect(postGuestMessage({ ...base, threadId: 'general', mentions: [OTHER] }, deps)).toEqual({ ok: false, code: 'mention_refused' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(writer.find('ws-1', (c) => c.kind === 'guest', { guests: true })).toBeFalsy();
  });

  it('a group takes only its members; General the room\'s bots', () => {
    const { enqueue, deps } = setup({ 'group:grp-0000abcd': [B] });
    expect(postGuestMessage({ ...base, threadId: 'group:grp-0000abcd', mentions: [A] }, deps)).toEqual({ ok: false, code: 'mention_refused' });
    expect(postGuestMessage({ ...base, threadId: 'group:grp-0000abcd', mentions: [B] }, deps)).toMatchObject({ ok: true, woke: [B] });
    expect(postGuestMessage({ ...base, clientMessageId: 'm2', threadId: 'general', mentions: [A, B] }, deps)).toMatchObject({ ok: true, woke: [A, B] });
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it('a conversation that is gone is scope_gone', () => {
    const { deps } = setup();
    expect(postGuestMessage({ ...base, threadId: 'dm:bot-0000dddd', mentions: [] }, deps)).toEqual({ ok: false, code: 'scope_gone' });
    expect(postGuestMessage({ ...base, threadId: 'dm:' + OTHER, mentions: [] }, deps)).toEqual({ ok: false, code: 'scope_gone' });
    expect(postGuestMessage({ ...base, threadId: 'group:grp-0000ffff', mentions: [] }, deps)).toEqual({ ok: false, code: 'scope_gone' });
  });

  it('is idempotent per message id, and a reused id with other words is refused', () => {
    const { enqueue, deps } = setup();
    const first = postGuestMessage(base, deps);
    const again = postGuestMessage(base, deps);
    expect(again).toMatchObject({ ok: true, duplicate: true, woke: [A] });
    expect(first.ok && again.ok && again.cardId === first.cardId).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(postGuestMessage({ ...base, text: 'other words' }, deps)).toEqual({ ok: false, code: 'id_reused' });
  });

  it('rejects a malformed payload and answers factory_off when off', () => {
    const { deps } = setup();
    for (const bad of [
      { ...base, guestId: 'nope' }, { ...base, guestName: '' }, { ...base, clientMessageId: 'a b' },
      { ...base, text: '  ' }, { ...base, text: 'x'.repeat(4001) }, { ...base, mentions: ['x'] },
      { ...base, mentions: [A, A, A, A, A] }, { ...base, threadId: 'task:1' }, { ...base, workspaceId: '../x' },
    ]) {
      expect(postGuestMessage(bad, deps)).toEqual({ ok: false, code: 'invalid' });
    }
    expect(postGuestMessage(base, { ...deps, enabled: () => false })).toEqual({ ok: false, code: 'factory_off' });
  });

  it('the bridge command answers factory_off with no handler and busy when it throws', async () => {
    expect(await handleGuestPost(base)).toEqual({ ok: false, code: 'factory_off' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setGuestPostHandler(async () => { throw new Error('boom'); });
    expect(await handleGuestPost(base)).toEqual({ ok: false, code: 'busy' });
  });

  it('a guest wake is always tainted', () => {
    const t = new WakeTaint({
      facts: () => [], handoff: () => null, taskRow: () => null, runningWake: () => null,
      file: path.join(dir, 'taint.json'), log: () => undefined,
    });
    expect(t.reasonTainted({ kind: 'guest', guestId: GUEST_ID, guestName: 'Grok', cardId: 'c', text: 'x' })).toBe(true);
  });
});
