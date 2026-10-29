// What a bot on My Hermes is sent: the owner's own words in its 1:1 only.

import { describe, expect, it } from 'vitest';
import type { RoomCard } from '../../../shared/room';
import type { WakeItem } from '../../../shared/wake';
import { ownHermesPrompt, ownHermesRoomClean, ownHermesWakeRefusal } from '../myHermesTurn';

const BOT = 'bot-0000000a';
const item = (reason: WakeItem['reason'], threadId = `dm:${BOT}`) => ({ id: 'w-1', botId: BOT, workspaceId: 'ws-1', reason, threadId } as unknown as WakeItem);
const human = { kind: 'human' as const, text: 'hi', source: 'desktop' as const };

describe('ownHermesWakeRefusal', () => {
  it('passes only the owner\'s attended message in a clean 1:1', () => {
    expect(ownHermesWakeRefusal({ item: item(human), botId: BOT, attended: true, roomClean: true })).toBeNull();
    expect(ownHermesWakeRefusal({ item: item({ kind: 'schedule', scheduleId: 's-1' }), botId: BOT, attended: true, roomClean: true })).toMatch(/only your own messages/);
    expect(ownHermesWakeRefusal({ item: item({ kind: 'manual', by: 'human' }), botId: BOT, attended: true, roomClean: true })).toMatch(/only your own messages/);
    expect(ownHermesWakeRefusal({ item: item(human, 'general'), botId: BOT, attended: true, roomClean: true })).toMatch(/one to one/);
    expect(ownHermesWakeRefusal({ item: item({ ...human, roomWide: true }), botId: BOT, attended: true, roomClean: true })).toMatch(/one to one/);
    expect(ownHermesWakeRefusal({ item: item(human), botId: BOT, attended: false, roomClean: true })).toMatch(/yours alone/);
    expect(ownHermesWakeRefusal({ item: item(human), botId: BOT, attended: true, roomClean: false })).toMatch(/Another bot or a guest/);
    // An unreadable chat refuses too, saying so rather than blaming a writer.
    expect(ownHermesWakeRefusal({ item: item(human), botId: BOT, attended: true, roomClean: null })).toMatch(/could not read this chat/);
  });

  it('escapes a leading slash only', () => {
    expect(ownHermesPrompt('/tools')).toBe('\\/tools');
    expect(ownHermesPrompt('  /model x')).toBe('  \\/model x');
    expect(ownHermesPrompt('a /b')).toBe('a /b');
  });
});

describe('ownHermesRoomClean', () => {
  const card = (over: Partial<RoomCard>): RoomCard => ({ threadId: `dm:${BOT}`, kind: 'message', actor: { kind: 'human' }, ...over } as RoomCard);
  const writer = (cards: RoomCard[]) => ({ find: (_ws: string, match: (c: RoomCard) => boolean) => [...cards].reverse().find(match) ?? null });

  it('is clean with the owner\'s, its own and wmux\'s cards; never after another bot or a guest wrote there', () => {
    const own = card({ actor: { kind: 'bot', workspaceId: 'ws-1', botId: BOT } });
    expect(ownHermesRoomClean(writer([card({}), own, card({ actor: { kind: 'system' } })]), 'ws-1', BOT)).toBe(true);
    expect(ownHermesRoomClean(writer([card({}), card({ actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-0000000b' } })]), 'ws-1', BOT)).toBe(false);
    expect(ownHermesRoomClean(writer([card({ kind: 'guest' })]), 'ws-1', BOT)).toBe(false);
    expect(ownHermesRoomClean(writer([card({ origin: 'guest' } as Partial<RoomCard>)]), 'ws-1', BOT)).toBe(false);
    // Another thread's cards do not count; an unreadable room refuses.
    expect(ownHermesRoomClean(writer([card({ threadId: 'general', actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-0000000b' } })]), 'ws-1', BOT)).toBe(true);
    expect(ownHermesRoomClean(null, 'ws-1', BOT)).toBeNull();
  });
});
