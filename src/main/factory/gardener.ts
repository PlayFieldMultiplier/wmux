// ─── Gardener — the owner's corrections become guard-rail proposals ────────
//
// A `human.correction` fact records that the owner reverted or overrode a
// bot's output. One correction is a fix; the same correction three times is
// a pattern worth a guard rail (a lint rule, a test, a skill note). The
// gardener groups the corrections of the last GARDENER_WINDOW_MS by their
// pattern key and, the first time a group reaches GARDENER_THRESHOLD, wakes
// the oldest Coordinator-template bot once with that group's facts in a
// thread of its own (`report:gardener-<id>`) — the data for one `proposal`
// card there. A group that was proposed is not proposed again inside
// GARDENER_REPROPOSE_MS.
//
// When the owner resolves a proposal card:
//   - a gardener proposal that is approved goes to a legacy maintainer bot
//     (the group's workspace's, else the Coordinator's workspace's, else the
//     oldest one), else to the Coordinator itself, as an owner wake carrying
//     the proposal as fenced data; a decline or an edit stays with the
//     Coordinator (an edit wakes it to revise);
//   - any other proposal a bot posted that is approved or edited wakes it.
//
// The correction contract (for its producer): kind `human.correction`,
// `ref.botId` = the bot whose output was corrected, `ref.messageId` = the
// override's id, and in `payload` a short `category` slug naming what was
// wrong (e.g. `missing-test`, `scope-creep`), optionally `cardKind` (the
// corrected output's card kind) and `note` (one line). Corrections without a
// category group by the corrected bot's role and card kind.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { isCoordinatorBot, type BotProfile } from '../../shared/bot';
import type { Fact } from '../../shared/facts';
import type { ThreadId } from '../../shared/room';
import type { WakeReason } from '../../shared/wake';
import type { FactLogApi } from './factLog';
import type { BotDirectoryApi } from './botStore';
import { factsSince, hqBot, parseResolution, type ResolvedCardEvent } from './morningReport';
import { fenceData } from './wakePrompt';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const GARDENER_THRESHOLD = 3;
export const GARDENER_WINDOW_MS = 7 * 24 * 3_600_000;
export const GARDENER_REPROPOSE_MS = 30 * 24 * 3_600_000;
export const GARDENER_FILENAME = 'gardener.json';
export const GARDENER_THREAD_PREFIX = 'report:gardener-';
const GROUP_FACT_IDS_MAX = 20;

export interface CorrectionGroup {
  /** The pattern: `<role>:<category>` (or `<role>:<cardKind>`). */
  key: string;
  factIds: string[];
  /** The workspaces of the corrected bots, most frequent first. */
  workspaceIds: string[];
  notes: string[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

function slug(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return SLUG_RE.test(s) ? s : null;
}

/** The pattern key of one correction, or null when it is not one. */
export function correctionKey(f: Fact, bots: BotDirectoryApi | null): string | null {
  if (f.kind !== 'human.correction') return null;
  let bot: BotProfile | null = null;
  try {
    bot = f.ref?.botId ? bots?.get(f.ref.botId) ?? null : null;
  } catch {
    bot = null;
  }
  const role = bot?.role ?? slug(f.payload.botRole) ?? 'unknown';
  const what = slug(f.payload.category) ?? slug(f.payload.cardKind) ?? 'unspecified';
  return `${role}:${what}`;
}

/** The corrections grouped by pattern; only groups of at least `threshold`. Pure. */
export function correctionGroups(facts: readonly Fact[], bots: BotDirectoryApi | null, threshold = GARDENER_THRESHOLD): CorrectionGroup[] {
  const groups = new Map<string, { facts: Fact[]; ws: Map<string, number> }>();
  for (const f of facts) {
    const key = correctionKey(f, bots);
    if (!key) continue;
    const g = groups.get(key) ?? { facts: [], ws: new Map<string, number>() };
    g.facts.push(f);
    let ws = f.workspaceId;
    try {
      ws ??= f.ref?.botId ? bots?.get(f.ref.botId)?.workspaceId : undefined;
    } catch {
      /* no workspace */
    }
    if (ws) g.ws.set(ws, (g.ws.get(ws) ?? 0) + 1);
    groups.set(key, g);
  }
  return [...groups]
    .filter(([, g]) => g.facts.length >= threshold)
    .map(([key, g]) => ({
      key,
      factIds: g.facts.map((f) => f.id).slice(-GROUP_FACT_IDS_MAX),
      workspaceIds: [...g.ws].sort((a, b) => b[1] - a[1]).map(([w]) => w),
      notes: g.facts.map((f) => (typeof f.payload.note === 'string' ? f.payload.note.slice(0, 160) : '')).filter(Boolean).slice(-3),
    }))
    .sort((a, b) => b.factIds.length - a.factIds.length);
}

/** The stable id of a proposal for a pattern (its thread suffix). */
export function proposalId(key: string, at: number): string {
  return `${createHash('sha256').update(key).digest('hex').slice(0, 10)}-${Math.floor(at / 86_400_000).toString(36)}`;
}

interface ProposalRecord { key: string; at: number; factIds: string[]; workspaceIds: string[] }

export interface GardenerPorts {
  factLog: () => FactLogApi | null;
  bots: () => BotDirectoryApi | null;
  /** Enqueue a wake; a falsy result means it was not queued (dropped). */
  wake: (input: { botId: string; workspaceId: string; reason: WakeReason; priority: 0 | 2; threadId: ThreadId }) => unknown;
  /** A system card in a thread (best effort). */
  note?: (workspaceId: string, threadId: ThreadId, title: string, body: string) => void;
  /** Re-open a resolved card, so the owner can answer it again. */
  reopen?: (workspaceId: string, cardId: string) => void;
  /** `<wmuxDir>/factory` */
  factoryDir: string;
  now?: () => number;
  log?: (msg: string) => void;
}

export class Gardener {
  private proposals = new Map<string, ProposalRecord>();
  private persister: FilePersister;
  private readonly file: string;
  private off: (() => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly ports: GardenerPorts) {
    this.file = path.join(ports.factoryDir, GARDENER_FILENAME);
    this.now = ports.now ?? Date.now;
    this.persister = createFilePersister(this.file, () => ({ version: 1, proposals: Object.fromEntries(this.proposals) }));
  }

  /** Whether the saved state loaded; a file of another version or an
   *  unreadable one stops the gardener (it is kept, never overwritten). */
  private loaded = false;

  start(): void {
    try {
      const saved = readVersionedFile(this.file, 1);
      const p = saved?.proposals;
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        for (const [id, r] of Object.entries(p as Record<string, ProposalRecord>)) {
          if (r && typeof r.key === 'string' && typeof r.at === 'number') this.proposals.set(id, r);
        }
      }
    } catch (err) {
      (this.ports.log ?? console.warn)(`[factory] gardener: ${String(err)}; the gardener stays off and the file is kept`);
      return;
    }
    this.loaded = true;
    const log = this.ports.factLog();
    if (!log) return;
    this.off = log.subscribe((f) => {
      if (f.kind === 'human.correction') this.evaluate();
    });
    this.evaluate();
  }

  dispose(): void {
    this.off?.();
    this.off = null;
  }

  /** The correction groups at the threshold right now (the morning data). */
  groups(): CorrectionGroup[] {
    const log = this.ports.factLog();
    if (!log) return [];
    const since = this.now() - GARDENER_WINDOW_MS;
    return correctionGroups(factsSince(log, since).filter((f) => f.kind === 'human.correction'), this.ports.bots());
  }

  private recentlyProposed(key: string): boolean {
    const cutoff = this.now() - GARDENER_REPROPOSE_MS;
    return [...this.proposals.values()].some((r) => r.key === key && r.at >= cutoff);
  }

  /** Wake Moa once for each group that reached the threshold. Returns the
   *  proposal ids it woke Moa for. */
  evaluate(): string[] {
    const hq = hqBot(this.ports.bots());
    if (!hq || !this.loaded) return [];
    const woke: string[] = [];
    for (const g of this.groups()) {
      if (this.recentlyProposed(g.key)) continue;
      const at = this.now();
      const id = proposalId(g.key, at);
      let queued: unknown = null;
      try {
        queued = this.ports.wake({
          botId: hq.id,
          workspaceId: hq.workspaceId,
          priority: 2,
          threadId: `${GARDENER_THREAD_PREFIX}${id}` as ThreadId,
          reason: { kind: 'facts', factIds: g.factIds, trigger: { kind: 'human.correction' } },
        });
      } catch {
        queued = null;
      }
      // Only a wake that was queued counts as proposed: a dropped one is
      // tried again on the next correction.
      if (!queued) continue;
      this.proposals.set(id, { key: g.key, at, factIds: g.factIds, workspaceIds: g.workspaceIds });
      woke.push(id);
    }
    if (woke.length > 0) void this.persister.schedule().catch(() => undefined);
    return woke;
  }

  /** The maintainer a gardener proposal goes to (see the header), or null. */
  maintainerFor(record: ProposalRecord | undefined, hqWorkspaceId: string | null): BotProfile | null {
    let all: BotProfile[] = [];
    try {
      all = (this.ports.bots()?.listEnabled() ?? []).filter((b) => b.role === 'maintainer').sort((a, b) => a.createdAt - b.createdAt);
    } catch {
      all = [];
    }
    for (const ws of [...(record?.workspaceIds ?? []), ...(hqWorkspaceId ? [hqWorkspaceId] : [])]) {
      const m = all.find((b) => b.workspaceId === ws);
      if (m) return m;
    }
    return all[0] ?? null;
  }

  /**
   * A proposal card the owner resolved (onRoomCardResolved). Returns what it
   * did: `maintainer` (approved gardener proposal sent on), `moa` (Moa woken
   * to revise or act), `declined`, `no_maintainer`, or `ignored`.
   */
  onCardResolved(ev: ResolvedCardEvent): 'maintainer' | 'moa' | 'declined' | 'no_maintainer' | 'ignored' {
    const card = ev.card;
    if (card.kind !== 'proposal' || card.actor.kind !== 'bot') return 'ignored';
    const kind = parseResolution(ev.resolution);
    if (kind === 'decline') return 'declined';
    let author: BotProfile | null = null;
    try {
      author = this.ports.bots()?.get(card.actor.botId) ?? null;
    } catch {
      author = null;
    }
    if (!author) return 'ignored';
    const isGardener = card.threadId.startsWith(GARDENER_THREAD_PREFIX);
    // A gardener thread is the Coordinator's; any other bot's proposal answer
    // wakes its author like the Coordinator's does.
    if (isGardener && !isCoordinatorBot(author)) return 'ignored';
    if (isGardener && kind === 'approve') {
      const id = card.threadId.slice(GARDENER_THREAD_PREFIX.length);
      // A legacy maintainer takes it; without one the Coordinator itself
      // does (every bot starts workers).
      const m = this.maintainerFor(this.proposals.get(id), author.workspaceId) ?? (author.enabled ? author : null);
      if (!m) {
        // Open again, so the approval can be given once a maintainer exists.
        try {
          this.ports.reopen?.(ev.workspaceId, card.id);
        } catch {
          /* the note still says what happened */
        }
        this.ports.note?.(ev.workspaceId, card.threadId, 'No bot to take this proposal', 'Switch the proposing bot back on, then approve the proposal again.');
        return 'no_maintainer';
      }
      const proposal = `${card.title}\n\n${card.body ?? ''}`.trim();
      this.ports.wake({
        botId: m.id,
        workspaceId: m.workspaceId,
        priority: 0,
        threadId: card.threadId,
        reason: {
          kind: 'human',
          source: 'desktop',
          text: [
            `I approved this gardener proposal from ${author.name} (card ${card.id} in ${ev.workspaceId}): ${ev.resolution.trim()}`,
            `Turn it into the guard rail it describes. The proposal as ${author.name} wrote it:`,
            fenceData(proposal, 'proposal'),
          ].join('\n'),
        },
      });
      return 'maintainer';
    }
    if (!author.enabled) return 'ignored';
    this.ports.wake({
      botId: author.id,
      workspaceId: author.workspaceId,
      priority: 0,
      threadId: card.threadId,
      reason: {
        kind: 'human',
        source: 'desktop',
        text: `I ${kind === 'approve' ? 'approved' : 'answered'} your proposal "${card.title}" (card ${card.id}): ${ev.resolution.trim()}`,
      },
    });
    return 'moa';
  }
}

let current: Gardener | null = null;

export function setGardener(g: Gardener | null): void {
  current = g;
}

export function getGardener(): Gardener | null {
  return current;
}
