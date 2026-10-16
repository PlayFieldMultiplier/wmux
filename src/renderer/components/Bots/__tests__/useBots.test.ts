// A thread with an open question is read from its first card, page by page,
// so a question older than the newest page still counts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { timelineKey } from '../../../stores/slices/roomSlice';
import { setRoomsApiForTests, type RoomsApi } from '../../../hooks/useRoomSync';
import type { RoomCard } from '../../../../shared/room';
import { loadWholeThread, threadsToRead } from '../useBots';
import type { ThreadSummary } from '../../../../shared/room';

const THREAD = 'task:t1' as const;
const card = (seq: number, over: Partial<RoomCard> = {}): RoomCard => ({
  version: 1, id: `c${seq}`, seq, workspaceId: 'w1', threadId: THREAD, kind: 'status', at: seq,
  actor: { kind: 'bot', workspaceId: 'w1', botId: 'bot-0000000a' }, title: `c${seq}`, ...over,
});

afterEach(() => setRoomsApiForTests(undefined));

describe('loadWholeThread', () => {
  it('reads from seq 0 through every page, the first question included', async () => {
    const pages: Record<number, { cards: RoomCard[]; next: number; more: boolean }> = {
      0: { cards: [card(1, { kind: 'question', state: 'open' }), card(2)], next: 2, more: true },
      2: { cards: [card(3)], next: 3, more: false },
    };
    const read = vi.fn(async (p: { sinceSeq?: number }) => {
      const pg = pages[p.sinceSeq ?? -1];
      return { ok: true as const, workspaceId: 'w1', threadId: THREAD, cards: pg.cards, nextSinceSeq: pg.next, hasMore: pg.more };
    });
    setRoomsApiForTests({ read } as unknown as RoomsApi);
    useStore.setState({ roomTimelines: {} } as never);
    await loadWholeThread('w1', THREAD);
    expect(read.mock.calls.map((c) => (c[0] as { sinceSeq?: number }).sinceSeq)).toEqual([0, 2]);
    const tl = useStore.getState().roomTimelines[timelineKey('w1', THREAD)];
    expect(tl.cards.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(tl.loading).toBeUndefined();
    expect(tl.nextSinceSeq).toBe(3);
  });
});

describe('loadWholeThread refresh', () => {
  it('a refresh asked for while a read is in flight reads once more after it', async () => {
    useStore.setState({ roomTimelines: {}, roomPushCount: 0, roomPushedAt: {} } as never);
    useStore.getState().setRoomPage('w1', THREAD, { cards: [card(1, { kind: 'plan', state: 'open' })], nextSinceSeq: 1, hasMore: false }, 'replace');
    let state: RoomCard['state'] = 'open';
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn(async () => {
      const snapshot = card(1, { kind: 'plan', state });
      if (read.mock.calls.length === 1) await gate;
      return { ok: true as const, workspaceId: 'w1', threadId: THREAD, cards: [snapshot], nextSinceSeq: 1, hasMore: false };
    });
    setRoomsApiForTests({ read } as unknown as RoomsApi);
    const first = loadWholeThread('w1', THREAD);
    state = 'resolved';
    await loadWholeThread('w1', THREAD);
    release();
    await first;
    expect(read).toHaveBeenCalledTimes(2);
    expect(useStore.getState().roomTimelines[timelineKey('w1', THREAD)].cards[0].state).toBe('resolved');
  });
});

describe('threadsToRead', () => {
  const th = (threadId: ThreadSummary['threadId'], over: Partial<ThreadSummary> = {}): ThreadSummary => ({
    threadId, title: 't', lastAt: 1, lastSeq: 1, cardCount: 1, openQuestions: 0, lastKind: 'status', status: 'open', unread: null, ...over,
  });
  it('reads open-question threads, the newest plan and open proposal threads, each once', () => {
    const threads = {
      hq: [th('plan:p-old', { lastSeq: 3 }), th('plan:p-new', { lastSeq: 9 }), th('general')],
      w1: [
        th('task:t1', { openQuestions: 1 }),
        th('issue:github.com/a/b#4', { lastKind: 'proposal' }),
        th('issue:github.com/a/b#5', { lastKind: 'proposal', status: 'closed' }),
        th('task:t2'),
      ],
    };
    expect(threadsToRead(['hq', 'w1'], threads, {})).toEqual([
      timelineKey('hq', 'plan:p-new'), timelineKey('w1', 'task:t1'), timelineKey('w1', 'issue:github.com/a/b#4'),
    ]);
    // Already read: not again.
    expect(threadsToRead(['hq'], threads, { [timelineKey('hq', 'plan:p-new')]: {} })).toEqual([]);
  });
});
