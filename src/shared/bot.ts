// ─── Bots — long-lived role sessions bound to one workspace ────────────────
//
// A bot is one agent session bound to one workspace and one role. Its powers
// are its role surface (shared/botSurface.ts); it never holds a shell. Its
// identity on the pipe is a main-minted token bound to a BotBinding
// (main/deck/commanderTrust.ts `mintBotToken`), carried in the existing
// `commanderToken` envelope field; RpcRouter resolves it onto
// `RpcContext.bot`.
//
// The bundled MCP server runs a bot's tools in bot mode: `--bot=<role>` plus
// `--bot-token-file=<path>` (the token is handed over in a file main writes
// for that one spawn, not in the environment — see
// main/factory/botTokenHandoff.ts and src/mcp/botTokenHandoff.ts).

import type { FactFilter, FactKind } from './facts';

export type BotRole = 'lead' | 'triage' | 'verifier' | 'maintainer' | 'moa';
// 'merge' is NOT a bot: it is the lane + executor (model-free).

export const BOT_ROLES: readonly BotRole[] = ['lead', 'triage', 'verifier', 'maintainer', 'moa'];

export function isBotRole(value: unknown): value is BotRole {
  return typeof value === 'string' && (BOT_ROLES as readonly string[]).includes(value);
}

/** The agent behind a bot. v1 default is `claude-sdk`; `claude-pty` stays as a
 *  billing hedge; `acp` runs any ACP command and is opt-in. */
export type BotEngine =
  | { kind: 'claude-sdk'; model?: string; effort?: string }
  | { kind: 'claude-pty'; model?: string }
  | { kind: 'acp'; command: string; args: string[] };

export const DEFAULT_BOT_ENGINE: BotEngine = { kind: 'claude-sdk' };

export interface BotBudget {
  maxTurnsPerHour: number;
  maxTurnsPerDay: number;
  maxConcurrentWorkers: number;
  maxWorkerHoursPerDay: number;
  turnTimeoutMs: number;
}

/** Default budget per role. */
export const DEFAULT_BOT_BUDGETS: Readonly<Record<BotRole, BotBudget>> = {
  lead:       { maxTurnsPerHour: 6,  maxTurnsPerDay: 40, maxConcurrentWorkers: 3, maxWorkerHoursPerDay: 6, turnTimeoutMs: 600_000 },
  triage:     { maxTurnsPerHour: 6,  maxTurnsPerDay: 40, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 4, turnTimeoutMs: 600_000 },
  verifier:   { maxTurnsPerHour: 12, maxTurnsPerDay: 80, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 6, turnTimeoutMs: 600_000 },
  maintainer: { maxTurnsPerHour: 2,  maxTurnsPerDay: 4,  maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 600_000 },
  moa:        { maxTurnsPerHour: 12, maxTurnsPerDay: 60, maxConcurrentWorkers: 0, maxWorkerHoursPerDay: 0, turnTimeoutMs: 600_000 },
};

export interface BotTrigger {
  kind: FactKind;
  filter?: FactFilter;
  /** Coalesce up to `max` matching facts within `windowMs` into one wake. */
  batch?: { windowMs: number; max: number };
}

export interface BotProfile {
  version: 1;
  /** 'bot-' + 8 hex, stable across restarts. */
  id: string;
  workspaceId: string;
  role: BotRole;
  /** Display name, e.g. "Verifier". */
  name: string;
  engine: BotEngine;
  triggers: BotTrigger[];
  budget: BotBudget;
  /** The repo the bot acts on (fan-out needs it: a bot has no pane cwd). */
  repo?: { repoKey: string; repoPath: string };
  enabled: boolean;
  parked?: { reason: 'budget' | 'error' | 'human'; at: number };
  createdAt: number;
  updatedAt: number;
}

export const BOT_ID_RE = /^bot-[0-9a-f]{8}$/;

/** What a bot token resolves to. */
export interface BotBinding { workspaceId: string; botId: string; role: BotRole; }

const BINDING_WORKSPACE_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** A well-formed binding (non-empty workspace, bot id shape, known role). */
export function isBotBinding(value: unknown): value is BotBinding {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return typeof b.workspaceId === 'string'
    && BINDING_WORKSPACE_RE.test(b.workspaceId)
    && typeof b.botId === 'string'
    && BOT_ID_RE.test(b.botId)
    && isBotRole(b.role);
}

export type BotPresence = 'running' | 'idle' | 'parked' | 'stopped' | 'unknown';
// 'unknown' = the profile exists but the runtime has not restored or pinged
// the session yet. unknown ≠ offline: the queue keeps accepting wakes.

export interface BotStatus {
  botId: string;
  presence: BotPresence;
  sessionId?: string;
  currentTurn?: { wakeId: string; startedAt: number };
  queueDepth: number;
  budgetLeft: { turnsHour: number; turnsDay: number; workerHoursDay: number };
  lastError?: { message: string; at: number };
}

export const BOT_RPC = {
  list: 'bot.list', create: 'bot.create', update: 'bot.update', remove: 'bot.remove',
  status: 'bot.status', wake: 'bot.wake', park: 'bot.park', resume: 'bot.resume', interrupt: 'bot.interrupt',
} as const;

/** main → renderer push: {type:'bot.status', status} | {type:'bots-changed'}. */
export const BOT_EVENT = 'bot.event';

// ── MCP bot mode (argv) ─────────────────────────────────────────────────────

/** `--bot=<role>`: the bundled MCP server registers exactly that role's tools
 *  and claims the bot role on every RPC. An argv flag, never an env var. */
export const BOT_MODE_ARG_PREFIX = '--bot=';
/** `--bot-token-file=<path>`: where the bot token is read from (once). */
export const BOT_TOKEN_FILE_ARG_PREFIX = '--bot-token-file=';

function lastArg(argv: readonly string[], prefix: string): string | undefined {
  const hit = [...argv].reverse().find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

/** The raw `--bot=` value (last one wins), or undefined. Unvalidated, so the
 *  server can report an unknown role itself. */
export function botArgValue(argv: readonly string[]): string | undefined {
  return lastArg(argv, BOT_MODE_ARG_PREFIX);
}

/** The `--bot-token-file=` path (last one wins), or undefined. */
export function botTokenFileArgValue(argv: readonly string[]): string | undefined {
  return lastArg(argv, BOT_TOKEN_FILE_ARG_PREFIX);
}

/** The MCP server args (after the bundle path) for one bot spawn. */
export function botMcpArgs(role: BotRole, tokenFile: string): string[] {
  return [`${BOT_MODE_ARG_PREFIX}${role}`, `${BOT_TOKEN_FILE_ARG_PREFIX}${tokenFile}`];
}
