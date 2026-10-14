// ─── A Bots conversation as a flat timeline (owner decision 2026-10-14) ────
//
// Messages are flat rows, not bubbles. The history becomes a list of items:
// a day divider, the session's "New" divider, a bot's "joined" line, a
// system line (consecutive system cards of one thread merged into one), and
// messages. A message continues the run above it — no avatar, no name, its
// time only on hover — when the same author wrote it less than ten minutes
// after the previous one with nothing between them. A card that waits on the
// owner (an open question, plan, proposal, approval, key or login request)
// keeps its bordered card, so it never continues a run nor is continued, and
// a card with a kind word (Verdict, Report…) starts a run so its header can
// carry the word.
//
// Threads (owner decision 2026-10-14): a non-General thread shows in the main
// timeline as its first card (the root), with "N replies · last 14:02" under
// it that opens the thread in a side panel. Its other cards live in that
// panel, except a card that waits on the owner, which always shows in the
// main timeline too.
//
// Pure; times are local.
import type { RoomCard, ThreadId } from '../../../shared/room';
import type { FactoryBotRow } from '../Room/factoryPorts';
import type { RoomEntry } from './botsModel';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** A run of one author's messages holds while each follows the last by less than this. */
export const RUN_WINDOW_MS = 10 * 60_000;

/** The kinds that read as plain speech: no kind word in the run header. */
const PLAIN_KINDS: ReadonlySet<RoomCard['kind']> = new Set<RoomCard['kind']>(['opinion', 'status', 'human']);

/** A thread as its root's summary line shows it. */
export interface ThreadView {
  workspaceId: string;
  threadId: ThreadId;
  /** The thread's cards after its root. */
  replies: number;
  /** The newest reply's time (the root's when there is none). */
  lastAt: number;
}

export type TimelineItem =
  | { kind: 'day'; key: string; at: number }
  | { kind: 'new'; key: string }
  | { kind: 'joined'; key: string; row: FactoryBotRow }
  | { kind: 'system'; key: string; cards: RoomCard[] }
  | { kind: 'message'; key: string; card: RoomCard; continuation: boolean; waiting: boolean; thread?: ThreadView };

/** The key a thread is known by: a thread id is a room's own, so a 1:1
 *  (which spans rooms) keys it with its workspace. */
export function threadKey(workspaceId: string, threadId: ThreadId): string {
  return `${workspaceId}\u0000${threadId}`;
}

/** The main timeline's cards and the threads behind them: General cards,
 *  each thread's root (first card) with its summary, and any thread card
 *  that waits on the owner. */
export function splitThreads(cards: readonly RoomCard[], waits: (card: RoomCard) => boolean): { main: RoomCard[]; threads: Map<string, ThreadView> } {
  const main: RoomCard[] = [];
  const byKey = new Map<string, ThreadView>();
  const rootOf = new Map<string, string>();
  for (const card of cards) {
    if (card.threadId === 'general') {
      main.push(card);
      continue;
    }
    const key = threadKey(card.workspaceId, card.threadId);
    const view = byKey.get(key);
    if (!view) {
      byKey.set(key, { workspaceId: card.workspaceId, threadId: card.threadId, replies: 0, lastAt: card.at });
      rootOf.set(key, card.id);
      main.push(card);
      continue;
    }
    view.replies += 1;
    view.lastAt = Math.max(view.lastAt, card.at);
    if (waits(card)) main.push(card);
  }
  const threads = new Map<string, ThreadView>();
  for (const [key, view] of byKey) threads.set(rootOf.get(key)!, view);
  return { main, threads };
}

/** A thread's own cards, and the cards elsewhere that link it (an approval
 *  posted in General about a PR), in order. */
export function threadCards(cards: readonly RoomCard[], workspaceId: string, threadId: ThreadId): RoomCard[] {
  return cards.filter((c) => c.workspaceId === workspaceId && (c.threadId === threadId || c.refs?.threadId === threadId));
}

/** Who wrote a card, as runs compare it. */
function author(card: RoomCard): string {
  return card.actor.kind === 'bot' ? `bot:${card.actor.botId}` : card.actor.kind;
}

/** The local day a time falls on. */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function entryAt(entry: RoomEntry): number {
  return entry.kind === 'card' ? entry.card.at : entry.row.bot.createdAt;
}

/**
 * The timeline items for entries already in order. `waits` says which
 * cards wait on the owner; `threads` maps a root card's id to its thread;
 * `newAfter` places the "New" divider above the first card from someone
 * else written after it (null: none).
 */
export function buildTimeline(entries: readonly RoomEntry[], opts: {
  waits: (card: RoomCard) => boolean;
  threads?: ReadonlyMap<string, ThreadView>;
  newAfter?: number | null;
}): TimelineItem[] {
  const out: TimelineItem[] = [];
  let day = '';
  let newPlaced = opts.newAfter == null;
  for (const entry of entries) {
    const at = entryAt(entry);
    const d = dayKey(at);
    if (d !== day) {
      day = d;
      out.push({ kind: 'day', key: `day:${d}`, at });
    }
    if (!newPlaced && entry.kind === 'card' && entry.card.actor.kind !== 'human' && at > (opts.newAfter as number)) {
      newPlaced = true;
      out.push({ kind: 'new', key: 'new' });
    }
    if (entry.kind === 'joined') {
      out.push({ kind: 'joined', key: `joined:${entry.row.bot.id}`, row: entry.row });
      continue;
    }
    const card = entry.card;
    const prev = out[out.length - 1];
    if (card.actor.kind === 'system') {
      if (prev?.kind === 'system' && prev.cards[0].threadId === card.threadId && prev.cards[0].workspaceId === card.workspaceId) {
        prev.cards.push(card);
        prev.key = `system:${prev.cards[0].id}`;
      } else {
        out.push({ kind: 'system', key: `system:${card.id}`, cards: [card] });
      }
      continue;
    }
    const waiting = opts.waits(card);
    const continuation = prev?.kind === 'message'
      && !waiting && !prev.waiting
      && PLAIN_KINDS.has(card.kind)
      && author(prev.card) === author(card)
      && card.at - prev.card.at < RUN_WINDOW_MS;
    const thread = opts.threads?.get(card.id);
    out.push({ kind: 'message', key: card.id, card, continuation, waiting, ...(thread ? { thread } : {}) });
  }
  return out;
}

/** Whether a card's kind gets a word in its run header (Verdict, Report…). */
export function hasKindWord(card: RoomCard): boolean {
  return !PLAIN_KINDS.has(card.kind);
}

/** A run header's time: the clock. */
export function clockTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** A time in full, for a tooltip. */
export function fullTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A day divider's label: Today, Yesterday, or the date (with the year
 *  when it is not this year's). */
export function dayLabel(at: number, now: number, t: T): string {
  if (dayKey(at) === dayKey(now)) return t('botsPage.chat.today');
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dayKey(at) === dayKey(y.getTime())) return t('botsPage.chat.yesterday');
  const d = new Date(at);
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Elapsed time as m:ss (h:mm:ss past an hour). */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** The cards a reader has not seen: bot messages written after `since`. */
export function unreadCount(cards: readonly RoomCard[], since: number): number {
  let n = 0;
  for (const c of cards) if (c.actor.kind === 'bot' && c.at > since) n += 1;
  return n;
}
