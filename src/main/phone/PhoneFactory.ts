// The agent factory for the phone: main's side of the factory fields in the
// sidebar snapshot and of the two read-only room commands.
//
// Main owns every store involved (bots, their runtime status, the factory
// settings, rooms, handoffs), so the factory fields are folded into the
// snapshot here (PhoneWorkspaces.takeSidebar) rather than computed in the
// renderer and sent back. The rule itself is pure (shared/phoneFactory.ts);
// this file only reads the stores, through ports a test can replace.
//
// Every reader fails closed: a factory that has not started leaves the
// snapshot as the renderer made it, and the room commands answer
// `{unavailable:true}` (the daemon serves 503).

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import type { BotProfile, BotStatus } from '../../shared/bot';
import type { Handoff } from '../../shared/handoff';
import { parseThreadId, type RoomCard, type ThreadId, type ThreadSummary } from '../../shared/room';
import { applyFactoryToSidebar, delegationsFromHandoffs, type PhoneFactoryState } from '../../shared/phoneFactory';
import {
  PHONE_BOT_PRESENCES,
  PHONE_SIDEBAR_LIMITS,
  type PhoneBotPresence,
  type PhoneSidebarBot,
  type PhoneSidebarSnapshot,
} from '../../shared/phoneFleetSidebar';
import {
  PHONE_ROOM_CARDS_COMMAND,
  PHONE_ROOM_LIMITS,
  PHONE_ROOM_THREADS_COMMAND,
  fitPhoneRoomPage,
  fitPhoneRoomThreads,
  isPhoneRoomWorkspaceId,
  parsePhoneRoomThread,
  phoneRoomCard,
  type PhoneRoomCard,
  type PhoneRoomCardsReply,
  type PhoneRoomThread,
  type PhoneRoomThreadsReply,
} from '../../shared/phoneRooms';
import { getBotStore } from '../factory/botStore';
import { getBotRuntime } from '../factory/BotRuntime';
import { getFactorySettings } from '../factory/factorySettings';
import { getHandoffRouter, HANDOFF_STORE_LIMITS } from '../factory/handoffRouter';
import { getRoomWriter, ROOMS_DIRNAME } from '../factory/roomWriter';
import { phoneBot } from '../factory/phoneBot';

/** The room reads this file needs (RoomWriter). */
export interface PhoneRoomReader {
  read(workspaceId: string, opts: { threadId?: ThreadId; sinceSeq?: number; limit?: number }): { cards: RoomCard[]; nextSinceSeq: number; hasMore: boolean };
  summary(workspaceId: string, threadId: ThreadId): ThreadSummary;
  threads(workspaceId: string): ThreadSummary[];
}

export interface PhoneFactoryPorts {
  settings(): { enabled: boolean; hqWorkspaceId: string | null; phoneBotId?: string };
  /** Every bot profile; null before the factory started. */
  bots(): BotProfile[] | null;
  status(botId: string): BotStatus | null;
  rooms(): PhoneRoomReader | null;
  /** Recent handoffs (newest first); null when the router is not running. */
  handoffs(): Handoff[] | null;
  /** A room file exists on disk for this workspace. */
  roomFileExists(workspaceId: string): boolean;
  /** False when the room file exists but cannot be read: the store would
   *  serve it as empty, so the phone is told the room is unavailable. */
  roomReadable(workspaceId: string): boolean;
  now(): number;
}

function roomFile(workspaceId: string): string {
  return path.join(getWmuxDir(), 'factory', ROOMS_DIRNAME, `${workspaceId}.jsonl`);
}

export function defaultPhoneFactoryPorts(): PhoneFactoryPorts {
  return {
    settings: () => getFactorySettings(),
    bots: () => getBotStore()?.list() ?? null,
    status: (botId) => getBotRuntime()?.status(botId) ?? null,
    rooms: () => getRoomWriter(),
    handoffs: () => getHandoffRouter()?.list({ limit: HANDOFF_STORE_LIMITS.LIST_MAX }) ?? null,
    roomFileExists: (workspaceId) => fs.existsSync(roomFile(workspaceId)),
    roomReadable: (workspaceId) => {
      try {
        fs.accessSync(roomFile(workspaceId), fs.constants.R_OK);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      }
    },
    now: () => Date.now(),
  };
}


function presenceOf(status: BotStatus | null): PhoneBotPresence {
  const p = status?.presence;
  return p && (PHONE_BOT_PRESENCES as readonly string[]).includes(p) ? p : 'unknown';
}

function openQuestionsIn(rooms: PhoneRoomReader, workspaceId: string): number {
  return rooms.threads(workspaceId).reduce((sum, t) => sum + t.openQuestions, 0);
}

/**
 * What the factory contributes to a snapshot listing `workspaceIds`, or null
 * when the factory has not started (the snapshot then stays as it was).
 */
export function phoneFactoryState(ports: PhoneFactoryPorts, workspaceIds: readonly string[]): PhoneFactoryState | null {
  const all = ports.bots();
  if (!all) return null;
  const settings = ports.settings();
  if (!settings.enabled) return { enabled: false, hq: null, bots: new Map(), openQuestions: new Map(), delegations: null };
  // The phone route's addressee (factory/phoneBot.ts), served as the HQ bot.
  const hq = phoneBot(all, settings);
  const hqSession = hq ? ports.status(hq.id)?.sessionId : undefined;
  const listed = new Set(workspaceIds);
  const bots = new Map<string, PhoneSidebarBot[]>();
  for (const bot of [...all].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!listed.has(bot.workspaceId)) continue;
    const row = bots.get(bot.workspaceId) ?? [];
    if (row.length >= PHONE_SIDEBAR_LIMITS.botsPerWorkspace) continue;
    const status = ports.status(bot.id);
    row.push({ id: bot.id, role: bot.role, presence: presenceOf(status), queueDepth: status?.queueDepth ?? 0 });
    bots.set(bot.workspaceId, row);
  }
  const rooms = ports.rooms();
  const openQuestions = new Map<string, number>();
  if (rooms) {
    // Only rooms a bot works in: a room exists where a bot posts.
    for (const ws of bots.keys()) {
      try {
        openQuestions.set(ws, openQuestionsIn(rooms, ws));
      } catch {
        /* this workspace's count is left out */
      }
    }
  }
  let delegations: PhoneFactoryState['delegations'] = null;
  const handoffs = ports.handoffs();
  if (handoffs) {
    const byId = new Map(all.map((b) => [b.id, b]));
    delegations = delegationsFromHandoffs(
      handoffs,
      (botId) => {
        const b = byId.get(botId);
        return b ? { name: b.name } : null;
      },
      (ws, threadId) => {
        const t = parseThreadId(threadId);
        try {
          return !!rooms && !!t && rooms.summary(ws, t).openQuestions > 0;
        } catch {
          return false;
        }
      },
      ports.now(),
    );
  }
  return {
    enabled: true,
    hq: hq ? { botId: hq.id, workspaceId: hq.workspaceId, ...(hqSession ? { sessionId: hqSession } : {}) } : null,
    bots,
    openQuestions,
    delegations,
  };
}

/** The snapshot with the factory folded in; unchanged when it cannot be read. */
export function withPhoneFactory(sidebar: PhoneSidebarSnapshot, ports: PhoneFactoryPorts = defaultPhoneFactoryPorts()): PhoneSidebarSnapshot {
  let state: PhoneFactoryState | null;
  try {
    state = phoneFactoryState(ports, sidebar.workspaces.map((w) => w.id));
  } catch (err) {
    console.warn(`[phone] factory fields left out: ${String(err)}`);
    return sidebar;
  }
  return state ? applyFactoryToSidebar(sidebar, state) : sidebar;
}

// ── Room commands ──────────────────────────────────────────────────────────

type RoomCommandReply =
  | PhoneRoomThreadsReply
  | PhoneRoomCardsReply
  | { unavailable: true }
  | { notFound: true }
  | { invalid: true };

/** A workspace whose room the phone may read: one with a bot, the HQ, or a
 *  room already on disk. Anything else is not found, so a phone cannot make
 *  main load a room for an id that names nothing. */
function roomKnown(ports: PhoneFactoryPorts, workspaceId: string, bots: readonly BotProfile[]): boolean {
  return bots.some((b) => b.workspaceId === workspaceId) ||
    ports.settings().hqWorkspaceId === workspaceId ||
    ports.roomFileExists(workspaceId);
}

function botInfo(bots: readonly BotProfile[]): (botId: string) => { role: BotProfile['role']; name: string } | null {
  const byId = new Map(bots.map((b) => [b.id, b]));
  return (botId) => {
    const b = byId.get(botId);
    return b ? { role: b.role, name: b.name } : null;
  };
}

/** `workspaces.roomThreads` / `workspaces.roomCards`; null for any other command. */
export function handlePhoneRoomCommand(command: string, payload: Record<string, unknown>, ports: PhoneFactoryPorts = defaultPhoneFactoryPorts()): RoomCommandReply | null {
  if (command !== PHONE_ROOM_THREADS_COMMAND && command !== PHONE_ROOM_CARDS_COMMAND) return null;
  const workspaceId = payload.workspaceId;
  if (!isPhoneRoomWorkspaceId(workspaceId)) return { invalid: true };
  const rooms = ports.rooms();
  const bots = ports.bots();
  if (!rooms || !bots) return { unavailable: true };
  if (!roomKnown(ports, workspaceId, bots)) return { notFound: true };

  if (!ports.roomReadable(workspaceId)) return { unavailable: true };

  if (command === PHONE_ROOM_THREADS_COMMAND) {
    const threads: PhoneRoomThread[] = [];
    for (const t of rooms.threads(workspaceId)) {
      const parsed = parsePhoneRoomThread(t);
      if (parsed) threads.push(parsed);
    }
    return fitPhoneRoomThreads({ workspaceId, threads });
  }

  let threadId: ThreadId | null = null;
  if (payload.threadId !== undefined) {
    threadId = parseThreadId(payload.threadId);
    if (!threadId) return { invalid: true };
  }
  const sinceSeq = payload.sinceSeq;
  if (sinceSeq !== undefined && !(typeof sinceSeq === 'number' && Number.isSafeInteger(sinceSeq) && sinceSeq >= 0)) return { invalid: true };
  const limit = payload.limit;
  if (!(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= PHONE_ROOM_LIMITS.pageMax)) return { invalid: true };
  const page = rooms.read(workspaceId, {
    ...(threadId ? { threadId } : {}),
    ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    limit,
  });
  const info = botInfo(bots);
  const cards: PhoneRoomCard[] = [];
  for (const card of page.cards) {
    const projected = phoneRoomCard(card, info);
    if (projected) cards.push(projected);
  }
  return fitPhoneRoomPage({ workspaceId, threadId, cards, nextSinceSeq: page.nextSinceSeq, hasMore: page.hasMore }, sinceSeq !== undefined);
}
