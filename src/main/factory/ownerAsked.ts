// ─── Owner-asked cards — the owner's own request in a tainted conversation ──
//
// A conversation that took in outside text saves nothing that runs later on
// its own (conversationMarks.ts): its text could steer what is saved. When
// the owner's own message asks for it (a routine, a note in the bot's notes,
// a change to their profile), the write becomes an approval card instead
// (approvals.ts proposeOwnerAsked) that shows the owner's message and the
// whole change, and only the owner's Approve on that desktop card saves it.
//
// This module holds the proof that the running turn is on the owner's own
// words: the `human` card the room store holds as the owner's, named by the
// running wake (its clientMessageId, or its run). Never the wake's text: main
// builds `human` wakes from bot-written text too (a gardener's or a plan's
// answer), and those name no owner card. A message to several bots or to the
// whole room is no instruction to this bot alone, so it proves nothing.

import type { RoomCard, ThreadId } from '../../shared/room';
import type { WakeItem } from '../../shared/wake';
import { getBotRuntime } from './BotRuntime';
import { humanCardIdOfRun } from './humanMessage';
import { getRoomWriter, type RoomWriter } from './roomWriter';
import { currentWakeItem } from './wakeQueue';

/** The longest piece of the owner's message a card quotes. */
export const OWNER_EXCERPT_MAX = 200;

export interface OwnerCardProof {
  /** The wake that runs on the owner's card. */
  wakeId: string;
  cardId: string;
  /** The card's thread, which the wake runs in. */
  threadId: ThreadId;
  /** The start of the owner's message, as the card stores it, on one line. */
  excerpt: string;
}

/** The start of an owner card's words, on one line. Pure. */
export function ownerExcerpt(card: Pick<RoomCard, 'title' | 'body'>): string {
  const text = (card.body?.trim() ? card.body : card.title).replace(/\s+/g, ' ').trim();
  return text.length > OWNER_EXCERPT_MAX ? `${text.slice(0, OWNER_EXCERPT_MAX - 1)}…` : text;
}

/** The owner's `human` card wake `item` runs on, or null: none named, not
 *  stored as the owner's, in another thread, or a message to several bots.
 *  Never throws. */
export function ownerCardProof(
  item: Pick<WakeItem, 'id' | 'workspaceId' | 'threadId' | 'reason'> | null,
  writer: Pick<RoomWriter, 'get'> | null,
): OwnerCardProof | null {
  try {
    if (!item || !writer || item.reason.kind !== 'human' || !item.threadId) return null;
    const r = item.reason;
    if (r.room || r.roomWide || r.roomAnswerer) return null;
    for (const id of new Set([r.clientMessageId, humanCardIdOfRun(r.runId)])) {
      if (typeof id !== 'string' || !id) continue;
      const card = writer.get(item.workspaceId, id);
      if (card && card.kind === 'human' && card.actor.kind === 'human' && card.threadId === item.threadId) {
        return { wakeId: item.id, cardId: card.id, threadId: card.threadId, excerpt: ownerExcerpt(card) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** ownerCardProof for the wake `botId` runs now, when the queue and the
 *  runtime agree on which wake that is. Never throws. */
export function runningOwnerCardProof(botId: string): OwnerCardProof | null {
  try {
    const item = currentWakeItem(botId);
    if (!item || getBotRuntime()?.currentTurn(botId)?.wakeId !== item.id) return null;
    return ownerCardProof(item, getRoomWriter());
  } catch {
    return null;
  }
}
