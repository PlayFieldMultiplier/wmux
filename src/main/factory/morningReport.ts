// ─── Morning report — what Moa's one scheduled wake carries ────────────────
//
// The factory's only timer is the morning schedule (DeckScheduler,
// deck-schedules.json). When it fires, `fireMorningReport` assembles the
// day's data and appends it as the payload of one `schedule.fired` fact for
// the HQ bot's workspace; Moa's default trigger wakes it on that fact, and
// the wake prompt shows the payload, so Moa starts from the data instead of
// collecting it turn by turn. Moa then posts one report card and one plan.
//
// The data (bounded so the fact stays ≤ FACT_LIMITS.PAYLOAD_MAX_BYTES; Moa
// reads detail with its own tools):
//   trust      per watched repository (≤ 3): the trust-metrics totals of the
//              last 30 days (main/factory/trustMetrics.ts); each read is also
//              appended to factory/trust-snapshots.jsonl for later trends;
//   merged     merge.done facts of the last 24 h;
//   blocked    merge.refused (with reasons) and task.failed facts of the last
//              24 h, and the bots that ran out of budget;
//   rooms      per workspace with bots: open threads, open questions, and the
//              newest open thread titles;
//   gardener   human.correction patterns that reached the threshold.
//
// The roles module (./roles/index.ts) also routes the owner's answer to a
// plan card back to the bot that proposed it (`routePlanAnswer`): an
// approval or an edit wakes it in the plan's thread to dispatch; a decline
// is recorded and wakes nobody.

import fs from 'node:fs';
import path from 'node:path';
import { isCoordinatorBot, type BotProfile } from '../../shared/bot';
import { FACT_LIMITS, type Fact, type FactDraft } from '../../shared/facts';
import { GENERAL_THREAD, isGuestSourcedCard, type RoomCard, type ThreadId } from '../../shared/room';
import type { WakeReason } from '../../shared/wake';
import type { FactLog, FactLogApi } from './factLog';
import type { BotDirectoryApi } from './botStore';
import type { RoomWriter } from './roomWriter';
import { DAY_MS, type TrustReadResult } from './trustMetrics';
import type { CorrectionGroup } from './gardener';
import { crossesGuestBoundary } from './guestWorkspaces';

export const MORNING_LIMITS = {
  WINDOW_MS: DAY_MS,
  TRUST_DAYS: 30,
  TRUST_REPOS: 3,
  MERGED: 15,
  BLOCKED: 10,
  WORKSPACES: 10,
  THREAD_TITLES: 3,
  CORRECTION_GROUPS: 5,
  /** Fact log pages read for one report (×200 facts). */
  FACT_PAGES: 100,
} as const;

export const TRUST_SNAPSHOTS_FILENAME = 'trust-snapshots.jsonl';

export interface MorningTrust {
  repoKey: string;
  totals?: TrustReadResultTotals;
  error?: string;
}
type TrustReadResultTotals = Extract<TrustReadResult, { ok: true }>['analysis']['totals'];

export interface MorningData {
  at: number;
  windowHours: number;
  trust: MorningTrust[];
  merged: Array<{ repoKey?: string; pr?: number; workspaceId?: string }>;
  mergedCount: number;
  blocked: Array<{ kind: 'merge.refused' | 'task.failed'; repoKey?: string; pr?: number; taskId?: string; reasons?: string[]; workspaceId?: string }>;
  blockedCount: number;
  budgetExhausted: string[];
  rooms: Array<{ workspaceId: string; openThreads: number; openQuestions: number; newest: Array<{ threadId: string; title: string }> }>;
  gardener: Array<{ key: string; count: number; factIds: string[] }>;
}

export interface MorningPorts {
  factLog: () => FactLogApi | null;
  bots: () => BotDirectoryApi | null;
  rooms: () => RoomWriter | null;
  /** The trust metrics of a repository checkout over [since, now]. */
  trust: (repoPath: string, since: number, now: number) => Promise<TrustReadResult>;
  /** The GitHub key of a checkout (`host/owner/repo`), or null. */
  repoKeyOf: (repoPath: string) => Promise<string | null>;
  /** Correction patterns at the threshold (the gardener), when running. */
  corrections?: () => CorrectionGroup[];
  /** `<wmuxDir>/factory`; absent = no trust snapshot is written. */
  factoryDir?: string;
  now?: () => number;
}

function enabled(bots: BotDirectoryApi | null): BotProfile[] {
  try {
    return bots?.listEnabled() ?? [];
  } catch {
    return [];
  }
}

/** The bot the morning report is for: the oldest enabled Coordinator
 *  (template, never the role tag), or null when there is none. */
export function hqBot(bots: BotDirectoryApi | null): BotProfile | null {
  return enabled(bots).filter((b) => isCoordinatorBot(b)).sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
}

/** The facts at or after `since`, oldest first. The fact log's own
 *  in-memory scan when it has one (the whole retained window); else paged
 *  reads, bounded by FACT_PAGES. */
export function factsSince(log: FactLogApi, since: number): Fact[] {
  const scan = (log as Partial<Pick<FactLog, 'readWhere'>>).readWhere;
  if (typeof scan === 'function') {
    return scan.call(log, 0, (f: Fact) => f.at >= since, Number.MAX_SAFE_INTEGER).facts;
  }
  const out: Fact[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MORNING_LIMITS.FACT_PAGES; page++) {
    const r = log.readSince(cursor, undefined, FACT_LIMITS.POLL_PAGE);
    for (const f of r.facts) if (f.at >= since) out.push(f);
    if (r.facts.length < FACT_LIMITS.POLL_PAGE || r.cursor === cursor) break;
    cursor = r.cursor;
  }
  return out;
}

function strings(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 60)).slice(0, max) : [];
}

/** Assemble the morning data. Never throws: a source that fails is left out. */
export async function buildMorningData(ports: MorningPorts): Promise<MorningData> {
  const now = (ports.now ?? Date.now)();
  const since = now - MORNING_LIMITS.WINDOW_MS;
  const bots = ports.bots();
  const all = enabled(bots);
  const L = MORNING_LIMITS;

  // Trust per distinct repository (oldest bot first).
  const repos = new Map<string, string>();
  for (const b of [...all].sort((x, y) => x.createdAt - y.createdAt)) {
    const p = b.repo?.repoPath;
    if (p && !repos.has(p)) repos.set(p, b.repo?.repoKey ?? p);
  }
  const trust: MorningTrust[] = [];
  for (const [repoPath, fallbackKey] of [...repos].slice(0, L.TRUST_REPOS)) {
    const repoKey = (await ports.repoKeyOf(repoPath).catch(() => null)) ?? fallbackKey;
    try {
      const r = await ports.trust(repoPath, now - L.TRUST_DAYS * DAY_MS, now);
      trust.push(r.ok ? { repoKey, totals: r.analysis.totals } : { repoKey, error: r.message.slice(0, 160) });
    } catch (err) {
      trust.push({ repoKey, error: String(err).slice(0, 160) });
    }
  }
  if (ports.factoryDir) {
    const lines = trust.filter((t) => t.totals).map((t) => JSON.stringify({ at: now, repoKey: t.repoKey, totals: t.totals }));
    if (lines.length > 0) {
      try {
        fs.mkdirSync(ports.factoryDir, { recursive: true });
        fs.appendFileSync(path.join(ports.factoryDir, TRUST_SNAPSHOTS_FILENAME), `${lines.join('\n')}\n`);
      } catch {
        /* a snapshot is a convenience; the report goes out without it */
      }
    }
  }

  // Facts of the window.
  let facts: Fact[] = [];
  try {
    const log = ports.factLog();
    facts = log ? factsSince(log, since) : [];
  } catch {
    facts = [];
  }
  const mergedFacts = facts.filter((f) => f.kind === 'merge.done');
  const blockedFacts = facts.filter((f) => f.kind === 'merge.refused' || f.kind === 'task.failed');
  const budget = new Set<string>();
  for (const f of facts) if (f.kind === 'bot.budget_exhausted' && f.ref?.botId) budget.add(f.ref.botId);

  // Rooms of the workspaces that have bots.
  const writer = ports.rooms();
  const workspaces = [...new Set(all.map((b) => b.workspaceId))].slice(0, L.WORKSPACES);
  const rooms: MorningData['rooms'] = [];
  for (const ws of workspaces) {
    try {
      const threads = writer?.threads(ws) ?? [];
      const open = threads.filter((t) => t.status === 'open' && t.threadId !== GENERAL_THREAD);
      rooms.push({
        workspaceId: ws,
        openThreads: open.length,
        openQuestions: threads.reduce((n, t) => n + t.openQuestions, 0),
        newest: [...open].sort((a, b) => b.lastSeq - a.lastSeq).slice(0, L.THREAD_TITLES)
          .map((t) => ({ threadId: t.threadId, title: t.title.slice(0, 80) })),
      });
    } catch {
      /* a room that cannot be read is left out */
    }
  }

  let gardener: MorningData['gardener'] = [];
  try {
    gardener = (ports.corrections?.() ?? []).slice(0, L.CORRECTION_GROUPS)
      .map((g) => ({ key: g.key, count: g.factIds.length, factIds: g.factIds.slice(0, 5) }));
  } catch {
    gardener = [];
  }

  return {
    at: now,
    windowHours: L.WINDOW_MS / 3_600_000,
    trust,
    merged: mergedFacts.slice(-L.MERGED).map((f) => ({
      ...(f.repoKey ? { repoKey: f.repoKey } : {}), ...(f.ref?.pr ? { pr: f.ref.pr } : {}), ...(f.workspaceId ? { workspaceId: f.workspaceId } : {}),
    })),
    mergedCount: mergedFacts.length,
    blocked: blockedFacts.slice(-L.BLOCKED).map((f) => ({
      kind: f.kind as 'merge.refused' | 'task.failed',
      ...(f.repoKey ? { repoKey: f.repoKey } : {}),
      ...(f.ref?.pr ? { pr: f.ref.pr } : {}),
      ...(f.ref?.taskId ? { taskId: f.ref.taskId } : {}),
      ...(f.workspaceId ? { workspaceId: f.workspaceId } : {}),
      ...(f.kind === 'merge.refused' ? { reasons: strings(f.payload.reasons, 5) } : {}),
    })),
    blockedCount: blockedFacts.length,
    budgetExhausted: [...budget].slice(0, L.BLOCKED),
    rooms,
    gardener,
  };
}

function byteLength(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

/** The data cut down until `{morning: data}` fits a fact payload: the longest
 *  lists shrink first, counts stay. */
export function boundMorningPayload(data: MorningData, max: number = FACT_LIMITS.PAYLOAD_MAX_BYTES): { morning: MorningData; trimmed: boolean } {
  const d: MorningData = JSON.parse(JSON.stringify(data)) as MorningData;
  let trimmed = false;
  const lists: Array<keyof Pick<MorningData, 'merged' | 'blocked' | 'rooms' | 'gardener' | 'budgetExhausted' | 'trust'>> = ['merged', 'blocked', 'rooms', 'gardener', 'budgetExhausted', 'trust'];
  for (const r of d.rooms) {
    if (byteLength({ morning: d }) <= max) break;
    if (r.newest.length > 0) {
      r.newest = [];
      trimmed = true;
    }
  }
  while (byteLength({ morning: d }) > max) {
    const longest = lists.filter((k) => (d[k] as unknown[]).length > 0)
      .sort((a, b) => byteLength(d[b]) - byteLength(d[a]))[0];
    if (!longest) break;
    (d[longest] as unknown[]).shift();
    trimmed = true;
  }
  return { morning: d, trimmed };
}

/** What firing the morning schedule did. */
export type MorningFireResult =
  | { ok: true; fact: Fact; hqBotId: string }
  | { ok: false; code: 'no_hq_bot' | 'no_fact_log' | 'duplicate'; message: string };

/**
 * The morning schedule fired: build the data and append it as the HQ
 * workspace's `schedule.fired` fact (deduplicated per schedule per day).
 * The port the DeckScheduler wiring calls.
 */
export async function fireMorningReport(scheduleId: string, ports: MorningPorts): Promise<MorningFireResult> {
  const hq = hqBot(ports.bots());
  if (!hq) return { ok: false, code: 'no_hq_bot', message: 'no HQ (moa) bot is enabled' };
  const log = ports.factLog();
  if (!log) return { ok: false, code: 'no_fact_log', message: 'the fact log is not running' };
  const data = await buildMorningData(ports);
  // Room for the `trimmed` flag next to the data.
  const { morning, trimmed } = boundMorningPayload(data, FACT_LIMITS.PAYLOAD_MAX_BYTES - 32);
  const draft: FactDraft<'schedule.fired'> = {
    kind: 'schedule.fired',
    at: data.at,
    workspaceId: hq.workspaceId,
    ref: { scheduleId, botId: hq.id },
    actor: { kind: 'system' },
    payload: { morning, ...(trimmed ? { trimmed: true } : {}) },
  };
  const fact = log.append(draft);
  if (!fact) return { ok: false, code: 'duplicate', message: 'this morning\'s report fact was already written' };
  return { ok: true, fact, hqBotId: hq.id };
}

// ── The owner's answer to a plan ───────────────────────────────────────────

export type ResolutionKind = 'approve' | 'decline' | 'edit';

/** What the owner's resolution text says: an approval ("approve", "yes",
 *  "ok", "lgtm", optionally followed by item numbers), a decline ("decline",
 *  "no", "reject"), or anything else, which is an edit for the author to act
 *  on. Shared with the gardener and the room UI. */
export function parseResolution(text: string): ResolutionKind {
  const t = text.trim().toLowerCase();
  if (/^(approve|approved|yes|ok|okay|lgtm|go)\b/.test(t)) return 'approve';
  if (/^(decline|declined|no|reject|rejected|dismiss)\b/.test(t)) return 'decline';
  return 'edit';
}

export interface ResolvedCardEvent { workspaceId: string; card: RoomCard; resolution: string }

export interface PlanAnswerPorts {
  bots: () => BotDirectoryApi | null;
  wake: (input: { botId: string; workspaceId: string; reason: WakeReason; priority: 0; threadId: ThreadId }) => unknown;
}

/**
 * A plan card the owner resolved: approve or edit wakes the bot that posted
 * it (Moa) in the plan's thread with the owner's answer; decline wakes
 * nobody. Returns what it did.
 */
export function routePlanAnswer(ev: ResolvedCardEvent, ports: PlanAnswerPorts): 'woken' | 'declined' | 'ignored' {
  const card = ev.card;
  if (card.kind !== 'plan' || card.actor.kind !== 'bot') return 'ignored';
  // Its title would wake the bot as the owner's words: a plan not known
  // clean of a guest's words wakes nobody.
  if (isGuestSourcedCard(card)) return 'ignored';
  const kind = parseResolution(ev.resolution);
  if (kind === 'decline') return 'declined';
  let author: BotProfile | null = null;
  try {
    author = ports.bots()?.get(card.actor.botId) ?? null;
  } catch {
    author = null;
  }
  // Any bot may propose a plan (plan.propose); the answer wakes its author,
  // in the room it wrote the plan in.
  if (!author || !author.enabled || crossesGuestBoundary(ev.workspaceId, author.workspaceId)) return 'ignored';
  const verb = kind === 'approve' ? 'approved' : 'answered';
  ports.wake({
    botId: author.id,
    workspaceId: author.workspaceId,
    priority: 0,
    threadId: card.threadId,
    reason: {
      kind: 'human',
      source: 'desktop',
      text: `I ${verb} your plan "${card.title}" (card ${card.id}): ${ev.resolution.trim()}`,
    },
  });
  return 'woken';
}
