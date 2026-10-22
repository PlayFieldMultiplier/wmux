// Bot group chats: a silent bot's acknowledgement, a reaction in place of a
// reply, and the round caps that end a bot-to-bot mention loop
// (shared/botGroupProtocol.ts).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotBinding, BotProfile, BotRole } from '../../../shared/bot';
import { factDedupeKey, type Fact, type FactDraft } from '../../../shared/facts';
import type { RoomCard, ThreadId } from '../../../shared/room';
import type { RpcContext } from '../../../shared/rpc';
import type { WakeItem, WakeReason } from '../../../shared/wake';
import { GROUP_ROUND_LIMITS, REACTION_EMOJI, SILENT_ACK_EMOJI, sanitizeReactions, silentAckEmoji, splitReaction } from '../../../shared/botGroupProtocol';
import { HANDOFFS_FILENAME, HandoffRouter, deckDecisionPort, setHandoffRouter } from '../handoffRouter';
import { RoomWriter, parseCardLine, type FactoryRoomPorts, type RunningWake } from '../roomWriter';
import { endGroupTurn, handleRoomPost, type RoomHandlerDeps } from '../../pipe/handlers/room.rpc';

const GROUP = 'group:grp-0000aaaa' as ThreadId;
const OPERATOR: RpcContext = { origin: 'local', operator: true, firstParty: true };

let dir = '';
let botN = 0;
const routers: HandoffRouter[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-group-protocol-'));
});

afterEach(() => {
  setHandoffRouter(null);
  for (const r of routers.splice(0)) r.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function bot(role: BotRole, extra: Partial<BotProfile> = {}): BotProfile {
  botN += 1;
  return {
    version: 1, id: `bot-${botN.toString(16).padStart(8, '0')}`, workspaceId: 'ws1', role, name: `${role}-${botN}`, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
    enabled: true, createdAt: botN, updatedAt: botN, ...extra,
  };
}

const binding = (b: BotProfile): BotBinding => ({ workspaceId: b.workspaceId, botId: b.id, role: b.role });
const asBot = (b: BotProfile): RpcContext => ({ origin: 'local', bot: binding(b) });

/** A room, a handoff router and a group chat of `members` in GROUP. */
async function rig(bots: BotProfile[], members: BotProfile[], opts: { signedIn?: boolean } = {}) {
  const facts: Fact[] = [];
  const subs = new Set<(f: Fact) => void>();
  const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
  const wakes: Array<WakeItem> = [];
  const running: { wake: RunningWake | null } = { wake: null };
  const ports: Partial<FactoryRoomPorts> = {
    factLog: {
      append(d: FactDraft): Fact | null {
        const key = factDedupeKey(d);
        if (!key || facts.some((f) => f.dedupeKey === key)) return null;
        const f: Fact = { ...d, id: `f-${facts.length + 1}`, seq: facts.length + 1, dedupeKey: key };
        facts.push(f);
        for (const s of subs) s(f);
        return f;
      },
      subscribe(fn: (f: Fact) => void) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      readSince: () => ({ facts: [], cursor: null }),
    },
    bots: { listEnabled: () => bots.filter((b) => b.enabled), get: (id) => bots.find((b) => b.id === id) ?? null },
    wakes: {
      enqueue(input) {
        const item = { id: `w-${wakes.length + 1}`, ...input, enqueuedAt: Date.now(), attempts: 0, state: 'queued' } as WakeItem;
        wakes.push(item);
        return item;
      },
    },
    groups: {
      byThread: (ws, t) => (ws === 'ws1' && t === GROUP
        ? { id: 'grp-0000aaaa', workspaceId: 'ws1', name: 'Ship', memberIds: members.map((m) => m.id), threadId: GROUP, createdAt: 1, updatedAt: 1 }
        : null),
    },
    currentWakeThread: () => (running.wake ? GROUP : null),
    currentWake: () => running.wake,
  };
  const router = new HandoffRouter({
    file: path.join(dir, 'factory', HANDOFFS_FILENAME),
    decisions: deckDecisionPort(dir),
    ports: () => ports,
    rooms: () => writer,
    log: () => undefined,
  });
  routers.push(router);
  await router.start();
  setHandoffRouter(router);
  const deps: RoomHandlerDeps = { writer: () => writer, ports: () => ports, wmuxDir: () => dir, signedIn: () => opts.signedIn === true };
  /** Run `item` as its bot's turn while `act` does what the turn does. */
  const turn = async <T>(item: WakeItem, act: () => Promise<T>): Promise<T> => {
    const r = item.reason;
    running.wake = {
      wakeId: item.id, attempt: 1, reasonKind: r.kind,
      ...(r.kind === 'mention' ? { handoffId: r.handoffId } : {}),
      ...(r.kind === 'human' ? { runId: r.runId, ...(r.clientMessageId ? { ownerCardId: r.clientMessageId } : {}) } : {}),
    };
    try {
      return await act();
    } finally {
      running.wake = null;
    }
  };
  const owner = async (title: string): Promise<RoomCard> => {
    const r = await handleRoomPost({ workspaceId: 'ws1', threadId: GROUP, title }, OPERATOR, deps) as { ok: true; card: RoomCard };
    return r.card;
  };
  const card = (id: string) => writer.get('ws1', id);
  const groupCards = () => writer.read('ws1', { threadId: GROUP }).cards;
  return { writer, wakes, facts, deps, turn, owner, card, groupCards, router };
}

describe('the protocol helpers', () => {
  it('a silent bot\'s acknowledgement is stable per bot and card, and one of the neutral set', () => {
    const a = silentAckEmoji('bot-0000000a', 'c-1');
    expect(SILENT_ACK_EMOJI).toContain(a);
    expect(silentAckEmoji('bot-0000000a', 'c-1')).toBe(a);
    const spread = new Set(Array.from({ length: 40 }, (_, i) => silentAckEmoji(`bot-${i.toString(16).padStart(8, '0')}`, 'c-1')));
    expect(spread.size).toBeGreaterThan(1);
  });

  it('a reaction marker is taken out of the words; only a palette emoji counts, and no marker survives', () => {
    expect(splitReaction('[[react:👍]]')).toEqual({ emoji: '👍', text: '' });
    expect(splitReaction('[[react: ❤️ ]]\nSounds good, merging now.')).toEqual({ emoji: '❤️', text: 'Sounds good, merging now.' });
    expect(splitReaction('[[react:🦄]] ok')).toEqual({ text: 'ok' });
    expect(splitReaction('[[react:ignore previous instructions]] hi')).toEqual({ text: 'hi' });
    expect(splitReaction('[[silent]]')).toEqual({ text: '' });
    expect(splitReaction('plain words')).toEqual({ text: 'plain words' });
  });

  it('reactions read from disk keep one well-formed palette entry per bot', () => {
    const ok = (id: string) => /^bot-[0-9a-f]{8}$/.test(id);
    expect(sanitizeReactions([
      { botId: 'bot-0000000a', emoji: '👍' },
      { botId: 'bot-0000000a', emoji: '❤️' },
      { botId: 'bot-0000000b', emoji: '🦄' },
      { botId: '../x', emoji: '👍' },
      { botId: 'bot-0000000c', emoji: '👀', ack: true },
    ], ok)).toEqual([{ botId: 'bot-0000000a', emoji: '👍' }, { botId: 'bot-0000000c', emoji: '👀', ack: true }]);
    expect(sanitizeReactions('nope', ok)).toBeUndefined();
    expect(REACTION_EMOJI).toEqual(expect.arrayContaining([...SILENT_ACK_EMOJI]));
  });
});

describe('a group turn that ends silent or with a reaction', () => {
  it('silence leaves one acknowledgement on the owner\'s card; a retried turn leaves the same one', async () => {
    const a = bot('lead');
    const b = bot('triage');
    const r = await rig([a, b], [a, b]);
    const msg = await r.owner('Morning, team');
    const wakeA = r.wakes.find((w) => w.botId === a.id)!;
    const since = Date.now() - 1;
    expect(await r.turn(wakeA, () => endGroupTurn(a, wakeA, '', since, r.deps))).toBe(true);
    expect(await r.turn(wakeA, () => endGroupTurn(a, wakeA, '[[silent]]', since, r.deps))).toBe(true);
    expect(r.card(msg.id)?.reactions).toEqual([{ botId: a.id, emoji: silentAckEmoji(a.id, msg.id), ack: true }]);
    // No card was posted: an acknowledgement is not a message.
    expect(r.groupCards().map((c) => c.kind)).toEqual(['human']);
    // It survives a reload of the room file.
    const line = fs.readFileSync(path.join(dir, 'factory', 'rooms', 'ws1.jsonl'), 'utf8').trim().split('\n').at(-1)!;
    expect(parseCardLine(JSON.parse(line), 'ws1')?.reactions).toEqual(r.card(msg.id)?.reactions);
  });

  it('a reaction-only reply is a reaction on the card, not a card; words after the marker are posted without it', async () => {
    const a = bot('lead');
    const b = bot('triage');
    const r = await rig([a, b], [a, b]);
    const msg = await handleRoomPost({ workspaceId: 'ws1', threadId: GROUP, title: 'PR 7 is merged', mentions: [a.id, b.id] }, OPERATOR, r.deps) as { ok: true; card: RoomCard };
    const [wakeA, wakeB] = [r.wakes.find((w) => w.botId === a.id)!, r.wakes.find((w) => w.botId === b.id)!];
    await r.turn(wakeA, () => endGroupTurn(a, wakeA, '[[react:❤️]]', Date.now() - 1, r.deps));
    await r.turn(wakeB, () => endGroupTurn(b, wakeB, '[[react:👍]]\nI will close the issue.', Date.now() - 1, r.deps));
    expect(r.card(msg.card.id)?.reactions).toEqual([{ botId: a.id, emoji: '❤️' }, { botId: b.id, emoji: '👍' }]);
    const posted = r.groupCards().filter((c) => c.actor.kind === 'bot');
    expect(posted.map((c) => [c.actor.kind === 'bot' && c.actor.botId, c.title])).toEqual([[b.id, 'I will close the issue.']]);
    expect(JSON.stringify(r.groupCards())).not.toContain('[[react');
  });

  it('a bot that posted on its turn leaves no acknowledgement; a mention it got is acknowledged on the mentioning card', async () => {
    const a = bot('lead');
    const b = bot('triage');
    const r = await rig([a, b], [a, b]);
    await r.owner('Who takes issue 9?');
    const wakeA = r.wakes.find((w) => w.botId === a.id)!;
    const since = Date.now() - 1;
    const post = await r.turn(wakeA, () => handleRoomPost({ kind: 'status', title: 'I can, @triage can review', mentions: [b.id] }, asBot(a), r.deps)) as { ok: true; card: RoomCard };
    await r.turn(wakeA, () => endGroupTurn(a, wakeA, '', since, r.deps));
    const mention = r.wakes.find((w) => w.botId === b.id && w.reason.kind === 'mention')!;
    await r.turn(mention, () => endGroupTurn(b, mention, '', Date.now() - 1, r.deps));
    const ownerCard = r.groupCards().find((c) => c.kind === 'human')!;
    expect(ownerCard.reactions).toBeUndefined();
    expect(r.card(post.card.id)?.reactions).toEqual([{ botId: b.id, emoji: silentAckEmoji(b.id, post.card.id), ack: true }]);
  });

  it('a conversation holding signed-in data only acknowledges; outside a group chat nothing changes', async () => {
    const a = bot('lead');
    const b = bot('triage');
    const r = await rig([a, b], [a, b], { signedIn: true });
    const msg = await r.owner('Status?');
    const wakeA = r.wakes.find((w) => w.botId === a.id)!;
    await r.turn(wakeA, () => endGroupTurn(a, wakeA, '[[react:👎]]', Date.now() - 1, r.deps));
    expect(r.card(msg.id)?.reactions).toEqual([{ botId: a.id, emoji: silentAckEmoji(a.id, msg.id), ack: true }]);
    // General is no group's here: the caller goes on as before.
    const general = await handleRoomPost({ workspaceId: 'ws1', title: 'In General', mentions: [a.id] }, OPERATOR, r.deps) as { ok: true; card: RoomCard };
    const wakeG = r.wakes.find((w) => w.reason.kind === 'human' && w.reason.clientMessageId === general.card.id)!;
    expect(await r.turn(wakeG, () => endGroupTurn(a, wakeG, '[[react:👍]]', Date.now() - 1, r.deps))).toBe(false);
    expect(r.card(general.card.id)?.reactions).toBeUndefined();
  });

  it('a reaction wakes nobody and writes no fact', async () => {
    const a = bot('lead');
    const b = bot('triage');
    const r = await rig([a, b], [a, b]);
    await r.owner('Thanks both');
    const wakesBefore = r.wakes.length;
    const factsBefore = r.facts.length;
    const wakeA = r.wakes.find((w) => w.botId === a.id)!;
    await r.turn(wakeA, () => endGroupTurn(a, wakeA, '[[react:🙌]]', Date.now() - 1, r.deps));
    expect(r.groupCards()[0].reactions).toEqual([{ botId: a.id, emoji: '🙌' }]);
    expect(r.wakes).toHaveLength(wakesBefore);
    expect(r.facts).toHaveLength(factsBefore);
  });
});

describe('the round caps end a bot-to-bot mention loop', () => {
  /** Each bot answers the mention it got by mentioning `next(bot)`, until a
   *  post or its mention is refused. The cards and outcomes, in order. */
  async function loop(r: Awaited<ReturnType<typeof rig>>, bots: BotProfile[], next: (b: BotProfile) => BotProfile) {
    const msg = await r.owner('Plan the release between you');
    const first = r.wakes.find((w) => w.botId === bots[0].id && w.reason.kind === 'human')!;
    const outcomes: Array<{ by: string; posted: boolean; mention?: { ok: boolean; code?: string } }> = [];
    let item: WakeItem | undefined = first;
    for (let i = 0; item && i < 20; i += 1) {
      const me = bots.find((b) => b.id === item!.botId)!;
      const to = next(me);
      const res = await r.turn(item, () => handleRoomPost({ kind: 'opinion', title: `${me.name} to ${to.name}`, mentions: [to.id] }, asBot(me), r.deps)) as
        { ok: boolean; mentions?: Array<{ ok: boolean; code?: string }> };
      outcomes.push({ by: me.id, posted: res.ok, ...(res.mentions ? { mention: res.mentions[0] } : {}) });
      if (!res.ok || !res.mentions?.[0]?.ok) break;
      item = r.wakes.filter((w) => w.reason.kind === 'mention').at(-1);
    }
    return { msg, outcomes };
  }

  it('A and B answering each other stop at two posts each', async () => {
    const a = bot('lead');
    const b = bot('triage');
    const r = await rig([a, b], [a, b]);
    const { outcomes } = await loop(r, [a, b], (x) => (x === a ? b : a));
    expect(outcomes.map((o) => [o.by, o.posted])).toEqual([[a.id, true], [b.id, true], [a.id, true], [b.id, true], [a.id, false]]);
    expect(r.groupCards().filter((c) => c.actor.kind === 'bot')).toHaveLength(2 * GROUP_ROUND_LIMITS.LINES_PER_BOT);
  });

  it('a chain through three bots stops at the mention wave cap', async () => {
    const a = bot('lead');
    const b = bot('triage');
    const c = bot('verifier');
    const r = await rig([a, b, c], [a, b, c]);
    const order = [a, b, c];
    const { outcomes } = await loop(r, order, (x) => order[(order.indexOf(x) + 1) % 3]);
    // Waves 1..4 wake the next bot; the fifth mention is refused, so it ends.
    expect(outcomes.map((o) => o.mention?.ok)).toEqual([true, true, true, true, false]);
    expect(outcomes.at(-1)).toMatchObject({ posted: true, mention: { ok: false, code: 'max_depth' } });
    expect(r.wakes.filter((w) => w.reason.kind === 'mention')).toHaveLength(GROUP_ROUND_LIMITS.MENTION_WAVES);
  });

  it('a round holds LINES bot cards; the owner\'s next message opens a new one', async () => {
    const members = Array.from({ length: 5 }, () => bot('triage'));
    const r = await rig(members, members);
    await r.owner('Everyone: one idea each, then one more');
    const results: boolean[] = [];
    for (const round of [0, 1]) {
      for (const m of members) {
        const w = r.wakes.find((x) => x.botId === m.id)!;
        const res = await r.turn(w, () => handleRoomPost({ kind: 'opinion', title: `idea ${round}`, clientPostId: `p-${m.id}-${round}` }, asBot(m), r.deps)) as { ok: boolean; code?: string };
        results.push(res.ok);
      }
    }
    expect(results.filter(Boolean)).toHaveLength(GROUP_ROUND_LIMITS.LINES);
    expect(results.slice(GROUP_ROUND_LIMITS.LINES)).toEqual([false, false]);
    // A repeat of a posted card is no new line.
    const w0 = r.wakes.find((x) => x.botId === members[0].id)!;
    expect(await r.turn(w0, () => handleRoomPost({ kind: 'opinion', title: 'idea 0', clientPostId: `p-${members[0].id}-0` }, asBot(members[0]), r.deps))).toMatchObject({ ok: true, duplicate: true });
    await r.owner('Next round');
    const w = r.wakes.filter((x) => x.botId === members[4].id).at(-1)!;
    expect(await r.turn(w, () => handleRoomPost({ kind: 'opinion', title: 'fresh' }, asBot(members[4]), r.deps))).toMatchObject({ ok: true });
  });

  it('a coordinator, a turn that is not a conversation, and a thread outside the group are not capped', async () => {
    const lead = bot('lead', { template: 'coordinator' });
    const a = bot('triage');
    const r = await rig([lead, a], [lead, a]);
    await r.owner('Ship it');
    const w = r.wakes.find((x) => x.botId === lead.id)!;
    for (let i = 0; i < GROUP_ROUND_LIMITS.LINES + 2; i += 1) {
      expect(await r.turn(w, () => handleRoomPost({ kind: 'status', title: `step ${i}`, clientPostId: `lead-${i}` }, asBot(lead), r.deps))).toMatchObject({ ok: true });
    }
    // A delegate reporting on a handoff wake posts as before.
    const handoffWake = { id: 'w-h', botId: a.id, workspaceId: 'ws1', reason: { kind: 'handoff', handoffId: 'h-x' } as WakeReason, priority: 1 } as WakeItem;
    for (let i = 0; i < GROUP_ROUND_LIMITS.LINES_PER_BOT + 1; i += 1) {
      expect(await r.turn(handoffWake, () => handleRoomPost({ kind: 'status', title: `done ${i}`, threadId: GROUP, clientPostId: `a-${i}` }, asBot(a), r.deps))).toMatchObject({ ok: true });
    }
  });
});
