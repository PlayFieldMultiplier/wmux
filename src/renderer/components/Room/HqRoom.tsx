// ─── The HQ room's top: Moa's plan and report, and every bot ────────────────
//
// Above the HQ room's threads: the latest `plan` card pinned with its
// answers while it is open (Approve — the one primary — Edit, Decline), the
// latest `report` card, and one strip of every bot across workspaces
// (presence, queue, budget). Both pinned cards fold: an open plan to its
// title, its answers (right under the title, so they stay in view) and a
// clamped preview, an answered plan and the report to their title, until
// opened. The region gives way to the timeline (RoomDock keeps the cards at
// least 40% of the height) down to the floor RoomDock gives it, which holds
// only while something is pinned. Inside it the plan's body is what gives
// way, and only once the card alone is taller than the region (the bots
// strip below scrolls away first): the card's frame, title and answers stay
// whole (planFit), and the preview loses whole lines rather than showing a
// cut one. The plan's answer goes through room:resolve as
// one of the PLAN_RESOLUTION strings, which the role that proposed the plan
// reads from the resolved card.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { RoomCard as RoomCardData, ThreadSummary } from '../../../shared/room';
import { ALL_THREADS, timelineKey } from '../../stores/slices/roomSlice';
import { loadRoomTimeline, roomsApi, type RoomsApi } from '../../hooks/useRoomSync';
import { FOCUS_RING } from '../focusRing';
import Button from '../ui/Button';
import { renderBrainMarkdown } from '../shared/BrainMarkdown';
import type { FactoryBotRow } from './factoryPorts';
import { BotChips } from './BotChips';
import { useFactoryBots } from './useFactoryBots';
import { formatCardTime, planTextWithNames } from './roomFormat';
import { PlanAnswers, useWorkspaceNames } from './CardAnswers';

type T = (key: string, vars?: Record<string, string | number>) => string;

export { PLAN_RESOLUTION } from './CardAnswers';

/** The newest card of a kind among the given timelines' cards. */
export function latestCardOfKind(cards: readonly RoomCardData[], kind: 'plan' | 'report'): RoomCardData | null {
  let best: RoomCardData | null = null;
  for (const c of cards) if (c.kind === kind && (!best || c.seq > best.seq)) best = c;
  return best;
}

/** The thread most recently written of a kind (`plan:` / `report:`). */
export function latestThreadOf(threads: readonly ThreadSummary[], prefix: 'plan:' | 'report:'): ThreadSummary | null {
  let best: ThreadSummary | null = null;
  for (const th of threads) if (th.threadId.startsWith(prefix) && (!best || th.lastSeq > best.lastSeq)) best = th;
  return best;
}

function usePinned(workspaceId: string, kind: 'plan' | 'report'): RoomCardData | null {
  const threads = useStore((s) => s.roomThreads[workspaceId]);
  const thread = useMemo(() => latestThreadOf(threads ?? [], kind === 'plan' ? 'plan:' : 'report:'), [threads, kind]);
  const threadKey = thread ? timelineKey(workspaceId, thread.threadId) : null;
  const threadCards = useStore((s) => (threadKey ? s.roomTimelines[threadKey]?.cards : undefined));
  const allCards = useStore((s) => s.roomTimelines[timelineKey(workspaceId, ALL_THREADS)]?.cards);
  useEffect(() => {
    if (thread && !useStore.getState().roomTimelines[timelineKey(workspaceId, thread.threadId)]) void loadRoomTimeline(workspaceId, thread.threadId);
  }, [workspaceId, thread]);
  useEffect(() => {
    if (!useStore.getState().roomTimelines[timelineKey(workspaceId, ALL_THREADS)]) void loadRoomTimeline(workspaceId, ALL_THREADS);
  }, [workspaceId]);
  return useMemo(() => latestCardOfKind([...(threadCards ?? []), ...(allCards ?? [])], kind), [threadCards, allCards, kind]);
}

/**
 * How the plan card fits a short region: the card never shrinks below
 * everything but its body (`fixedHeight`: its frame, the other rows and every
 * margin, measured from the rows themselves since the card may already be
 * squeezed), and when a rendered line of the preview runs past the body's
 * bottom, everything below the last whole line is clipped off
 * (`clipBottom`), so the preview ends on a whole line whatever its markdown
 * (`lineBottoms`: each rendered line box's bottom, from the body's top).
 * Pure; heights in px.
 */
export function planFit(m: { fixedHeight: number; bodyHeight: number; lineBottoms: readonly number[] }): { minHeight: number; clipBottom: number } {
  const minHeight = Math.max(0, m.fixedHeight);
  const edge = m.bodyHeight + 0.5;
  if (!m.lineBottoms.some((b) => b > edge)) return { minHeight, clipBottom: 0 };
  const whole = m.lineBottoms.reduce((best, b) => (b <= edge && b > best ? b : best), 0);
  return { minHeight, clipBottom: Math.max(0, m.bodyHeight - whole) };
}

/** The bottom of every rendered text line box in `el`, from its top. */
function lineBottoms(el: HTMLElement): number[] {
  const top = el.getBoundingClientRect().top;
  const out: number[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim()) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.height > 0) out.push(r.bottom - top);
  }
  return out;
}

function PlanCard({ card, workspaceId, t, api }: { card: RoomCardData; workspaceId: string; t: T; api: RoomsApi | null }) {
  // The answers (and the edit field) are the shared CardAnswers; the card
  // only needs to know while the edit field is open.
  const [editing, setEditing] = useState(false);
  const nameOf = useWorkspaceNames();
  const open = card.state === 'open';
  // Folded by default: an open plan shows its answers under the title and a
  // clamped preview of its body; an answered one only its title.
  const [expanded, setExpanded] = useState(false);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) setExpanded(false);
    wasOpen.current = open;
  }, [open]);
  const cardRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const showBody = !editing && !!card.body && (expanded || open);
  useLayoutEffect(() => {
    const el = cardRef.current;
    const body = bodyRef.current;
    if (!el) return;
    if (!body || typeof ResizeObserver === 'undefined') {
      el.style.minHeight = '';
      return;
    }
    const px = (v: string) => parseFloat(v) || 0;
    const measure = () => {
      const cs = getComputedStyle(el);
      let fixedHeight = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
      for (const child of [...el.children] as HTMLElement[]) {
        const ccs = getComputedStyle(child);
        fixedHeight += px(ccs.marginTop) + px(ccs.marginBottom) + (child === body ? 0 : child.getBoundingClientRect().height);
      }
      const fit = planFit({ fixedHeight, bodyHeight: body.getBoundingClientRect().height, lineBottoms: expanded ? [] : lineBottoms(body) });
      el.style.minHeight = `${fit.minHeight}px`;
      body.style.clipPath = expanded || fit.clipBottom === 0 ? '' : `inset(0 0 ${fit.clipBottom}px 0)`;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(body);
    return () => ro.disconnect();
  }, [showBody, expanded, editing]);

  return (
    <section
      ref={cardRef}
      data-testid="hq-plan"
      data-room-card-id={card.id}
      data-card-state={card.state ?? undefined}
      aria-label={t('room.hq.plan')}
      className={`flex flex-col shrink-0 ${showBody && !expanded ? 'max-h-full' : ''} px-3 py-2.5 rounded-[10px] bg-[var(--selection-subtle)] ${open ? 'border border-[var(--attention-hairline)]' : ''}`}
    >
      <div className="shrink-0 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
        <span className={open ? 'text-[var(--attention-text)]' : 'text-[var(--text-sub)]'}>{t('room.hq.plan')}</span>
        <span aria-hidden="true">·</span>
        <span>{t(`room.state.${card.state ?? 'resolved'}`)}</span>
        <span className="ml-auto tabular-nums">{formatCardTime(card.at)}</span>
      </div>
      <div className="shrink-0 mt-0.5 text-[13px] text-[var(--text-main)] break-words">{planTextWithNames(card.title, nameOf, t)}</div>
      <PlanAnswers card={card} workspaceId={workspaceId} t={t} api={api} onEditingChange={setEditing} />
      {showBody && card.body && (
        <div
          ref={bodyRef}
          data-plan-body
          data-clamped={expanded ? undefined : 'true'}
          className={`mt-1.5 text-[13px] leading-relaxed text-[var(--text-sub)] break-words ${expanded ? 'shrink-0 max-h-[160px] overflow-y-auto' : 'min-h-0 line-clamp-3'}`}
        >
          {renderBrainMarkdown(planTextWithNames(card.body, nameOf, t), { links: true })}
        </div>
      )}
      {!editing && card.body && (
        <button
          type="button"
          data-testid="hq-plan-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={`shrink-0 self-start mt-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
        >
          {expanded ? t('room.showLess') : t('room.showMore')}
        </button>
      )}
    </section>
  );
}

function ReportCard({ card, t }: { card: RoomCardData; t: T }) {
  const [open, setOpen] = useState(false);
  return (
    <section data-testid="hq-report" data-room-card-id={card.id} aria-label={t('room.hq.report')} className="shrink-0 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
        <span className="text-[var(--text-sub)]">{t('room.hq.report')}</span>
        <span className="ml-auto tabular-nums">{formatCardTime(card.at)}</span>
      </div>
      <div className="mt-0.5 text-[13px] text-[var(--text-main)] break-words">{card.title}</div>
      {card.body && (
        <>
          {open && <div data-report-body className="mt-1 text-[13px] leading-relaxed text-[var(--text-sub)] break-words">{renderBrainMarkdown(card.body, { links: true })}</div>}
          <button type="button" data-testid="hq-report-more" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={`mt-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>
            {open ? t('room.showLess') : t('room.showMore')}
          </button>
        </>
      )}
    </section>
  );
}

export function HqRoom({ workspaceId, allBots: botsOverride, t, workspaceName, api, minHeight }: {
  workspaceId: string;
  /** Tests: every bot, across workspaces (default: the bot port's list). */
  allBots?: readonly FactoryBotRow[];
  t: T;
  workspaceName: (id: string) => string;
  api?: RoomsApi | null;
  /** How far the region may shrink (RoomDock's HQ_PINNED_MIN_HEIGHT). */
  minHeight?: string;
}): React.ReactElement | null {
  const liveBots = useFactoryBots(null);
  const allBots = botsOverride ?? liveBots;
  const plan = usePinned(workspaceId, 'plan');
  const report = usePinned(workspaceId, 'report');
  const bridge = api === undefined ? roomsApi() : api;
  // The strip spans workspaces: each chip names its workspace after the bot.
  if (!plan && !report && allBots.length === 0) return null;
  // The floor holds only while something is pinned: the bots alone keep no
  // empty reserve above the threads.
  const floor = minHeight && (plan || report) ? { minHeight } : undefined;
  return (
    <div data-testid="hq-room" className="shrink max-h-[34%] overflow-y-auto flex flex-col gap-1.5 px-2 pb-2" style={floor}>
      {plan && <PlanCard key={plan.id} card={plan} workspaceId={workspaceId} t={t} api={bridge} />}
      {report && <ReportCard card={report} t={t} />}
      {allBots.length > 0 && (
        <div data-testid="hq-bots" className="shrink-0 px-1">
          <div className="mb-1 text-[11px] text-[var(--text-muted)]">{t('room.hq.allBots')}</div>
          <BotChips rows={allBots} t={t} secondaryOf={(row) => workspaceName(row.bot.workspaceId)} />
        </div>
      )}
    </div>
  );
}
