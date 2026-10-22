// ─── Bot group chats — reactions and round caps ────────────────────────────
//
// Adapted from Open-Hermes-Bot (https://github.com/AZERDSQ131/Open-Hermes-Bot,
// MIT, Copyright (c) 2026 Jules Yzerd), src/group.ts (silentReaction, the
// round caps) and src/reactions.ts (the `[[react:…]]` marker, its palette and
// isEmoji). See THIRD_PARTY_NOTICES.md.
//
// In a group chat (shared/botGroup.ts) a bot woken by the owner's message or
// by another bot's mention has three moves: speak (a card), react (end the
// turn with `[[react:👍]]` alone, or before its words) or stay silent (end
// with no card). Main turns the last two into a reaction on the card the bot
// was woken for (RoomCard.reactions): a silent bot leaves an acknowledgement,
// so it never just vanishes. A reaction is UI data on that card and nothing
// else: it writes no fact, wakes no bot and starts no handoff.
//
// A group can talk itself into a loop (A mentions B, B mentions A, …). A
// round is what follows the owner's message in the group's thread; it holds
// GROUP_ROUND_LIMITS.LINES bot cards, LINES_PER_BOT of one bot, and bot-to-
// bot mentions MENTION_WAVES deep. Past that a bot's post is refused, and so
// its mentions wake nobody: the chain ends.

/** The acknowledgements a silent bot leaves: neutral, none a judgement. */
export const SILENT_ACK_EMOJI: readonly string[] = ['👍', '👀', '✅', '🙌'];

/** What a bot may react with: a phone's tapbacks and the acknowledgements.
 *  A small fixed palette keeps the thread calm, and a reaction carries
 *  nothing a bot could not say with one of these. */
export const REACTION_EMOJI: readonly string[] = ['❤️', '👍', '👎', '😂', '‼️', '❓', '👀', '✅', '🙌'];

/** Reactions one card keeps: one per bot, at most this many bots. */
export const REACTIONS_PER_CARD_MAX = 16;

/**
 * Round caps. 8 lines lets every bot of a three- or four-bot group answer
 * and follow up once; 2 per bot is an answer and one follow-up; 4 waves is
 * ask → answer → follow-up → close. All sit below the handoff caps
 * (HANDOFF_LIMITS MAX_DEPTH 6, MAX_PER_RUN 32), which still hold.
 */
export const GROUP_ROUND_LIMITS = { LINES: 8, LINES_PER_BOT: 2, MENTION_WAVES: 4 } as const;

/** One bot's reaction on a card. `ack`: main left it for a bot that stayed
 *  silent (not the bot's own pick). */
export interface CardReaction {
  botId: string;
  emoji: string;
  ack?: true;
}

/** The acknowledgement a silent bot leaves on a card: stable per bot and
 *  card, so a retried turn leaves the same one. Pure. */
export function silentAckEmoji(botId: string, cardId: string): string {
  const seed = `${botId}:${cardId}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return SILENT_ACK_EMOJI[hash % SILENT_ACK_EMOJI.length];
}

// Any `[[react:…]]` is protocol, whatever it holds; only a palette emoji
// in one is a reaction.
const REACT_MARKER = /\[\[react:([^\]]*)\]\]/gi;
const SILENT_MARKER = /\[\[\s*silent\s*\]\]/gi;

/** Whether a value is one emoji of the palette. Pure. */
export function isReactionEmoji(value: unknown): value is string {
  return typeof value === 'string' && REACTION_EMOJI.includes(value);
}

/**
 * A group turn's closing text split into the reaction it asked for (the
 * first `[[react:…]]` naming a palette emoji) and the words left, with every
 * marker (`[[react:…]]`, `[[silent]]`) removed: protocol never reaches a
 * card. Pure.
 */
export function splitReaction(text: string): { emoji?: string; text: string } {
  let emoji: string | undefined;
  const cleaned = text.replace(REACT_MARKER, (_m, raw: string) => {
    const candidate = String(raw).trim();
    if (!emoji && isReactionEmoji(candidate)) emoji = candidate;
    return '';
  }).replace(SILENT_MARKER, '');
  return { ...(emoji ? { emoji } : {}), text: cleaned.trim() };
}

/** A card's reactions from disk or the wire: well-formed entries of
 *  palette emoji, one per bot, at most REACTIONS_PER_CARD_MAX; undefined for
 *  none. Pure. */
export function sanitizeReactions(raw: unknown, isBotId: (id: string) => boolean): CardReaction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CardReaction[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const { botId, emoji, ack } = r as Record<string, unknown>;
    if (typeof botId !== 'string' || !isBotId(botId) || seen.has(botId) || !isReactionEmoji(emoji)) continue;
    seen.add(botId);
    out.push({ botId, emoji, ...(ack === true ? { ack: true as const } : {}) });
    if (out.length >= REACTIONS_PER_CARD_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}
