// ─── A bot's avatar ──────────────────────────────────────────────────────────
//
// The owner's picture for the bot (BotProfile.avatar, a small square PNG main
// wrote), or, without one, a rounded-square tile with the name's initials:
// two words give two letters, one word its first letter, and a name that
// starts with a Hangul, CJK or kana character its first character. A blank
// name falls back to the role's label.
//
// The tile's colour is a theme token picked from the bot id, so a bot keeps
// its tile everywhere (DESIGN.md, Bots page: Avatars). The state colours
// (error red, caution yellow, the attention orange) are never used, so a
// tile can never read as a status.
//
// Decorative by default (the name is always written beside it); pass `alt`
// where the avatar stands alone.
import type { BotProfile } from '../../../shared/bot';
import { useT } from '../../hooks/useT';
import { roleLabel } from './roomFormat';

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

/** The theme tokens a tile is drawn on (the letters are --bg-base). */
export const BOT_AVATAR_TONES = ['--accent', '--accent-blue', '--accent-green', '--text-sub'] as const;

/** The tile's colour token for a bot id (the same id, the same tone). */
export function botAvatarTone(botId: string): (typeof BOT_AVATAR_TONES)[number] {
  let h = 0;
  for (let i = 0; i < botId.length; i++) h = (h * 31 + botId.charCodeAt(i)) >>> 0;
  return BOT_AVATAR_TONES[h % BOT_AVATAR_TONES.length];
}

export interface BotAvatarProps {
  bot: Pick<BotProfile, 'id' | 'name' | 'role' | 'avatar'>;
  /** Edge in px. */
  size: number;
  className?: string;
  /** The accessible name when the avatar stands alone (default: hidden). */
  alt?: string;
  /** Tests: the translator for the role fallback. */
  t?: T;
}

export default function BotAvatar({ bot, size, className, alt, t: tProp }: BotAvatarProps): React.ReactElement {
  const ownT = useT();
  const t = tProp ?? ownT;
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
  const letters = botInitials(bot.name, roleLabel(bot.role, t));
  const fontSize = Math.max(8, Math.round(size * (Array.from(letters).length > 1 ? 0.42 : 0.5)));
  return (
    <span
      {...a11y}
      data-bot-avatar="initials"
      data-avatar-tone={botAvatarTone(bot.id)}
      className={`inline-flex shrink-0 items-center justify-center select-none font-semibold text-[var(--bg-base)] ${className ?? ''}`}
      style={{ ...box, background: `var(${botAvatarTone(bot.id)})`, fontSize, lineHeight: 1 }}
    >
      {letters}
    </span>
  );
}
