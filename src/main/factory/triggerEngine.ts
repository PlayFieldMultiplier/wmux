// ─── Trigger engine — facts → bot wakes ────────────────────────────────────
//
// Subscribes to the fact log. For each new fact and each enabled bot that can
// see it, the bot's first trigger that matches (kind + filter) enqueues one
// `facts` wake carrying that trigger, batch config included, pinned to the
// fact's room thread; coalescing within the batch window is the wake queue's
// job. The repo watch (./repoWatch.ts)
// starts and stops with it.
//
// Which facts a bot sees (scope), in order:
//   1. a fact a bot produced (actor {kind:'bot', id}) never wakes that bot;
//      a bot in a guest workspace sees only its own workspace's facts, and
//      no other bot sees a guest workspace's (guestWorkspaces.ts);
//   2. a directed fact (handoff.received / handoff.refused / human.message /
//      schedule.fired / bot.notice with ref.botId) is seen by that bot only; a directed
//      human.message and a routine's schedule.fired wake nobody here (their
//      own wake is the one turn);
//   3. a Coordinator-template bot sees the bot-health and correction kinds of every
//      workspace and repo;
//   4. a fact with a repoKey is seen by the bots on that repo only;
//   5. else a fact with a workspaceId is seen by that workspace's bots only;
//   6. else everyone.
// Filters (shared/facts.ts FactFilter), all that are set must hold:
//   repoKey     the fact's repo is this one;
//   labelsAny   the label the fact added (ref.label), else one of its labels;
//   authorTrusted:true  payload.author ∈ trusted authors ∪ owner login — no
//               author, or no trust source, never matches;
//   botIdNot    the fact's ref.botId is not this id ('self' = the bot itself).
//
// The fact log, the wake queue, the bot directory and the trust source are
// ports, resolved when the module starts (setFactoryTriggerPorts); with any of
// the first three missing, start does nothing.

import path from 'node:path';
import { isCoordinatorBot, type BotProfile, type BotTrigger } from '../../shared/bot';
import type { Fact, FactDraft, FactFilter, FactKind } from '../../shared/facts';
import type { WakeItem, WakeReason } from '../../shared/wake';
import { GENERAL_THREAD, type ThreadId } from '../../shared/room';
import { registerFactoryRpcModule, type FactoryHostDeps } from './factoryHost';
import { REPO_WATCH_FILENAME, RepoWatch, normalizeRepoKey, type WatchGraphql } from './repoWatch';
import { gitlabWatchReader, type GitlabWatchPorts } from './repoWatchGitlab';
import { factThreadId } from './roomWriter';
import { factInIsland } from './guestWorkspaces';
import { isGitlabRepoKey, trustedAuthorsOn } from '../github/hostLane';

// ── Ports (shapes of design §14; the real ones are wired by the factory host) ─

export interface FactLogApi {
  /** null = deduplicated or refused */
  append(draft: FactDraft): Fact | null;
  subscribe(fn: (f: Fact) => void): () => void;
  readSince(cursor: string | null, filter?: FactFilter, limit?: number): { facts: Fact[]; cursor: string | null };
}

export interface WakeSinkApi {
  /** Merges fact wakes per the trigger's batch window; null = dropped. A
   *  keyed wake already queued or run returns that item (wakeQueue.ts). */
  enqueue(input: { botId: string; workspaceId: string; reason: WakeReason; priority: 0 | 1 | 2; threadId?: ThreadId; overCap?: true }): WakeItem | null;
  /** The bot's `guest` wakes waiting to run (wakeQueue.ts GUEST_WAKES_QUEUED_PER_BOT). */
  queuedGuestWakes?(botId: string): number;
  /** Resolves once every change so far is on disk (absent: in memory only). */
  flush?(): Promise<void>;
}

export interface BotDirectoryApi {
  /** Guest workspaces' bots left out (botStore.ts). */
  listEnabled(): BotProfile[];
  listEnabledIncludingGuest?(): BotProfile[];
  get(botId: string): BotProfile | null;
}

/** Who counts as a trusted PR / issue author (factory settings). */
export interface FactoryTrustApi {
  trustedAuthors(): string[];
  /** The signed-in owner's login, or null when unknown. */
  ownerLogin(): string | null;
  /** The owner's login on a GitLab host, or null when unknown (missing: none). */
  ownerLoginOn?(host: string): string | null;
}

export interface FactoryTriggerPorts {
  factLog: FactLogApi;
  wakes: WakeSinkApi;
  bots: BotDirectoryApi;
  /** Missing: authorTrusted never matches. */
  trust?: FactoryTrustApi;
  /** factory settings `enabled`; false pauses the repo watch. Default on. */
  factoryEnabled?: () => boolean;
  /** The gh read of the repo watch; default GhPrReviewService.watchGraphql. */
  graphql?: WatchGraphql;
  /** The glab reads of the repo watch on a GitLab repo; default GlabPrService. */
  gitlab?: GitlabWatchPorts;
}

type PortsResolver = () => Partial<FactoryTriggerPorts> | null;

let resolvePortsImpl: PortsResolver = () => null;

/** Point the module at the real ports (the factory host, at wiring time). */
export function setFactoryTriggerPorts(resolver: PortsResolver): void {
  resolvePortsImpl = resolver;
}

/** The ports when the required ones are all present, else null. */
export function resolvePorts(): FactoryTriggerPorts | null {
  let p: Partial<FactoryTriggerPorts> | null;
  try {
    p = resolvePortsImpl();
  } catch {
    return null;
  }
  if (!p?.factLog || !p.wakes || !p.bots) return null;
  return p as FactoryTriggerPorts;
}

// ── Matching (pure) ────────────────────────────────────────────────────────

const DIRECTED_KINDS: ReadonlySet<FactKind> = new Set(['handoff.received', 'handoff.refused', 'human.message', 'schedule.fired', 'bot.notice']);
const HQ_WIDE_KINDS: ReadonlySet<FactKind> = new Set(['bot.budget_exhausted', 'bot.error', 'bot.refused', 'human.correction']);

/** A routine's `schedule.fired` (routines.ts): its own wake is queued
 *  directly, for its bot only. */
export function isRoutineFact(fact: Fact): boolean {
  return fact.kind === 'schedule.fired' && !!fact.ref?.botId && typeof fact.ref.scheduleId === 'string' && fact.ref.scheduleId.startsWith('routine:');
}

/** Whether a bot can see a fact at all (scope rules 1–6 above). */
export function botSeesFact(bot: Pick<BotProfile, 'id' | 'workspaceId' | 'role' | 'template' | 'repo'>, fact: Fact): boolean {
  if (fact.actor?.kind === 'bot' && fact.actor.id === bot.id) return false;
  // The island first (guestWorkspaces.ts): before the directed and HQ-wide
  // rules, and in place of the fallthrough for a bot in a guest workspace.
  if (!factInIsland(bot.workspaceId, fact)) return false;
  if (DIRECTED_KINDS.has(fact.kind) && fact.ref?.botId) return fact.ref.botId === bot.id;
  if (isCoordinatorBot(bot) && HQ_WIDE_KINDS.has(fact.kind)) return true;
  if (fact.repoKey !== undefined) {
    const factRepo = normalizeRepoKey(fact.repoKey);
    return factRepo !== null && factRepo === normalizeRepoKey(bot.repo?.repoKey);
  }
  if (fact.workspaceId !== undefined) return fact.workspaceId === bot.workspaceId;
  return true;
}

function lower(xs: readonly unknown[]): string[] {
  return xs.filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => x.toLowerCase());
}

/** Whether payload.author is trusted. Unknown author or no trust source → no.
 *  On a GitLab repo the author is a GitLab username: only `host/username`
 *  entries of that host and the owner's login on that host match it. */
export function authorIsTrusted(fact: Fact, trust: FactoryTrustApi | undefined): boolean {
  const author = fact.payload?.author;
  if (!trust || typeof author !== 'string' || !author) return false;
  let trusted: string[];
  try {
    const key = normalizeRepoKey(fact.repoKey);
    if (key && isGitlabRepoKey(key)) {
      const owner = trust.ownerLoginOn?.(key.split('/')[0]) ?? null;
      trusted = [...trustedAuthorsOn(key, trust.trustedAuthors()), ...lower(owner ? [owner] : [])];
    } else {
      const owner = trust.ownerLogin();
      trusted = lower([...trust.trustedAuthors(), ...(owner ? [owner] : [])]);
    }
  } catch {
    return false;
  }
  return trusted.includes(author.toLowerCase());
}

/** Whether a fact satisfies a filter for this bot. */
export function filterMatches(filter: FactFilter | undefined, fact: Fact, bot: Pick<BotProfile, 'id'>, trust: FactoryTrustApi | undefined): boolean {
  if (!filter) return true;
  if (filter.repoKey !== undefined) {
    const want = normalizeRepoKey(filter.repoKey);
    if (want === null || want !== normalizeRepoKey(fact.repoKey)) return false;
  }
  if (filter.labelsAny !== undefined) {
    const want = new Set(lower(filter.labelsAny));
    const have = fact.ref?.label !== undefined
      ? lower([fact.ref.label])
      : lower(Array.isArray(fact.payload?.labels) ? (fact.payload.labels as unknown[]) : []);
    if (!have.some((l) => want.has(l))) return false;
  }
  if (filter.authorTrusted === true && !authorIsTrusted(fact, trust)) return false;
  if (filter.botIdNot !== undefined) {
    const not = filter.botIdNot === 'self' ? bot.id : filter.botIdNot;
    if (fact.ref?.botId === not) return false;
  }
  return true;
}

/** The bot's first trigger this fact matches, or null. */
export function matchingTrigger(bot: BotProfile, fact: Fact, trust: FactoryTrustApi | undefined): BotTrigger | null {
  if (!bot.enabled || !botSeesFact(bot, fact)) return null;
  for (const trigger of bot.triggers ?? []) {
    if (trigger.kind === fact.kind && filterMatches(trigger.filter, fact, bot, trust)) return trigger;
  }
  return null;
}

/** 0 human, 1 handoff / verdict / merge, 2 other facts (shared/wake.ts). */
export function wakePriority(kind: FactKind): 0 | 1 | 2 {
  if (kind === 'human.message') return 0;
  if (kind.startsWith('handoff.') || kind === 'verdict.recorded' || kind.startsWith('merge.')) return 1;
  return 2;
}

// ── Engine ─────────────────────────────────────────────────────────────────

export class TriggerEngine {
  private off: (() => void) | null = null;

  constructor(private readonly ports: Pick<FactoryTriggerPorts, 'factLog' | 'wakes' | 'bots' | 'trust'>, private readonly log: (msg: string, err?: unknown) => void = (m, e) => console.warn(`[factory] triggers: ${m}`, e ?? '')) {}

  start(): void {
    if (this.off) return;
    this.off = this.ports.factLog.subscribe((fact) => {
      this.route(fact);
    });
  }

  dispose(): void {
    this.off?.();
    this.off = null;
  }

  /** Enqueue the wakes one fact causes; returns the items the queue kept.
   *  Never throws (the fact log calls this). */
  route(fact: Fact): WakeItem[] {
    // A directed human message already queued its addressee's own wake
    // (humanMessage.ts), so did a delivered handoff (handoffRouter.ts, the
    // wake that carries its run and depth) and a bot's routine firing
    // (routines.ts): one message, hop or firing is one turn, so no trigger
    // adds another.
    if (fact.kind === 'human.message' && fact.ref?.botId) return [];
    if (fact.kind === 'handoff.received' && fact.ref?.botId) return [];
    if (isRoutineFact(fact)) return [];
    let bots: BotProfile[];
    try {
      bots = this.ports.bots.listEnabled();
    } catch (err) {
      this.log('bot directory unreadable; fact not routed', err);
      return [];
    }
    const out: WakeItem[] = [];
    // The wake is pinned to the fact's thread (its PR, issue or task), so the
    // bot's room posts land there and batching stays within one thread.
    let threadId: ThreadId = GENERAL_THREAD;
    try {
      threadId = factThreadId(fact);
    } catch {
      /* general */
    }
    for (const bot of bots) {
      let trigger: BotTrigger | null;
      try {
        trigger = matchingTrigger(bot, fact, this.ports.trust);
      } catch (err) {
        this.log(`trigger match failed for ${bot.id}`, err);
        continue;
      }
      if (!trigger) continue;
      try {
        const item = this.ports.wakes.enqueue({
          botId: bot.id,
          workspaceId: bot.workspaceId,
          reason: { kind: 'facts', factIds: [fact.id], trigger },
          priority: wakePriority(fact.kind),
          ...(threadId !== GENERAL_THREAD ? { threadId } : {}),
        });
        if (item) out.push(item);
      } catch (err) {
        this.log(`wake for ${bot.id} not enqueued`, err);
      }
    }
    return out;
  }
}

// ── Module ─────────────────────────────────────────────────────────────────

/** The default gh read: imported lazily so the module costs nothing until it
 *  starts with real ports. */
async function defaultGraphql(): Promise<WatchGraphql> {
  const { ghPrReviewService } = await import('../github/GhPrReviewService');
  return (repoPath, key, query, vars) => ghPrReviewService.watchGraphql(repoPath, key, query, vars);
}

/** The default glab reads, imported lazily as the gh one is. */
async function defaultGitlab(): Promise<GitlabWatchPorts> {
  const { glabPrService } = await import('../github/GlabPrService');
  return {
    graphql: (repoPath, key, query, vars) => glabPrService.watchGraphql(repoPath, key, query, vars),
    commitParents: (repoPath, key, sha) => glabPrService.commitParentsOf(repoPath, key, sha),
  };
}

export function createTriggerModule(deps: Pick<FactoryHostDeps, 'wmuxDir'>, resolve: () => FactoryTriggerPorts | null = resolvePorts) {
  let engine: TriggerEngine | null = null;
  let watch: RepoWatch | null = null;
  let disposed = false;
  return {
    async start(): Promise<void> {
      if (engine || disposed) return;
      const ports = resolve();
      if (!ports) {
        console.info('[factory] triggers: ports not wired; trigger engine and repo watch stay off');
        return;
      }
      const graphql = ports.graphql ?? (await defaultGraphql());
      const gitlab = ports.gitlab ?? (await defaultGitlab());
      if (disposed) return;
      engine = new TriggerEngine(ports);
      engine.start();
      watch = new RepoWatch({
        facts: ports.factLog,
        bots: ports.bots,
        graphql,
        gitlab: gitlabWatchReader(gitlab),
        stateFile: path.join(deps.wmuxDir(), 'factory', REPO_WATCH_FILENAME),
        ...(ports.factoryEnabled ? { enabled: ports.factoryEnabled } : {}),
      });
      await watch.start();
    },
    async dispose(): Promise<void> {
      disposed = true;
      const stopping = watch?.dispose();
      engine?.dispose();
      watch = null;
      engine = null;
      // The repo watch's last state write lands before quit goes on.
      await stopping;
    },
    /** Tests / diagnostics. */
    get running(): { engine: TriggerEngine | null; watch: RepoWatch | null } {
      return { engine, watch };
    },
  };
}

registerFactoryRpcModule('triggerEngine', (_router, deps) => createTriggerModule(deps));
