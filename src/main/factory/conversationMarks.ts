// ─── Conversation marks — what a bot's live conversation has taken in ──────
//
// A bot's engine conversation outlives its wakes: the runtime resumes it for
// the next one (BotRuntime session()), so text a tainted turn brought in is
// still in context when a later, clean turn runs. Its mark follows the
// conversation, not the wake:
//
//   tainted      a wake run in it was started from outside text, or could
//                not be told clean (wakeTaint.ts wakeTainted)
//   signedIn     a wake run in it carried a fact of a task that used a
//                signed-in connection (wakeTaint.ts wakeSignedIn): what the
//                worker read with the owner's sign-in is in this
//                conversation. Always tainted too.
//
// Readers: memory.update (nothing is saved from a tainted conversation but
// on the owner's approval card, ownerAsked.ts), the
// handoff marks (wakeTaint.ts markSent / markForward: what a bot sends from
// one is tainted), the standing instructions (routine.set, job_set and
// workflow.create are refused from a tainted one; a new routine the owner
// asked for goes to their approval card), the attended check of a
// bot's commands and file edits (wakeTaint.ts runningWakeAttended), and the
// ways out of a signed-in one (signedInRefusal: fan-outs, worker messages
// and resumes but to its signed-in tasks, handoffs, mentions, and posts
// outside the bot's own 1:1; the cards a bot addresses to the owner,
// ask_person, approval_request, secret_request and login_request, land in
// that 1:1 and are refused anywhere else it names; a ledger_update's words
// on a task that used no signed-in connection). Only a wake sets the
// signed-in mark: a bot never reads a signed-in task's pane (input.rpc.ts
// refuses it). The runtime starts a conversation's mark when it
// spawns one (clean when fresh, from the saved session record when resumed,
// set for a guest's conversation of its own) and ends it when it ends the
// session. A mark is only ever set, never cleared, until the conversation
// starts afresh. A bot with no live conversation has no marks: a reader
// treats that as unknown. A wake that cannot be told clean of a signed-in
// task's data is held as signed-in for that wake only (holdSignedInForWake):
// readers see it, the saved record never does.

export interface ConversationMarks {
  tainted: boolean;
  signedIn: boolean;
}

const marks = new Map<string, ConversationMarks>();
/** Bots whose running wake cannot be told clean of a signed-in task's data:
 *  read as signed-in for that wake only, never saved (holdSignedInForWake). */
const heldForWake = new Set<string>();
let listener: ((botId: string, marks: ConversationMarks) => void) | null = null;

/** A conversation starts (or is resumed) for `botId`. */
export function startConversation(botId: string, init: ConversationMarks): void {
  marks.set(botId, { tainted: init.tainted || init.signedIn, signedIn: init.signedIn });
}

/** The bot's conversation ended. */
export function endConversation(botId: string): void {
  marks.delete(botId);
  heldForWake.delete(botId);
}

/** The bot's running wake may carry a signed-in task's data but cannot be
 *  told (wakeTaint.ts wakeSignedIn 'unknown'): its conversation reads as
 *  signed-in until the wake ends (releaseWakeHold). The saved marks, and
 *  conversationMarks, do not change. */
export function holdSignedInForWake(botId: string): void {
  if (marks.has(botId)) heldForWake.add(botId);
}

/** The wake that held the mark ended. */
export function releaseWakeHold(botId: string): void {
  heldForWake.delete(botId);
}

/** Set one mark on the bot's live conversation (none: nothing to mark). A
 *  signed-in one is tainted as well. */
export function markConversation(botId: string, mark: keyof ConversationMarks): void {
  const m = marks.get(botId);
  if (!m || m[mark]) return;
  m[mark] = true;
  if (mark === 'signedIn') m.tainted = true;
  try {
    listener?.(botId, { ...m });
  } catch (err) {
    console.warn(`[factory] conversation mark of ${botId} not saved: ${String(err)}`);
  }
}

/** The bot's live conversation's marks, or null when it has none. */
export function conversationMarks(botId: string): ConversationMarks | null {
  const m = marks.get(botId);
  return m ? { ...m } : null;
}

/** Whether the bot's live conversation holds data from a signed-in task;
 *  a bot with no live conversation reads as yes (a bot's call runs inside
 *  its turn, which always has one). */
export function conversationSignedIn(botId: string): boolean {
  return heldForWake.has(botId) || marks.get(botId)?.signedIn !== false;
}

/** Whether the bot's live conversation has taken in outside text; a bot
 *  with no live conversation reads as yes. */
export function conversationTainted(botId: string): boolean {
  return heldForWake.has(botId) || marks.get(botId)?.tainted !== false;
}

/** What bot `botId` is told when its conversation, holding data from a
 *  signed-in task, asks to move it somewhere: `what` names the refused act. */
export function signedInRefusal(what: string, botId: string): string {
  return `this conversation holds data from a signed-in task, so it can't ${what}; reply to the owner in your 1:1 instead (room_post with thread_id "dm:${botId}")`;
}

/** What a bot is told when a tainted conversation asks to save work that
 *  runs later (a routine, a job, a workflow). */
export const TAINTED_CONVERSATION_SAVES_NOTHING = 'this conversation has taken in outside text, so it saves nothing that runs later, even on the owner\'s words; ask the owner to start a new conversation with you (New conversation, on your profile in the Bots page) and to ask for it again there';

/** Told when a mark is set (the runtime saves it with the session record). */
export function setConversationMarkListener(fn: ((botId: string, marks: ConversationMarks) => void) | null): void {
  listener = fn;
}

/** Test-only. */
export function __resetConversationMarksForTesting(): void {
  marks.clear();
  heldForWake.clear();
  listener = null;
}
