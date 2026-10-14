// ─── A thread's cards (or the whole room's), in seq order ───────────────────
//
// The first read is the newest page; when the window comes back, a catch-up
// read continues from the timeline's cursor page by page while main says
// more follow, and pushes land in between. The list keeps to the bottom
// while the reader is there. Showing a thread is not reading it: the read
// position moves only while the dock is on screen, the window has focus and
// the thread's newest card has been rendered, a moment after it settles.
//
// The timeline is its own region: one hairline above it, a header naming
// the shown thread, then the cards in their own scroll. Opening a thread
// that holds a question waiting on the owner places that whole card in view
// (and keeps it there while it grows) until the reader scrolls or clicks.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { RoomCard as RoomCardData } from '../../../shared/room';
import { dockShownOn } from '../Layout/pagesBesideDock';
import { FOCUS_RING } from '../focusRing';
import { ALL_THREADS, timelineKey, type TimelineThread } from '../../stores/slices/roomSlice';
import { catchUpRoomTimeline, loadRoomTimeline, markRoomThreadRead } from '../../hooks/useRoomSync';
import type { FactoryBotRow } from './factoryPorts';
import { RoomCard } from './RoomCard';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** How long the newest card must stay on screen before it counts as read. */
export const READ_SETTLE_MS = 800;

const EMPTY: RoomCardData[] = [];

function isOpenQuestion(c: RoomCardData): boolean {
  return c.kind === 'question' && c.state === 'open';
}

/** The scrollTop that shows the whole card (its bottom on the view's bottom
 *  when it fits, else its top on the view's top). Pure. */
export function questionScrollTop(card: { top: number; height: number }, viewHeight: number, pad = 8): number {
  return Math.max(0, Math.min(card.top - pad, card.top + card.height - viewHeight + pad));
}

export function RoomTimeline({ workspaceId, thread, title, threadRef, t, bots }: {
  workspaceId: string;
  thread: TimelineThread;
  /** The header: the shown thread's name, and its reference (mono). */
  title: string;
  threadRef?: string | null;
  t: T;
  bots: readonly FactoryBotRow[];
}): React.ReactElement {
  const key = timelineKey(workspaceId, thread);
  const timeline = useStore((s) => s.roomTimelines[key]);
  const cards = timeline?.cards ?? EMPTY;
  const onScreen = useStore((s) => dockShownOn(s.appRoute));
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // The read rule's inputs, as state so a change re-arms it: at the bottom,
  // and a tick on focus / visibility changes.
  const [bottom, setBottom] = useState(true);
  const [attention, setAttention] = useState(0);
  useEffect(() => {
    const bump = () => setAttention((n) => n + 1);
    window.addEventListener('focus', bump);
    document.addEventListener('visibilitychange', bump);
    return () => {
      window.removeEventListener('focus', bump);
      document.removeEventListener('visibilitychange', bump);
    };
  }, []);

  // First read, or a catch-up when this timeline was read before.
  useEffect(() => {
    void (useStore.getState().roomTimelines[key] ? catchUpRoomTimeline(workspaceId, thread) : loadRoomTimeline(workspaceId, thread));
    const onFocus = () => void catchUpRoomTimeline(workspaceId, thread);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [key, workspaceId, thread]);

  // Where the view sits: on the newest question waiting on the owner while
  // that pin holds, else at the bottom while the reader is there — also when
  // a card grows after it rendered (a question's options arrive).
  const lastSeq = cards[cards.length - 1]?.seq ?? 0;
  const contentRef = useRef<HTMLDivElement>(null);
  const pinQuestion = useRef(true);
  const place = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinQuestion.current) {
      const waiting = el.querySelectorAll<HTMLElement>('[data-waits-on-owner="true"]');
      const q = waiting[waiting.length - 1];
      if (q) {
        el.scrollTop = questionScrollTop({ top: q.offsetTop, height: q.offsetHeight }, el.clientHeight);
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        return;
      }
    }
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  };
  useEffect(() => {
    pinQuestion.current = true;
    atBottom.current = true;
  }, [key]);
  useEffect(() => {
    place();
  }, [lastSeq, key]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => place());
    ro.observe(content);
    return () => ro.disconnect();
  }, []);
  const release = () => { pinQuestion.current = false; };

  // Read position: the newest card of a thread, once it settled on screen.
  useEffect(() => {
    if (thread === ALL_THREADS || lastSeq < 1 || !onScreen) return;
    const timer = setTimeout(() => {
      if (typeof document !== 'undefined' && (!document.hasFocus() || document.visibilityState !== 'visible')) return;
      if (!atBottom.current) return;
      void markRoomThreadRead(workspaceId, thread, lastSeq);
    }, READ_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [thread, lastSeq, onScreen, workspaceId, bottom, attention]);

  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  return (
    <section
      data-testid="room-timeline-region"
      aria-label={title}
      className="flex-1 min-h-[40%] flex flex-col border-t border-[var(--stroke)]"
    >
    <div data-testid="room-timeline-header" className="shrink-0 h-[32px] flex items-center gap-1.5 px-3 min-w-0">
      <span className="truncate text-[12px] font-medium text-[var(--text-main)]">{title}</span>
      {threadRef && <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">{threadRef}</span>}
    </div>
    <div
      ref={scrollRef}
      data-testid="room-timeline"
      data-thread={thread}
      role="log"
      aria-label={t('room.timeline')}
      onWheel={release}
      onPointerDown={release}
      onKeyDown={release}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        if (atBottom.current !== bottom) setBottom(atBottom.current);
      }}
      // A card scrolled half past the header fades out instead of ending
      // in a cut line (a mask, not a colour).
      style={{ maskImage: 'linear-gradient(to bottom, transparent 0, #000 12px)', WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 12px)' }}
      className="relative flex-1 min-h-0 overflow-y-auto px-1 pb-1 pt-1"
    >
      {timeline && !timeline.loading && cards.length === 0 && (
        <p data-room-empty className="px-3 py-4 text-[12px] text-[var(--text-muted)]">{t('room.empty')}</p>
      )}
      <div ref={contentRef}>
        {cards.map((card, i) => (
          <RoomCard
            key={card.id}
            card={card}
            workspaceId={workspaceId}
            t={t}
            bots={bots}
            replyToCard={card.replyTo ? byId.get(card.replyTo) ?? null : undefined}
            divider={i < cards.length - 1 && !isOpenQuestion(card) && !isOpenQuestion(cards[i + 1])}
          />
        ))}
      </div>
      {timeline?.hasMore && (
        <button
          type="button"
          data-testid="room-load-more"
          onClick={() => void catchUpRoomTimeline(workspaceId, thread)}
          className={`mx-3 my-2 text-[12px] text-[var(--text-sub)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
        >
          {t('room.loadMore')}
        </button>
      )}
    </div>
    </section>
  );
}
