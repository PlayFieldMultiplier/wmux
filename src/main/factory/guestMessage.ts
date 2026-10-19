// ─── A guest bot's message (main side of `workspaces.guestPost`) ────────────
//
// The daemon authenticated the guest, checked its grants and budget, redacted
// key patterns and sends the guest's stored conversation (never one the wire
// named). Main writes one `guest` card there (actor system, `guest` set, the
// title "External guest: <name>") and wakes only the bots the post names that
// belong to the conversation: a 1:1's own bot, a group's members, or for
// General the enabled bots of that room. Each wake is a priority-2 `guest`
// wake within the bot's queue cap (never past it, unlike the owner's), and
// `guest` wakes are tainted (wakeTaint.ts), so the merge lane and remembered
// rules never merge what they start.
//
// A guest writes no human card, no fact, no handoff and no approval; it
// starts no worker and uses no connector. Idempotent per (guest, message
// id): a repeat returns the first card and queues nothing again (the queue
// dedupes `guest:<cardId>` per bot).

import { BOT_ID_RE, type BotProfile } from '../../shared/bot';
import {
  GUEST_LIMITS, GUEST_MESSAGE_ID_RE, guestCardTitle, isGuestId, parseGuestScope, sanitizeGuestName,
  type GuestPostResult,
} from '../../shared/guestBots';
import { GENERAL_THREAD, ROOM_LIMITS, dmThreadBot, groupThreadGroup, type ThreadId } from '../../shared/room';
import { capBody, type FactoryRoomPorts, type RoomWriter } from './roomWriter';
import { redactStoredSecrets } from './secretRedaction';

export type GuestPostHandler = (payload: Record<string, unknown>) => Promise<GuestPostResult>;

let handler: GuestPostHandler | null = null;

/** Installed by the factory wiring; null while the factory is off. */
export function setGuestPostHandler(h: GuestPostHandler | null): void {
  handler = h;
}

/** The bridge command. Never rejects for a refusal; a malformed payload is `invalid`. */
export async function handleGuestPost(payload: Record<string, unknown>): Promise<GuestPostResult> {
  if (!handler) return { ok: false, code: 'factory_off' };
  try {
    return await handler(payload);
  } catch (err) {
    console.warn(`[factory] guest post failed: ${String(err)}`);
    return { ok: false, code: 'busy' };
  }
}

export interface GuestPostDeps {
  enabled: () => boolean;
  writer: () => RoomWriter | null;
  ports: () => Partial<FactoryRoomPorts>;
}

interface ParsedPost {
  guestId: string;
  guestName: string;
  workspaceId: string;
  threadId: ThreadId;
  clientMessageId: string;
  text: string;
  mentions: string[];
}

function parsePayload(raw: Record<string, unknown>): ParsedPost | null {
  const scope = parseGuestScope({ workspaceId: raw.workspaceId, threadId: raw.threadId });
  const guestName = sanitizeGuestName(raw.guestName);
  if (!scope || !isGuestId(raw.guestId) || !guestName) return null;
  if (typeof raw.clientMessageId !== 'string' || !GUEST_MESSAGE_ID_RE.test(raw.clientMessageId)) return null;
  if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > GUEST_LIMITS.textMax) return null;
  if (!Array.isArray(raw.mentions) || raw.mentions.length > GUEST_LIMITS.mentionsMax ||
      !raw.mentions.every((id) => typeof id === 'string' && BOT_ID_RE.test(id))) return null;
  return {
    guestId: raw.guestId, guestName, workspaceId: scope.workspaceId, threadId: scope.threadId,
    clientMessageId: raw.clientMessageId, text: raw.text, mentions: [...new Set(raw.mentions as string[])],
  };
}

/** The bots of the conversation a guest's post may name, or null when the
 *  conversation is gone (its bot removed, its group deleted). */
function conversationBots(ports: Partial<FactoryRoomPorts>, workspaceId: string, threadId: ThreadId): BotProfile[] | null {
  let enabled: BotProfile[] = [];
  try {
    enabled = (ports.bots?.listEnabled() ?? []).filter((b) => b.enabled);
  } catch {
    enabled = [];
  }
  const dmBot = dmThreadBot(threadId);
  if (dmBot) {
    let bot: BotProfile | null = null;
    try {
      bot = ports.bots?.get(dmBot) ?? null;
    } catch {
      bot = null;
    }
    if (!bot || bot.workspaceId !== workspaceId) return null;
    return enabled.filter((b) => b.id === bot.id);
  }
  let group: { memberIds: string[] } | null = null;
  try {
    group = ports.groups?.byThread(workspaceId, threadId) ?? null;
  } catch {
    group = null;
  }
  if (groupThreadGroup(threadId)) {
    if (!group) return null;
    return enabled.filter((b) => group.memberIds.includes(b.id));
  }
  if (threadId === GENERAL_THREAD) {
    // General: a group made from the room, else the room's own bots.
    return enabled.filter((b) => b.workspaceId === workspaceId && (!group || group.memberIds.includes(b.id)));
  }
  return null;
}

/** Post one guest message. Synchronous from the lookup to the post. */
export function postGuestMessage(raw: Record<string, unknown>, deps: GuestPostDeps): GuestPostResult {
  if (!deps.enabled()) return { ok: false, code: 'factory_off' };
  const p = parsePayload(raw);
  if (!p) return { ok: false, code: 'invalid' };
  const writer = deps.writer();
  const ports = deps.ports();
  if (!writer) return { ok: false, code: 'busy' };
  const members = conversationBots(ports, p.workspaceId, p.threadId);
  if (!members) return { ok: false, code: 'scope_gone' };
  const byId = new Map(members.map((b) => [b.id, b]));
  // Every name must be a bot of this conversation that is on: a guest never
  // reaches a bot the owner did not put here.
  if (p.mentions.some((id) => !byId.has(id))) return { ok: false, code: 'mention_refused' };
  const clientPostId = `guest:${p.guestId}:${p.clientMessageId}`.slice(0, ROOM_LIMITS.CLIENT_ID_MAX);
  // Processed whole, shortened last (as the room does).
  const body = capBody(redactStoredSecrets(p.text));
  const prior = writer.find(p.workspaceId, (c) => c.clientPostId === clientPostId);
  if (prior) {
    // A repeat is the same words in the same thread, or a reused id.
    if (prior.kind !== 'guest' || prior.threadId !== p.threadId || (prior.body ?? '') !== body) return { ok: false, code: 'id_reused' };
    return { ok: true, cardId: prior.id, seq: prior.seq, duplicate: true, woke: prior.refs?.botIds ?? [] };
  }
  const r = writer.post({
    workspaceId: p.workspaceId,
    threadId: p.threadId,
    kind: 'guest',
    actor: { kind: 'system' },
    title: guestCardTitle(p.guestName),
    body,
    ...(p.mentions.length > 0 ? { refs: { botIds: p.mentions } } : {}),
    guest: { guestId: p.guestId, name: p.guestName },
    clientPostId,
  });
  if (!r.ok) return { ok: false, code: 'invalid' };
  const card = r.card;
  const woke: string[] = [];
  for (const id of p.mentions) {
    const bot = byId.get(id)!;
    try {
      const item = ports.wakes?.enqueue({
        botId: bot.id,
        workspaceId: bot.workspaceId,
        reason: { kind: 'guest', guestId: p.guestId, guestName: p.guestName, cardId: card.id, text: body },
        // Below the owner's and the factory's own work, and within the cap.
        priority: 2,
        threadId: card.threadId,
      });
      if (item) woke.push(bot.id);
    } catch (err) {
      console.warn('[factory] rooms: guest wake not enqueued', err);
    }
  }
  return { ok: true, cardId: card.id, seq: card.seq, ...(r.duplicate ? { duplicate: true as const } : {}), woke };
}
