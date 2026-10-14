// ─── A bot's avatar ──────────────────────────────────────────────────────────
//
// The owner's picture for the bot (BotProfile.avatar, a small square PNG main
// wrote), or, without one, the bot's own mark: its identity colour and
// shape, picked from the bot id, with a small friendly face (owner decision
// 2026-10-14), so a bot keeps its mark everywhere (DESIGN.md, Bots page:
// Avatars). Identity colours are never state colours, so a mark can never
// read as a status. `botInitials` stays for the places that write a name's
// letters.
//
// Decorative by default (the name is always written beside it); pass `alt`
// where the avatar stands alone.
import type { BotProfile } from '../../../shared/bot';

type T = (key: string, vars?: Record<string, string | number>) => string;

const AVATAR_PREFIX = 'data:image/png;base64,';

/** Hangul syllables and jamo, CJK ideographs, kana: one character reads as
 *  the initial. */
const SYLLABIC_RE = /^[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]/u;

/** The tile's letters for a name (1–2), or for `fallback` when the name is
 *  blank. */
export function botInitials(name: string, fallback: string): string {
  const source = name.trim() || fallback.trim();
  const words = source.split(/[\s._\-/:@]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0])[0];
  if (SYLLABIC_RE.test(first)) return first;
  const second = words.length > 1 ? Array.from(words[1])[0] : '';
  return (first + (second && !SYLLABIC_RE.test(second) ? second : '')).toLocaleUpperCase();
}

/**
 * Bot identity colours (owner decision 2026-10-14: each bot is told apart by
 * its own colour and shape, as in the reference messenger). An identity
 * colour is never a state colour: no red, orange, yellow or green — the
 * error, needs-you, caution and done meanings keep those. Each hue is mixed
 * toward the look's `--text-main`, so it darkens on a light look and lightens
 * on a dark one and reads on `--bg-base` as a name, and `--bg-base` reads on
 * it as the face.
 */
export const BOT_IDENTITY_HUES = ['#3d6ff5', '#5b5bd6', '#7c4ddb', '#9d3fd1', '#c0359f', '#0b8fb0', '#2a8fd8', '#5a6b8c'] as const;

/** The avatar's shapes (SVG, 24×24 box). */
export const BOT_AVATAR_SHAPES = ['circle', 'square', 'hexagon', 'diamond'] as const;
export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number];

function idHash(botId: string): number {
  let h = 0;
  for (let i = 0; i < botId.length; i++) h = (h * 31 + botId.charCodeAt(i)) >>> 0;
  return h;
}

/** The order a room's bots take the identity colours in: each next colour
 *  far from those before it (teal, violet, magenta, blue, slate, …), never
 *  the palette's neighbour, so a room's first five bots read apart. */
export const IDENTITY_SPREAD = [5, 2, 4, 0, 7, 3, 6, 1] as const;

type IdentityBot = Pick<BotProfile, 'id' | 'createdAt' | 'workspaceId'>;

/** Each bot's colour among `bots`, per room (workspace): oldest first (then
 *  by id), a bot takes the first colour of IDENTITY_SPREAD that the fewest
 *  bots of its room hold (`taken`: colours its room's bots already hold) —
 *  two bots of a room never share one while the palette lasts. Pure. */
export function identityHueIndexes(bots: readonly IdentityBot[], taken: readonly { workspaceId: string; index: number }[] = []): Map<string, number> {
  const n = BOT_IDENTITY_HUES.length;
  const order = [...bots].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Map<string, number[]>();
  const usedIn = (ws: string) => {
    let u = used.get(ws);
    if (!u) { u = new Array<number>(n).fill(0); used.set(ws, u); }
    return u;
  };
  for (const t of taken) usedIn(t.workspaceId)[t.index] += 1;
  const out = new Map<string, number>();
  for (const b of order) {
    if (out.has(b.id)) continue;
    const u = usedIn(b.workspaceId);
    const least = Math.min(...u);
    const pick = IDENTITY_SPREAD.find((i) => u[i] === least) ?? IDENTITY_SPREAD[0];
    u[pick] += 1;
    out.set(b.id, pick);
  }
  return out;
}

// Each listed bot's colour in this window. A bot keeps its colour while it
// exists; a removed bot's colour is free again for the next one added.
const assigned = new Map<string, { index: number; workspaceId: string }>();

/** Records listed bots, so their colours are told apart (useFactoryBots).
 *  `complete`: the list is every bot, so one missing from it was removed. */
export function noteBotIdentities(bots: readonly IdentityBot[], complete = false): void {
  if (complete) {
    const listed = new Set(bots.map((b) => b.id));
    for (const id of [...assigned.keys()]) if (!listed.has(id)) assigned.delete(id);
  }
  const fresh = bots.filter((b) => !assigned.has(b.id));
  if (fresh.length === 0) return;
  for (const [id, index] of identityHueIndexes(fresh, [...assigned.values()])) {
    assigned.set(id, { index, workspaceId: fresh.find((b) => b.id === id)!.workspaceId });
  }
}

function hueIndex(botId: string): number {
  return assigned.get(botId)?.index ?? idHash(botId) % BOT_IDENTITY_HUES.length;
}

/** A bot's identity colour, as CSS (the same bot, the same colour). */
export function botIdentityColor(botId: string): string {
  const hue = BOT_IDENTITY_HUES[hueIndex(botId)];
  return `color-mix(in oklab, ${hue} 72%, var(--text-main))`;
}

/** A bot's avatar shape (the same id, the same shape). */
export function botAvatarShape(botId: string): BotAvatarShape {
  return BOT_AVATAR_SHAPES[Math.floor(idHash(botId) / BOT_IDENTITY_HUES.length) % BOT_AVATAR_SHAPES.length];
}

function ShapePath({ shape }: { shape: BotAvatarShape }) {
  switch (shape) {
    case 'circle': return <circle cx="12" cy="12" r="12" />;
    case 'square': return <rect width="24" height="24" rx="6.5" />;
    case 'hexagon': return <path d="M12 .6c.5 0 1 .1 1.4.4l8.2 4.7c.9.5 1.4 1.4 1.4 2.4v7.8c0 1-.5 1.9-1.4 2.4L13.4 23c-.9.5-1.9.5-2.8 0l-8.2-4.7C1.5 17.8 1 16.9 1 15.9V8.1c0-1 .5-1.9 1.4-2.4L10.6 1c.4-.3.9-.4 1.4-.4z" />;
    case 'diamond': return <rect x="3.5" y="3.5" width="17" height="17" rx="5" transform="rotate(45 12 12)" />;
  }
}

export interface BotAvatarProps {
  bot: Pick<BotProfile, 'id' | 'name' | 'role' | 'avatar'>;
  /** Edge in px. */
  size: number;
  className?: string;
  /** The accessible name when the avatar stands alone (default: hidden). */
  alt?: string;
  /** Kept for callers that pass a translator; the mark has no words. */
  t?: T;
  /** A bot not made yet (the add form): its colour and shape come from the
   *  id main gives it, so the face shows in a neutral circle. */
  placeholder?: boolean;
}

export default function BotAvatar({ bot, size, className, alt, placeholder = false }: BotAvatarProps): React.ReactElement {
  const radius = Math.max(3, Math.round(size * 0.22));
  const a11y = alt ? { role: 'img', 'aria-label': alt } : { 'aria-hidden': true as const };
  const box = { width: size, height: size, borderRadius: radius };
  if (typeof bot.avatar === 'string' && bot.avatar.startsWith(AVATAR_PREFIX)) {
    return (
      <span {...a11y} data-bot-avatar="image" className={`inline-block shrink-0 overflow-hidden ${className ?? ''}`} style={box}>
        <img src={bot.avatar} alt="" draggable={false} width={size} height={size} className="block w-full h-full object-cover" />
      </span>
    );
  }
  // No picture: the bot's own colour and shape with a small friendly face.
  const shape = placeholder ? 'circle' : botAvatarShape(bot.id);
  return (
    <span
      {...a11y}
      data-bot-avatar={placeholder ? 'placeholder' : 'face'}
      data-avatar-shape={shape}
      className={`inline-flex shrink-0 ${className ?? ''}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <g style={{ fill: placeholder ? 'var(--text-muted)' : botIdentityColor(bot.id) }}><ShapePath shape={shape} /></g>
        <g style={{ fill: 'var(--bg-base)', stroke: 'var(--bg-base)' }}>
          <circle cx="9" cy="10.5" r="1.5" stroke="none" />
          <circle cx="15" cy="10.5" r="1.5" stroke="none" />
          <path d="M8.6 14.4c1.9 2 4.9 2 6.8 0" fill="none" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      </svg>
    </span>
  );
}
