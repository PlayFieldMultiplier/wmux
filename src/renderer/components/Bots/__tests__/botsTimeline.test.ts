import { describe, expect, it } from 'vitest';
import type { RoomCard } from '../../../../shared/room';
import type { RoomEntry } from '../botsModel';
import { RUN_WINDOW_MS, buildTimeline, dayLabel, elapsed, splitThreads, threadCards, unreadCount } from '../botsTimeline';

let seq = 0;
function card(p: Partial<RoomCard> = {}): RoomCard {
  seq += 1;
  return { version: 1, id: `c${seq}`, seq, workspaceId: 'w1', threadId: 'general', kind: 'opinion', at: 0, actor: { kind: 'bot', workspaceId: 'w1', botId: 'b1' }, title: `card ${seq}`, ...p };
}
const entries = (cards: RoomCard[]): RoomEntry[] => cards.map((c) => ({ kind: 'card', card: c }));
const T0 = new Date(2026, 9, 14, 9, 0).getTime();
const never = () => false;
const t = (key: string) => key;

describe('buildTimeline', () => {
  it('continues a run for one author within ten minutes, and starts one otherwise', () => {
    const a = card({ at: T0 });
    const b = card({ at: T0 + RUN_WINDOW_MS - 1 });
    const c = card({ at: T0 + 2 * RUN_WINDOW_MS + 1 });
    const d = card({ at: T0 + 2 * RUN_WINDOW_MS + 2, actor: { kind: 'human' }, kind: 'human' });
    const msgs = buildTimeline(entries([a, b, c, d]), { waits: never }).filter((i) => i.kind === 'message');
    expect(msgs.map((i) => i.kind === 'message' && i.continuation)).toEqual([false, true, false, false]);
  });

  it('a card that waits on the owner, or one with a kind word, never continues a run', () => {
    const a = card({ at: T0 });
    const q = card({ at: T0 + 1, kind: 'question', state: 'open' });
    const after = card({ at: T0 + 2 });
    const verdict = card({ at: T0 + 3, kind: 'verdict' });
    const msgs = buildTimeline(entries([a, q, after, verdict]), { waits: (x) => x.id === q.id }).filter((i) => i.kind === 'message');
    expect(msgs.map((i) => i.kind === 'message' && i.continuation)).toEqual([false, false, false, false]);
    expect(msgs[1].kind === 'message' && msgs[1].waiting).toBe(true);
  });

  it('divides days and merges consecutive system cards of one thread, never across threads', () => {
    const s1 = card({ at: T0, actor: { kind: 'system' }, kind: 'fact', threadId: 'task:t1' });
    const s2 = card({ at: T0 + 1, actor: { kind: 'system' }, kind: 'refusal', threadId: 'task:t1' });
    const s3 = card({ at: T0 + 2, actor: { kind: 'system' }, kind: 'fact', threadId: 'task:t2' });
    const next = card({ at: T0 + 24 * 3600_000 });
    const items = buildTimeline(entries([s1, s2, s3, next]), { waits: never });
    expect(items.map((i) => i.kind)).toEqual(['day', 'system', 'system', 'day', 'message']);
    expect(items[1].kind === 'system' && items[1].cards.map((c) => c.id)).toEqual([s1.id, s2.id]);
  });

  it('puts "New" above the first card from someone else after the read time, once', () => {
    const mine = card({ at: T0 + 10, actor: { kind: 'human' }, kind: 'human' });
    const old = card({ at: T0 });
    const fresh = card({ at: T0 + 20 });
    const fresher = card({ at: T0 + 30 });
    const kinds = buildTimeline(entries([old, mine, fresh, fresher]), { waits: never, newAfter: T0 + 5 }).map((i) => i.kind);
    expect(kinds).toEqual(['day', 'message', 'message', 'new', 'message', 'message']);
    expect(buildTimeline(entries([old]), { waits: never, newAfter: null }).some((i) => i.kind === 'new')).toBe(false);
  });
});

describe('splitThreads', () => {
  it('keeps General, each thread\'s root and any waiting card in the main timeline; counts the replies', () => {
    const root = card({ threadId: 'pr:x#1', at: T0 });
    const reply = card({ threadId: 'pr:x#1', at: T0 + 5, actor: { kind: 'system' }, kind: 'fact' });
    const ask = card({ threadId: 'pr:x#1', at: T0 + 9, kind: 'question', state: 'open' });
    const general = card({ at: T0 + 10 });
    const { main, threads } = splitThreads([root, reply, ask, general], (c) => c.id === ask.id);
    expect(main.map((c) => c.id)).toEqual([root.id, ask.id, general.id]);
    expect(threads.get(root.id)).toEqual({ workspaceId: 'w1', threadId: 'pr:x#1', replies: 2, lastAt: T0 + 9 });
    // The panel holds the thread and the cards that link it.
    const link = card({ refs: { threadId: 'pr:x#1' } });
    expect(threadCards([root, reply, general, link], 'w1', 'pr:x#1').map((c) => c.id)).toEqual([root.id, reply.id, link.id]);
  });
});

describe('time and counts', () => {
  it('labels days Today / Yesterday / a date, and elapsed time as m:ss', () => {
    expect(dayLabel(T0, T0 + 1000, t)).toBe('botsPage.chat.today');
    expect(dayLabel(T0 - 24 * 3600_000, T0, t)).toBe('botsPage.chat.yesterday');
    expect(dayLabel(T0 - 5 * 24 * 3600_000, T0, t)).not.toMatch(/^botsPage/);
    expect(elapsed(14_000)).toBe('0:14');
    expect(elapsed(3_725_000)).toBe('1:02:05');
  });

  it('counts bot messages after the read time as unread, never the owner\'s or system lines', () => {
    const cards = [
      card({ at: T0 }),
      card({ at: T0 + 10 }),
      card({ at: T0 + 11, actor: { kind: 'human' }, kind: 'human' }),
      card({ at: T0 + 12, actor: { kind: 'system' }, kind: 'fact' }),
    ];
    expect(unreadCount(cards, T0 + 5)).toBe(1);
  });
});
