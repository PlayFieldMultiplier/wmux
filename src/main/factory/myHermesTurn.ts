// ─── My Hermes — what a bot on the owner's own Hermes is sent ──────────────
//
// The input boundary of an own-mode bot, checked by BotRuntime on every turn
// (never once at spawn). The owner's Hermes runs with the owner's tool set
// and approvals, so only the owner's own words reach it:
// - only an attended, untainted wake: the owner's own message in the bot's
//   1:1 chat (wakeTaint.ts runningWakeAttended). Schedules, routines,
//   handoffs, mentions, facts and the Run button carry no owner message and
//   are refused with a room note;
// - only the bot's 1:1 chat, and only while no other bot and no guest has
//   ever written there;
// - the prompt is the owner's message alone: no room history, no system
//   prompt (AcpBrainAdapter own mode), and a leading `/` is escaped so the
//   owner's words are never a Hermes slash command (only wmux's own `/tools`
//   probe sends one).

import type { WakeItem } from '../../shared/wake';
import { dmThreadId, isGuestSourcedCard, type RoomCard } from '../../shared/room';

/** Why an own-mode bot's wake is not sent to Hermes, or null. Pure. */
export function ownHermesWakeRefusal(input: { item: WakeItem; botId: string; attended: boolean; roomClean: boolean | null }): string | null {
  const r = input.item.reason;
  if (r.kind !== 'human') return 'My Hermes answers only your own messages in its 1:1 chat, so this was not sent to it.';
  if (input.item.threadId !== dmThreadId(input.botId) || r.room === true || r.roomWide === true || r.lead === true) {
    return 'My Hermes talks with you one to one, so a message outside its 1:1 chat was not sent to it.';
  }
  if (!input.attended) return 'wmux could not confirm this message is yours alone, so it was not sent to My Hermes.';
  if (input.roomClean !== true) return 'Another bot or a guest has written in this chat, so wmux no longer sends it to My Hermes.';
  return null;
}

/** The owner's message as Hermes is sent it: a leading `/` escaped. Pure. */
export function ownHermesPrompt(text: string): string {
  return text.replace(/^(\s*)\//, '$1\\/');
}

/** Whether the bot's 1:1 chat holds only the owner's, the bot's own and
 *  wmux's cards (no other bot's, no guest's, ever). Null when the room
 *  cannot be read. */
export function ownHermesRoomClean(
  writer: { find(workspaceId: string, match: (c: RoomCard) => boolean, opts?: { guests?: boolean }): RoomCard | null } | null,
  workspaceId: string,
  botId: string,
): boolean | null {
  if (!writer) return null;
  const thread = dmThreadId(botId);
  try {
    const other = writer.find(
      workspaceId,
      (c) => c.threadId === thread && (isGuestSourcedCard(c) || (c.actor.kind === 'bot' && c.actor.botId !== botId)),
      { guests: true },
    );
    return other === null;
  } catch {
    return null;
  }
}
