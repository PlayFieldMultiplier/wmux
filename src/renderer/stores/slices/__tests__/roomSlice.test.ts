import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';
import type { RoomCard, ThreadSummary } from '../../../../shared/room';
import { ALL_THREADS, mergeCards, orderThreads, timelineKey, upsertThread } from '../roomSlice';

const WS = 'ws-a';

function card(seq: number, over: Partial<RoomCard> = {}): RoomCard {
  return { version: 1, id: `c${seq}`, seq, workspaceId: WS, threadId: 'general', kind: 'status', at: seq * 1000, actor: { kind: 'system' }, title: `card ${seq}`, ...over };
}

function summary(threadId: ThreadSummary['threadId'], over: Partial<ThreadSummary> = {}): ThreadSummary {
  return { threadId, title: threadId, lastAt: 0, lastSeq: 0, cardCount: 1, openQuestions: 0, lastKind: 'status', status: 'open', unread: null, ...over };
}

beforeEach(() => {
  useStore.setState({ roomStatus: null, roomThreads: {}, roomTimelines: {}, roomSelectedThread: {}, roomReadThrough: {} });
});

describe('orderThreads', () => {
  it('puts threads with an open question first, then open / quiet / closed, each by last seq', () => {
    const out = orderThreads([
      summary('general', { lastSeq: 50 }),
      summary('task:a', { lastSeq: 90, status: 'closed' }),
      summary('pr:github.com/o/r#1', { lastSeq: 10, openQuestions: 1 }),
      summary('issue:github.com/o/r#2', { lastSeq: 70 }),
      summary('task:b', { lastSeq: 80, status: 'quiet' }),
      summary('handoff:h1', { lastSeq: 5, openQuestions: 2 }),
    ]);
    expect(out.map((t) => t.threadId)).toEqual([
      'pr:github.com/o/r#1', 'handoff:h1', 'issue:github.com/o/r#2', 'general', 'task:b', 'task:a',
    ]);
  });
});

describe('mergeCards', () => {
  it('keeps one card per id, the incoming copy winning, in seq order', () => {
    const merged = mergeCards([card(3), card(1)], [card(2), card(3, { state: 'resolved' })]);
    expect(merged.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(merged[2].state).toBe('resolved');
  });
});

describe('upsertThread', () => {
  it('replaces a thread by id or adds it', () => {
    const list = [summary('general', { lastSeq: 1 })];
    expect(upsertThread(list, summary('general', { lastSeq: 2 }))).toEqual([summary('general', { lastSeq: 2 })]);
    expect(upsertThread(list, summary('task:x')).map((t) => t.threadId)).toEqual(['general', 'task:x']);
  });
});

describe('room slice', () => {
  it('applies a pushed card only to timelines already loaded, and updates the thread list', () => {
    const st = useStore.getState();
    st.setRoomThreads(WS, [summary('general')]);
    st.setRoomPage(WS, ALL_THREADS, { cards: [card(1)], nextSinceSeq: 1, hasMore: false }, 'replace');
    st.applyRoomEvent({ workspaceId: WS, card: card(2, { threadId: 'task:t' }), threadSummary: summary('task:t', { lastSeq: 2 }) });
    const s = useStore.getState();
    expect(s.roomTimelines[timelineKey(WS, ALL_THREADS)].cards.map((c) => c.seq)).toEqual([1, 2]);
    expect(s.roomTimelines[timelineKey(WS, 'task:t')]).toBeUndefined();
    expect(s.roomThreads[WS].map((t) => t.threadId)).toEqual(['general', 'task:t']);
    // The cursor stays where the last read left it.
    expect(s.roomTimelines[timelineKey(WS, ALL_THREADS)].nextSinceSeq).toBe(1);
  });

  it('a changed card replaces the old one in place', () => {
    const st = useStore.getState();
    st.setRoomPage(WS, ALL_THREADS, { cards: [card(1, { kind: 'question', state: 'open' })], nextSinceSeq: 1, hasMore: false }, 'replace');
    st.applyRoomEvent({ workspaceId: WS, card: card(1, { kind: 'question', state: 'resolved' }), threadSummary: summary('general') });
    const cards = useStore.getState().roomTimelines[timelineKey(WS, ALL_THREADS)].cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].state).toBe('resolved');
  });

  it('an appended page merges and never moves the cursor back', () => {
    const st = useStore.getState();
    st.setRoomPage(WS, 'general', { cards: [card(1), card(2)], nextSinceSeq: 5, hasMore: true }, 'replace');
    st.setRoomPage(WS, 'general', { cards: [card(2), card(3)], nextSinceSeq: 3, hasMore: false }, 'append');
    const tl = useStore.getState().roomTimelines[timelineKey(WS, 'general')];
    expect(tl.cards.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(tl.nextSinceSeq).toBe(5);
    expect(tl.hasMore).toBe(false);
  });

  it('a read position only moves forward', () => {
    const st = useStore.getState();
    expect(st.noteRoomRead(WS, 'general', 4)).toBe(true);
    expect(useStore.getState().noteRoomRead(WS, 'general', 4)).toBe(false);
    expect(useStore.getState().noteRoomRead(WS, 'general', 2)).toBe(false);
    expect(useStore.getState().noteRoomRead(WS, 'general', 6)).toBe(true);
  });
});
