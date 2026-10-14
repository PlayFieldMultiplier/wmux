// The Bots page's conversations, derived from the room, bot and fan-out
// stores: who belongs in a 1:1, live vs finished workers, the order (HQ
// first, then activity) and the needs-you count the rail badge shows.
import { describe, expect, it } from 'vitest';
import type { RoomCard, ThreadId } from '../../../../shared/room';
import type { BotProfile, BotRole } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import type { FactoryBotRow } from '../../Room/factoryPorts';
import { timelineKey, ALL_THREADS } from '../../../stores/slices/roomSlice';
import {
  awaitsApproval, botConversationCards, botWorkScope, botWorkerTree, botWorkers, buildBots, botsNeedsYou, botsRooms, conversationCards, greetingCardIds, isBotSystemCard,
  livePlanIds, openApprovalsBy, openQuestionsBy, roomCardsByWorkspace, roomEntries, taskBubbles,
  type BotsInput,
} from '../botsModel';

const LEAD = 'bot-0000000a';
const VERIFIER = 'bot-0000000b';
const MOA = 'bot-0000000c';

function botRow(id: string, role: BotRole, workspaceId: string, createdAt: number, name = role): FactoryBotRow {
  const bot: BotProfile = {
    version: 1, id, workspaceId, role, name, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS[role], enabled: true, createdAt, updatedAt: createdAt,
  };
  return { bot, status: null };
}

let seq = 0;
function card(partial: Partial<RoomCard> & Pick<RoomCard, 'workspaceId' | 'actor'>): RoomCard {
  seq += 1;
  return { version: 1, id: `c${seq}`, seq, threadId: 'general', kind: 'status', at: 1000 + seq, title: `card ${seq}`, ...partial };
}
const bot = (workspaceId: string, botId: string) => ({ kind: 'bot' as const, workspaceId, botId });

const BOTS = [botRow(MOA, 'moa', 'hq', 1), botRow(LEAD, 'lead', 'w1', 2), botRow(VERIFIER, 'verifier', 'w1', 3)];

function input(over: Partial<BotsInput> = {}): BotsInput {
  return {
    bots: BOTS,
    cards: new Map(),
    threads: {},
    botTaskOf: {},
    workerClass: {},
    workspaceName: (id) => ({ hq: 'HQ', w1: 'api', t1: 'wtask: fix', t2: 'wtask: docs', t3: 'wtask: old' } as Record<string, string>)[id] ?? null,
    ...over,
  };
}

describe('conversationCards', () => {
  it('holds the bot\'s own cards, the owner\'s messages addressed to it and the system cards naming it', () => {
    const mine = card({ workspaceId: 'w1', actor: bot('w1', LEAD), title: 'lead says' });
    const toMe = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', refs: { botId: LEAD } });
    const toOther = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', refs: { botId: VERIFIER } });
    const unaddressed = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human' });
    const other = card({ workspaceId: 'w1', actor: bot('w1', VERIFIER) });
    const fact = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', refs: { botId: LEAD } });
    const otherFact = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'refusal', refs: { botId: VERIFIER } });
    const generalFact = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact' });
    expect(conversationCards([mine, toMe, toOther, unaddressed, other, fact, otherFact, generalFact], LEAD).map((c) => c.id))
      .toEqual([mine.id, toMe.id, fact.id]);
  });

  it('a system card about the bot\'s own work joins its 1:1: its PR\'s or task\'s thread, or its task by id', () => {
    const pr: ThreadId = 'pr:github.com/acme/api#1';
    const asked = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: pr });
    const dispatch = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'dispatch', refs: { taskId: 'task-9' } });
    const refused = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'refusal', threadId: pr, title: 'Merge refused for #1', body: 'No required checks' });
    const gate = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: 'task:task-9', refs: { taskId: 'task-9' }, title: 'Task done: x', body: 'gate exit 0' });
    // The same PR's thread in a room the bot never wrote in, another task,
    // and General with no bot named: not its work.
    const elsewhere = card({ workspaceId: 'w2', actor: { kind: 'system' }, kind: 'refusal', threadId: pr });
    const otherTask = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: 'task:task-3', refs: { taskId: 'task-3' } });
    const general = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', title: 'CI green' });
    const all = [asked, dispatch, refused, gate, elsewhere, otherTask, general];
    expect(conversationCards(all, LEAD).map((c) => c.id)).toEqual([asked.id, dispatch.id, refused.id, gate.id]);
    // The verifier wrote nowhere: none of them is its.
    expect(conversationCards(all, VERIFIER)).toEqual([]);
    const scope = botWorkScope(all, LEAD);
    expect(isBotSystemCard(refused, LEAD, scope)).toBe(true);
    expect(isBotSystemCard(asked, LEAD, scope)).toBe(false);
  });

  it('an open copy does not count once its thread summary says nothing is open there', () => {
    const q = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: 'task:t1' });
    const summary = (open: number) => ({ w1: [{ threadId: 'task:t1' as const, title: 't', lastAt: 1, lastSeq: q.seq, cardCount: 1, openQuestions: open, lastKind: 'question' as const, status: 'open' as const, unread: null }] });
    expect(openQuestionsBy([q], LEAD, summary(1))).toBe(1);
    expect(openQuestionsBy([q], LEAD, summary(0))).toBe(0);
    // No summary read yet: the card's own state answers.
    expect(openQuestionsBy([q], LEAD, {})).toBe(1);
  });

  it('counts only the bot\'s own open questions', () => {
    const cards = [
      card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open' }),
      card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'resolved' }),
      card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), kind: 'question', state: 'open' }),
      card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'proposal', state: 'open' }),
    ];
    expect(openQuestionsBy(cards, LEAD)).toBe(1);
    expect(openQuestionsBy(cards, VERIFIER)).toBe(1);
  });
});

describe('botWorkers', () => {
  it('lists running and waiting workers of that bot; finished, idle, closed and other bots\' leave', () => {
    const owners = { t1: LEAD, t2: LEAD, t3: LEAD, t4: LEAD, t5: VERIFIER };
    const classes = { t1: 'running', t2: 'needsYou', t3: 'finished', t5: 'running', t6: 'running' } as const;
    const ws = botWorkers(LEAD, owners, classes, (id) => ({ t1: 'b-fix', t2: 'a-docs' } as Record<string, string>)[id] ?? null);
    expect(ws.map((w) => [w.workspaceId, w.cls, w.waiting])).toEqual([['t2', 'needsYou', true], ['t1', 'running', false]]);
    // An error waits on the owner too (Fleet counts it under Needs you).
    expect(botWorkers(LEAD, { t1: LEAD }, { t1: 'error' }, () => null)[0].waiting).toBe(true);
  });
});

describe('botWorkers from the bot\'s tasks', () => {
  const view = (taskId: string, taskWorkspaceId: string, stage: 'working' | 'needs_input' | 'coded' | 'closed', over: Record<string, unknown> = {}) => ({
    taskId, taskWorkspaceId, ownerWorkspaceId: 'w1', botId: LEAD, title: `task ${taskId}`, status: 'working' as const, stage, updatedAt: 1, ...over,
  });
  const names = (id: string) => (['t1', 't2', 't3', 't4', 't5'].includes(id) ? `wtask: ${id}` : null);

  it('a task at work or waiting on input is a live worker while its pane is open, whatever its pane\'s attention class', () => {
    const tasks = [
      view('a', 't1', 'needs_input'),
      view('b', 't2', 'working'),
      view('c', 't3', 'coded'),
      view('d', 'gone', 'working'),
      view('e', 't4', 'working', { workerWorkspaceId: 't5' }),
      view('f', 't4', 'working', { botId: VERIFIER }),
    ];
    // t1's stopped agent reads idle: the ledger still says it waits on input.
    const ws = botWorkers(LEAD, {}, { t1: 'idle', t2: 'running' }, names, tasks);
    expect(ws.map((w) => [w.workspaceId, w.name, w.waiting, !!w.needsInput, w.taskId])).toEqual([
      ['t1', 'task a', true, true, 'a'],
      ['t2', 'task b', false, false, 'b'],
      ['t5', 'task e', false, false, 'e'],
    ]);
  });

  it('the list\'s tree: live workers, then ended tasks whose workspace is open (newest first); a cleared one drops off', () => {
    const tasks = [
      view('a', 't1', 'working'),
      view('b', 't2', 'coded', { updatedAt: 5, worker: 'resumable' }),
      view('c', 't3', 'closed', { updatedAt: 9, stage: 'failed' }),
      view('d', 'gone', 'closed', { updatedAt: 10 }),
      view('e', 't4', 'closed', { botId: VERIFIER }),
    ];
    const live = botWorkers(LEAD, { t5: LEAD }, { t1: 'running', t5: 'error' }, names, tasks);
    const tree = botWorkerTree(LEAD, live, tasks, names);
    expect(tree.map((r) => [r.workspaceId, r.title, r.state, r.resumable])).toEqual([
      ['t1', 'task a', 'running', false],
      ['t5', 'wtask: t5', 'error', false],
      ['t3', 'task c', 'failed', false],
      ['t2', 'task b', 'done', true],
    ]);
  });

  it('a task workspace already listed from its task is not listed again from its origin', () => {
    const ws = botWorkers(LEAD, { t1: LEAD, t2: LEAD }, { t1: 'running', t2: 'needsYou' }, names, [view('a', 't1', 'working')]);
    expect(ws.map((w) => [w.workspaceId, w.taskId ?? null])).toEqual([['t1', 'a'], ['t2', null]]);
  });

  it('a waiting task counts on its bot\'s row, and its room lists the room\'s bots\' workers', () => {
    const lead = { ...BOTS[1], tasks: [view('a', 't1', 'needs_input')] };
    const m = buildBots(input({ bots: [BOTS[0], lead, BOTS[2]] }));
    const row = m.conversations.find((c) => c.id === `bot:${LEAD}`);
    expect(row?.needsYou).toBe(1);
    const room = m.conversations.find((c) => c.id === 'room:w1');
    expect(room?.kind === 'room' && room.workers.map((w) => w.workspaceId)).toEqual(['t1']);
    expect(room?.needsYou).toBe(0);
    expect(m.conversations.find((c) => c.id === 'room:hq')?.kind === 'room' && (m.conversations.find((c) => c.id === 'room:hq') as { workers: unknown[] }).workers).toEqual([]);
    expect(m.needsYou).toBe(1);
  });
});

describe('needs you: a waiting worker its bot already asked about counts once', () => {
  it('drops a needs-input worker whose task an open question names', () => {
    const view = (taskId: string, ws: string) => ({ taskId, taskWorkspaceId: ws, ownerWorkspaceId: 'w1', botId: LEAD, title: taskId, status: 'input_required' as const, stage: 'needs_input' as const, updatedAt: 1 });
    const lead = { ...BOTS[1], tasks: [view('wtask-a', 't1'), view('wtask-b', 't2')] };
    const asks = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: 'task:wtask-a' as ThreadId, refs: { taskId: 'wtask-a' } });
    const m = buildBots(input({ bots: [BOTS[0], lead, BOTS[2]], cards: new Map([['w1', [asks]]]) }));
    // One question (about wtask-a) + one worker not asked about (wtask-b).
    expect(m.conversations.find((c) => c.id === `bot:${LEAD}`)?.needsYou).toBe(2);
    // Once the question is answered, both workers count.
    const answered = { ...asks, state: 'resolved' as const };
    expect(buildBots(input({ bots: [BOTS[0], lead, BOTS[2]], cards: new Map([['w1', [answered]]]) })).conversations.find((c) => c.id === `bot:${LEAD}`)?.needsYou).toBe(2);
  });
});

describe('greetingCardIds and roomEntries', () => {
  const NEW = 'bot-0000000d';
  const newBot = botRow(NEW, 'lead', 'w1', 10_000);

  it('a greeting is the question main marked `greeting`, of a bot of this room', () => {
    const greet = card({ workspaceId: 'w1', actor: bot('w1', NEW), kind: 'question', threadId: 'handoff:h-1' as ThreadId, at: 10_500, greeting: true });
    // An unmarked early question (even the bot's first card) is work, not a greeting.
    const early = card({ workspaceId: 'w1', actor: bot('w1', NEW), kind: 'question', threadId: 'handoff:h-2' as ThreadId, at: 10_100 });
    const pr = card({ workspaceId: 'w1', actor: bot('w1', NEW), kind: 'question', threadId: 'pr:github.com/acme/app#1' as ThreadId, at: 10_200 });
    expect([...greetingCardIds([early, pr, greet], [newBot])]).toEqual([greet.id]);
    // Another room's bot, or a mark on a card that is not a bot's question, does not count.
    expect(greetingCardIds([greet], [BOTS[1]]).size).toBe(0);
    expect(greetingCardIds([card({ workspaceId: 'w1', actor: bot('w1', NEW), greeting: true })], [newBot]).size).toBe(0);
    expect(greetingCardIds([card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'question', greeting: true })], [newBot]).size).toBe(0);
  });

  it('places each bot\'s joined notice at the time it was added, and none before the oldest card read', () => {
    const a = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', at: 5_000 });
    const b = card({ workspaceId: 'w1', actor: bot('w1', NEW), at: 12_000 });
    const old = botRow(LEAD, 'lead', 'w1', 1_000);
    const entries = roomEntries([a, b], [newBot, old]);
    expect(entries.map((e) => (e.kind === 'card' ? e.card.id : `joined:${e.row.bot.id}`))).toEqual([a.id, `joined:${NEW}`, b.id]);
    expect(roomEntries([], [newBot]).map((e) => e.kind)).toEqual(['joined']);
    // The greeting was the room's first card and is left out: its bot still
    // gets the joined line, before the later note.
    const later = card({ workspaceId: 'w1', actor: bot('w1', NEW), at: 30_000 });
    expect(roomEntries([later], [newBot], new Set([NEW])).map((e) => e.kind)).toEqual(['joined', 'card']);
    expect(roomEntries([later], [newBot]).map((e) => e.kind)).toEqual(['card']);
  });
});

describe('buildBots', () => {
  it('orders rooms and bots by latest activity; the old HQ room is not pinned', () => {
    const cards = new Map<string, RoomCard[]>([
      ['hq', [card({ workspaceId: 'hq', actor: bot('hq', MOA), at: 100 })]],
      ['w1', [
        card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), at: 500 }),
        card({ workspaceId: 'w1', actor: bot('w1', LEAD), at: 900 }),
      ]],
    ]);
    const m = buildBots(input({ cards }));
    expect(m.conversations.map((c) => c.id)).toEqual([
      `bot:${LEAD}`, // 900 — ties break by id
      'room:w1', // 900
      `bot:${VERIFIER}`, // 500
      `bot:${MOA}`, // 100
      'room:hq', // 100
    ]);
    const room = m.conversations.find((c) => c.id === 'room:w1');
    expect(room?.kind === 'room' && room.bots.map((b) => b.bot.id)).toEqual([LEAD, VERIFIER]);
  });

  it('a bot with no message yet sorts by its creation', () => {
    const m = buildBots(input({ bots: [botRow(LEAD, 'lead', 'w1', 5000)] }));
    expect(m.conversations.map((c) => [c.id, c.lastAt])).toEqual([[`bot:${LEAD}`, 5000], ['room:w1', 0]]);
  });

  it('needs you: a bot\'s open questions plus its waiting workers; the badge sums the 1:1 rows only', () => {
    const cards = new Map<string, RoomCard[]>([['w1', [
      card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open' }),
      card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), kind: 'question', state: 'open' }),
      card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), kind: 'question', state: 'resolved' }),
    ]]]);
    const m = buildBots(input({
      cards,
      botTaskOf: { t1: LEAD, t2: LEAD },
      workerClass: { t1: 'needsYou', t2: 'running' },
    }));
    const row = (id: string) => m.conversations.find((c) => c.id === id);
    expect(row(`bot:${LEAD}`)?.needsYou).toBe(2);
    expect(row(`bot:${VERIFIER}`)?.needsYou).toBe(1);
    expect(row('room:w1')?.needsYou).toBe(0);
    expect(m.needsYou).toBe(3);
    expect(botsNeedsYou(m.conversations)).toBe(m.needsYou);
  });

  it('needs you counts the live plan and open proposals too; the badge is still the sum of the rows', () => {
    const cards = new Map<string, RoomCard[]>([
      ['hq', [
        card({ workspaceId: 'hq', actor: bot('hq', MOA), kind: 'plan', state: 'open', threadId: 'plan:p-old', at: 10 }),
        card({ workspaceId: 'hq', actor: bot('hq', MOA), kind: 'plan', state: 'open', threadId: 'plan:p-new', at: 20 }),
      ]],
      ['w1', [
        card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'proposal', state: 'open' }),
        card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'proposal', state: 'resolved' }),
        card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open' }),
        // A system-written proposal never waits on the owner's answer.
        card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'proposal', state: 'open' }),
      ]],
    ]);
    const m = buildBots(input({ cards }));
    const row = (id: string) => m.conversations.find((c) => c.id === id);
    // Moa: only its newest plan waits (the older open one is superseded).
    expect(row(`bot:${MOA}`)?.needsYou).toBe(1);
    expect(row(`bot:${LEAD}`)?.needsYou).toBe(2);
    expect(m.needsYou).toBe(3);
    expect(botsNeedsYou(m.conversations)).toBe(m.needsYou);
    // Answered, the plan no longer counts.
    const answered = new Map(cards);
    answered.set('hq', cards.get('hq')!.map((c) => (c.threadId === 'plan:p-new' ? { ...c, state: 'resolved' as const } : c)));
    expect(buildBots(input({ cards: answered })).conversations.find((c) => c.id === `bot:${MOA}`)?.needsYou).toBe(0);
  });

  it('livePlanIds / awaitsApproval: each bot\'s newest plan when open, and open bot proposals', () => {
    const old = card({ workspaceId: 'hq', actor: bot('hq', MOA), kind: 'plan', state: 'open', at: 10 });
    const fresh = card({ workspaceId: 'hq', actor: bot('hq', MOA), kind: 'plan', state: 'open', at: 20 });
    const live = livePlanIds([fresh, old]);
    expect([...live]).toEqual([fresh.id]);
    expect(awaitsApproval(fresh, live)).toBe(true);
    expect(awaitsApproval(old, live)).toBe(false);
    const prop = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'proposal', state: 'open' });
    expect(awaitsApproval(prop, live)).toBe(true);
    expect(awaitsApproval({ ...prop, state: 'resolved' }, live)).toBe(false);
    expect(openApprovalsBy([old, fresh, prop], MOA)).toBe(1);
    expect(openApprovalsBy([old, fresh, prop], LEAD)).toBe(1);
  });

  it('read-only (bots paused): the rows are kept, nothing is counted', () => {
    const cards = new Map<string, RoomCard[]>([['w1', [card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open' })]]]);
    const m = buildBots(input({ cards, readOnly: true, botTaskOf: { t1: LEAD }, workerClass: { t1: 'needsYou' } }));
    const lead = m.conversations.find((c) => c.id === `bot:${LEAD}`);
    expect(lead?.kind === 'bot' && lead.workers.length).toBe(1);
    expect(lead?.needsYou).toBe(0);
    expect(m.needsYou).toBe(0);
  });

  it('a 1:1 spans rooms: a message to Moa posted in a workspace room is in Moa\'s conversation', () => {
    const hello = card({ workspaceId: 'hq', actor: bot('hq', MOA), at: 10 });
    const fromW1 = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', refs: { botId: MOA }, at: 20, title: 'to moa from api' });
    const m = buildBots(input({ cards: new Map([['hq', [hello]], ['w1', [fromW1]]]) }));
    const moa = m.conversations.find((c) => c.id === `bot:${MOA}`);
    expect(moa?.last?.id).toBe(fromW1.id);
    expect(botConversationCards(new Map([['hq', [hello]], ['w1', [fromW1]]]), MOA).map((c) => c.id)).toEqual([hello.id, fromW1.id]);
  });

  it('botsRooms: each bot workspace once; with no bot there is no room (no pre-made HQ)', () => {
    expect(botsRooms(BOTS)).toEqual(['hq', 'w1']);
    expect(botsRooms([])).toEqual([]);
    expect(buildBots(input({ bots: [] })).conversations).toEqual([]);
  });
});

describe('roomCardsByWorkspace', () => {
  it('merges the whole-room and thread timelines by id in seq order; an answer is never undone by an older copy', () => {
    const thread: ThreadId = 'task:t1';
    const q = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: thread });
    const answered = { ...q, state: 'resolved' as const };
    const later = card({ workspaceId: 'w1', actor: bot('w1', LEAD) });
    const timelines = {
      [timelineKey('w1', ALL_THREADS)]: { cards: [answered, later], nextSinceSeq: later.seq, hasMore: false },
      [timelineKey('w1', thread)]: { cards: [q], nextSinceSeq: q.seq, hasMore: false },
      [timelineKey('hq', ALL_THREADS)]: { cards: [], nextSinceSeq: 0, hasMore: false },
    };
    const byWs = roomCardsByWorkspace(timelines);
    expect(byWs.get('w1')?.map((c) => [c.id, c.state])).toEqual([[q.id, 'resolved'], [later.id, undefined]]);
    expect(byWs.get('hq')).toEqual([]);
  });
});

describe('taskBubbles', () => {
  const view = (taskId: string, over: Partial<import('../../../../shared/botTask').BotTaskView>) => ({
    taskId, taskWorkspaceId: `${taskId}-ws`, ownerWorkspaceId: 'ws-1', botId: LEAD, title: taskId, status: 'completed' as const, stage: 'checked' as const, updatedAt: 1_000, ...over,
  });
  it('lists every worker waiting for a slot, then the three newest resumable workers of the last day', () => {
    const now = 100_000_000;
    const tasks = [
      view('old', { worker: 'resumable', updatedAt: now - 25 * 3_600_000 }),
      view('r1', { worker: 'resumable', updatedAt: now - 4 }),
      view('r2', { worker: 'resumable', updatedAt: now - 3 }),
      view('r3', { worker: 'resumable', updatedAt: now - 2 }),
      view('r4', { worker: 'resumable', updatedAt: now - 1 }),
      view('stopped', { worker: 'stopped', updatedAt: now }),
      view('live', { status: 'working', stage: 'working', updatedAt: now }),
      view('wait', { status: 'working', stage: 'waiting_slot', taskWorkspaceId: '', updatedAt: now }),
    ];
    expect(taskBubbles(tasks, now).map((t) => t.taskId)).toEqual(['wait', 'r4', 'r3', 'r2']);
    expect(taskBubbles(undefined, now)).toEqual([]);
  });
});
