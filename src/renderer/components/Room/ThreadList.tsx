// ─── The room's threads ──────────────────────────────────────────────────────
//
// "All activity" first, then the threads: open questions first, then open,
// quiet and closed threads, newest first (orderThreads). A row is a title
// over an 11px line (the thread's reference in mono, its computed status
// when it is not open, the time of its last card). An open question is the
// attention ring and the needs-you count; unread is a neutral count, drawn
// only when it is known and above zero — an unknown read position (null)
// shows nothing, never a 0.
import { FOCUS_RING } from '../focusRing';
import type { ThreadSummary } from '../../../shared/room';
import { ALL_THREADS, orderThreads, type TimelineThread } from '../../stores/slices/roomSlice';
import { formatCardTime, isRefThread, threadRef } from './roomFormat';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The unread count a row shows: a known positive count, else nothing. */
export function unreadLabel(unread: number | null | undefined): string | null {
  return typeof unread === 'number' && unread > 0 ? String(unread) : null;
}

export function ThreadList({ threads, selected, onSelect, t, now }: {
  threads: readonly ThreadSummary[];
  selected: TimelineThread;
  onSelect: (thread: TimelineThread) => void;
  t: T;
  now?: number;
}): React.ReactElement {
  const ordered = orderThreads(threads);
  const rowClass = (on: boolean) =>
    `w-full flex items-start gap-2 px-3 py-1.5 rounded-[6px] text-left ${on ? 'bg-[var(--selection)] shadow-[var(--select-ring)]' : 'hover:bg-[var(--hover-fill)]'} ${FOCUS_RING}`;

  return (
    <div role="listbox" aria-label={t('room.threads')} data-testid="room-thread-list" className="flex flex-col gap-px px-1">
      <button
        type="button"
        role="option"
        aria-selected={selected === ALL_THREADS}
        data-testid="room-thread-all"
        data-thread-id={ALL_THREADS}
        onClick={() => onSelect(ALL_THREADS)}
        className={rowClass(selected === ALL_THREADS)}
      >
        <span className="w-[6px] shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0 text-[13px] text-[var(--text-main)] truncate">{t('room.thread.all')}</span>
      </button>
      {ordered.map((th) => {
        const on = selected === th.threadId;
        const unread = unreadLabel(th.unread);
        const title = th.threadId === 'general' ? t('room.thread.general') : th.title;
        // A PR or issue keeps its reference; a task's or a request's id is
        // never shown (its title names it).
        const ref = isRefThread(th.threadId) ? threadRef(th.threadId, t) : null;
        const parts = [title];
        if (th.openQuestions > 0) parts.push(t('room.thread.openQuestions', { count: th.openQuestions }));
        if (th.status !== 'open') parts.push(t(`room.thread.status.${th.status}`));
        if (unread) parts.push(t('room.thread.unread', { count: unread }));
        return (
          <button
            key={th.threadId}
            type="button"
            role="option"
            aria-selected={on}
            aria-label={parts.join(', ')}
            data-testid="room-thread-row"
            data-thread-id={th.threadId}
            data-thread-status={th.status}
            data-open-questions={th.openQuestions || undefined}
            onClick={() => onSelect(th.threadId)}
            className={rowClass(on)}
          >
            <span className="w-[6px] mt-[6px] shrink-0 flex" aria-hidden="true">
              {th.openQuestions > 0 && (
                <span data-thread-attention className="w-[6px] h-[6px] rounded-full border border-[var(--attention)]" />
              )}
            </span>
            <span className="flex-1 min-w-0">
              <span className={`block text-[13px] truncate ${th.status === 'closed' ? 'text-[var(--text-sub)]' : 'text-[var(--text-main)]'}`}>{title}</span>
              <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] min-w-0">
                {ref && <span className="font-mono truncate">{ref}</span>}
                {th.status !== 'open' && <span data-thread-status-word className="shrink-0">{ref ? '· ' : ''}{t(`room.thread.status.${th.status}`)}</span>}
                {th.lastAt > 0 && <span className="shrink-0 tabular-nums">{ref || th.status !== 'open' ? '· ' : ''}{formatCardTime(th.lastAt, now)}</span>}
              </span>
            </span>
            {th.openQuestions > 0 && (
              <span data-thread-questions className="shrink-0 text-[11px] tabular-nums text-[var(--attention-text)]">{th.openQuestions}</span>
            )}
            {unread && (
              <span data-thread-unread className="shrink-0 text-[11px] tabular-nums text-[var(--text-main)]">{unread}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
