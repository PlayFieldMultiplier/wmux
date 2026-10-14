// ─── Factory settings — the shape of `<wmuxDir>/factory/settings.json` ─────
//
// Shared so the renderer (the Factory settings tab) reads the same type main
// writes. Main sanitises every field on read and on update
// (main/factory/factorySettings.ts); this file holds the shape and defaults
// only.

import { DEFAULT_BOT_ENGINE, type BotEngine } from './bot';
import { WAKE_LIMITS } from './wake';

export const FACTORY_SETTINGS_VERSION = 1 as const;

export interface FactorySettings {
  version: typeof FACTORY_SETTINGS_VERSION;
  enabled: boolean;
  /** Moa's HQ workspace from older builds. Kept readable for compatibility;
   *  nothing uses it (no workspace is special, owner decision 2026-10-14). */
  hqWorkspaceId: string | null;
  /** GitHub logins whose PRs wake the Verifier (the owner's login included). */
  trustedAuthors: string[];
  /** Local hour (0-23) and weekdays (0 = Sunday … 6) of the morning wake. */
  morning: { hour: number; weekdays: number[] };
  verifierOnOwnerPrs: boolean;
  defaultEngine: BotEngine;
  /** Bots running a turn at the same time, factory-wide (1-5). */
  globalConcurrentBots: number;
  /** Agents running at once, bots and workers together (2-16): a bot turn,
   *  an open fan-out task's worker, a resumed worker. A bot's new worker past
   *  it waits for a slot (main/factory/agentSlots.ts); the owner's own work
   *  never waits. */
  maxConcurrentAgents: number;
  /** The merge lane merges a bot PR by itself once every predicate passes.
   *  Off: the lane posts a ready-to-merge card and the owner merges. */
  laneAutoMerge: boolean;
  /** Most lane merges per local day (0-50). */
  laneDailyCap: number;
  /** Isolated-instance smoke only: every bot runs on the scripted ACP stub. */
  acpStub?: boolean;
  /** The bot the phone talks to (`/api/moa/messages`), pinned in Settings ›
   *  Bots. Absent: the oldest enabled Coordinator-template bot, else the
   *  oldest enabled bot (main/factory/phoneBot.ts). */
  phoneBotId?: string;
}

export const FACTORY_CONCURRENT_BOTS_MIN = 1;
export const FACTORY_CONCURRENT_BOTS_MAX = 5;
export const FACTORY_LANE_DAILY_CAP_MAX = 50;
export const FACTORY_MAX_AGENTS_MIN = 2;
export const FACTORY_MAX_AGENTS_MAX = 16;
/** Three bots in a turn and three live workers: the default bot and worker
 *  caps side by side (about 2.3 GiB of agent and MCP memory measured on
 *  macOS arm64, bench/bot-memory.md). */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 6;

export const DEFAULT_FACTORY_SETTINGS: Readonly<FactorySettings> = Object.freeze({
  version: FACTORY_SETTINGS_VERSION,
  enabled: false,
  hqWorkspaceId: null,
  trustedAuthors: [],
  morning: { hour: 9, weekdays: [1, 2, 3, 4, 5] },
  verifierOnOwnerPrs: true,
  defaultEngine: DEFAULT_BOT_ENGINE,
  globalConcurrentBots: WAKE_LIMITS.GLOBAL_CONCURRENT_BOTS,
  maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
  laneAutoMerge: false,
  laneDailyCap: 5,
});
