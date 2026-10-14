// ─── A room's avatar for the Bots page ───────────────────────────────────────
//
// A room (group conversation) stacks two of its bots' avatars (the shared
// BotAvatar) and "+N" for the rest; a room with no bot shows a plain mark.
// `layout="row"` overlaps up to three side by side instead (the chat's
// centred room pill).
import BotAvatar from '../Room/BotAvatar';
import { IconHash } from '../icons';
import type { FactoryBotRow } from '../Room/factoryPorts';

export function RoomAvatar({ bots, size, layout = 'stack' }: { bots: readonly FactoryBotRow[]; size: number; layout?: 'stack' | 'row' }): React.ReactElement {
  if (bots.length === 0) {
    return (
      <span data-avatar-room="empty" className="inline-flex shrink-0 items-center justify-center rounded-[6px] bg-[var(--selection)] text-[var(--text-sub)]" style={{ width: size, height: size }}>
        <IconHash size={Math.round(size * 0.45)} />
      </span>
    );
  }
  if (layout === 'row') {
    const shown = bots.slice(0, 3);
    return (
      <span data-avatar-room={bots.length} data-avatar-layout="row" aria-hidden="true" className="inline-flex shrink-0 items-center">
        {shown.map((row, i) => (
          <span key={row.bot.id} className="inline-flex rounded-full bg-[var(--bg-base)] p-[1.5px]" style={i > 0 ? { marginLeft: -Math.round(size * 0.35) } : undefined}>
            <BotAvatar bot={row.bot} size={size} />
          </span>
        ))}
      </span>
    );
  }
  // Too small to stack: the room's first bot.
  if (size < 28) return <BotAvatar bot={bots[0].bot} size={size} />;
  const small = Math.round(size * 0.62);
  const shown = bots.slice(0, 2);
  const more = bots.length - shown.length;
  return (
    <span data-avatar-room={bots.length} aria-hidden="true" className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      {shown.map((row, i) => (
        <span
          key={row.bot.id}
          className="absolute inline-flex rounded-[6px] bg-[var(--bg-mantle)] p-[1.5px]"
          style={i === 0 ? { left: 0, top: 0 } : { right: 0, bottom: 0 }}
        >
          <BotAvatar bot={row.bot} size={small - 3} />
        </span>
      ))}
      {more > 0 && (
        <span className="absolute right-0 top-0 text-[10px] font-medium leading-none tabular-nums text-[var(--text-sub)]">+{more}</span>
      )}
    </span>
  );
}
