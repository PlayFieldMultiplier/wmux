// ─── Repo watch — GitHub state of the bots' repos, edge-detected into facts ──
//
// One loop per watched repo: the repos of the enabled bots' profiles
// (`BotProfile.repo`), at most REPO_WATCH_LIMITS.MAX_REPOS, polled every 60 s
// whether or not a window is visible. Each poll is ONE GraphQL read
// (WATCH_QUERY: the open PRs with their head, labels and head-commit check
// rollup, the recently closed PRs, and the open issues); a second read only
// for a second page when a repo has more than 100 open PRs. Never one query
// per PR.
//
// The last state seen is kept in `<wmuxDir>/factory/repo-watch.json`. A
// poll is diffed against it and every change becomes a fact draft: pr.opened,
// pr.head_moved, pr.labelled, pr.closed / pr.merged, ci.failed / ci.green (the
// head commit's rollup), issue.opened, issue.labelled. The first poll of a
// repo — no saved state, or a file that does not read — is a baseline: it is
// saved and emits nothing. Facts are appended before the state is saved, so
// a crash in between repeats them and the fact log's dedupe drops the repeat.
//
// Reads go through GhPrReviewService and the shared per-host rate-limit
// breaker: a rate-limited poll is retried when the breaker reopens, not
// sooner. A repo no enabled bot watches any more is dropped with its state,
// so watching it again starts from a new baseline.
//
// A GitLab repo key (hostLane.ts) is read with glab instead
// (repoWatchGitlab.ts) into the same snapshot, diffed and emitted the same
// way; a missing glab or a sign-out waits GITLAB_BACKOFF_MS before the next read.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSON, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { splitRepoKey } from '../github/GhIssueService';
import { normalizeRepoKey } from '../../shared/repoKey';
import type { PrReviewRead } from '../../shared/prReview';
import type { FactDraft } from '../../shared/facts';
import type { BotProfile } from '../../shared/bot';
import type { BotDirectoryApi, FactLogApi } from './triggerEngine';
import { guestSide } from './guestWorkspaces';
import { isGitlabRepoKey } from '../github/hostLane';
import type { GitlabWatchReader } from './repoWatchGitlab';

export const REPO_WATCH_FILENAME = 'repo-watch.json';

export const REPO_WATCH_LIMITS = {
  POLL_MS: 60_000,
  MAX_REPOS: 10,
  /** Open PRs read per repo per poll; more → a watch_cap refusal. */
  MAX_OPEN_PRS: 200,
  PAGE: 100,
  RECENT_CLOSED: 20,
  LABELS: 20,
  /** Issues kept in the state when the open-issue read was not complete. */
  MAX_KEPT_ISSUES: 2000,
  TITLE_MAX: 200,
  /** The wait after a missing glab or a GitLab sign-out. */
  GITLAB_BACKOFF_MS: 5 * 60_000,
} as const;

/** The method name a watch_cap refusal carries (`bot.refused` keys need one). */
export const REPO_WATCH_METHOD = 'repo.watch';

export type WatchChecks = 'pass' | 'fail' | 'pending';

export interface WatchedPrState {
  headSha: string;
  checks: WatchChecks;
  labels: string[];
  /** More labels than were read: no label edge is taken from this entry. */
  labelsTruncated?: boolean;
  state: string;
  author: string | null;
  /** GitLab: the merged-results pipeline the baseline saw on this head, its
   *  verdict not yet confirmed (repoWatchGitlab.ts). */
  unconfirmedSha?: string;
}

export interface WatchedIssueState {
  labels: string[];
  labelsTruncated?: boolean;
  state: string;
}

export interface RepoWatchState {
  lastPollAt: number;
  /** When the baseline was taken: an issue or PR created before it and first
   *  seen later is recorded, not announced. */
  baselineAt: number;
  /** The last poll read every open PR (≤ MAX_OPEN_PRS). */
  prsComplete: boolean;
  /** The open PR count was over MAX_OPEN_PRS at the last poll. */
  capped: boolean;
  prs: Record<string, WatchedPrState>;
  issues: Record<string, WatchedIssueState>;
}

export interface RepoWatchFile {
  version: 1;
  repos: Record<string, RepoWatchState>;
}

// ── GitHub read ────────────────────────────────────────────────────────────

const PR_FIELDS = `number title createdAt state isDraft headRefOid headRefName isCrossRepository mergeStateStatus
      author { login }
      labels(first: ${REPO_WATCH_LIMITS.LABELS}) { totalCount nodes { name } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }`;

/** The one read per poll. */
export const WATCH_QUERY = `query($owner: String!, $repo: String!) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $repo) {
    open: pullRequests(states: OPEN, first: ${REPO_WATCH_LIMITS.PAGE}, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }
    recent: pullRequests(states: [CLOSED, MERGED], first: ${REPO_WATCH_LIMITS.RECENT_CLOSED}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number state }
    }
    issues(states: OPEN, first: ${REPO_WATCH_LIMITS.PAGE}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes { number title createdAt state author { login } labels(first: ${REPO_WATCH_LIMITS.LABELS}) { totalCount nodes { name } } }
    }
  }
}`;

/** The second page of open PRs (only when there are more than one page). */
export const WATCH_PAGE_QUERY = `query($owner: String!, $repo: String!, $after: String!) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $repo) {
    open: pullRequests(states: OPEN, first: ${REPO_WATCH_LIMITS.PAGE}, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }
  }
}`;

export interface WatchPr {
  number: number;
  title: string;
  createdAt: number;
  state: string;
  isDraft: boolean;
  headSha: string;
  headRefName: string;
  isCrossRepository: boolean;
  mergeStateStatus: string;
  author: string | null;
  labels: string[];
  labelsTruncated: boolean;
  checks: WatchChecks;
  /** GitLab: see WatchedPrState.unconfirmedSha. */
  unconfirmedSha?: string;
  /** GitLab: `checks` was already the verdict at the baseline, confirmed
   *  only now: recorded without a ci fact. */
  checksHeld?: boolean;
}

export interface WatchIssue {
  number: number;
  title: string;
  createdAt: number;
  author: string | null;
  labels: string[];
  labelsTruncated: boolean;
}

export interface WatchSnapshot {
  prs: WatchPr[];
  prTotal: number;
  /** The open PRs alone, when prTotal counts others too (GitLab's locked
   *  MRs): the MAX_OPEN_PRS cap counts these. */
  openTotal?: number;
  /** Closed / merged PRs, newest update first: number → 'CLOSED' | 'MERGED'. */
  recent: Record<string, string>;
  issues: WatchIssue[];
  issueTotal: number;
}

/** The answer to a gh GraphQL read (GhPrReviewService.watchGraphql). */
export type WatchGraphql = (
  repoPath: string,
  repoKey: string,
  query: string,
  variables: Record<string, string | number>,
) => Promise<PrReviewRead<unknown>>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function labelsOf(raw: unknown): string[] {
  const nodes = (raw as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return [...new Set(nodes.map((n) => str((n as { name?: unknown } | null)?.name)).filter(Boolean))].sort();
}

/** Whether a label connection holds more labels than its nodes. An
 *  unreadable count is not proof that every label was read. */
function labelsTruncated(raw: unknown): boolean {
  const c = raw as { totalCount?: unknown; nodes?: unknown } | null;
  const read = Array.isArray(c?.nodes) ? c.nodes.length : 0;
  return typeof c?.totalCount !== 'number' || c.totalCount > read;
}

function timeOf(v: unknown): number {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : 0;
}

/** The head commit's rollup as pass / fail / pending. A rollup of another
 *  commit than the head, or none, is pending. */
export function checksOf(rollupState: unknown, commitOid: unknown, headSha: string): WatchChecks {
  if (commitOid !== headSha) return 'pending';
  switch (rollupState) {
    case 'SUCCESS': return 'pass';
    case 'FAILURE':
    case 'ERROR': return 'fail';
    default: return 'pending';
  }
}

function mapPr(raw: unknown): WatchPr | null {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p.number !== 'number' || !Number.isInteger(p.number) || p.number <= 0) return null;
  if (typeof p.headRefOid !== 'string' || !p.headRefOid) return null;
  const commitNodes = (p.commits as { nodes?: unknown } | null)?.nodes;
  const commit = Array.isArray(commitNodes) ? (commitNodes[0] as { commit?: Record<string, unknown> } | undefined)?.commit : undefined;
  const rollup = commit?.statusCheckRollup as { state?: unknown } | null | undefined;
  return {
    number: p.number,
    title: str(p.title).slice(0, REPO_WATCH_LIMITS.TITLE_MAX),
    createdAt: timeOf(p.createdAt),
    state: str(p.state) || 'OPEN',
    isDraft: p.isDraft === true,
    headSha: p.headRefOid,
    headRefName: str(p.headRefName),
    // Unreadable reads as a fork: the cautious side.
    isCrossRepository: p.isCrossRepository !== false,
    mergeStateStatus: str(p.mergeStateStatus) || 'UNKNOWN',
    author: str((p.author as { login?: unknown } | null)?.login) || null,
    labels: labelsOf(p.labels),
    labelsTruncated: labelsTruncated(p.labels),
    checks: checksOf(rollup?.state, commit?.oid, p.headRefOid),
  };
}

function mapIssue(raw: unknown): WatchIssue | null {
  const i = raw as Record<string, unknown> | null;
  if (!i || typeof i.number !== 'number' || !Number.isInteger(i.number) || i.number <= 0) return null;
  return {
    number: i.number,
    title: str(i.title).slice(0, REPO_WATCH_LIMITS.TITLE_MAX),
    createdAt: timeOf(i.createdAt),
    author: str((i.author as { login?: unknown } | null)?.login) || null,
    labels: labelsOf(i.labels),
    labelsTruncated: labelsTruncated(i.labels),
  };
}

interface PrPage { prs: WatchPr[]; total: number; hasNext: boolean; cursor: string | null }

function mapPrPage(conn: unknown): PrPage | null {
  const c = conn as { totalCount?: unknown; nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } | null;
  if (!c || typeof c.totalCount !== 'number' || !Array.isArray(c.nodes)) return null;
  return {
    prs: c.nodes.flatMap((n) => { const pr = mapPr(n); return pr ? [pr] : []; }),
    total: c.totalCount,
    hasNext: c.pageInfo?.hasNextPage === true,
    cursor: str(c.pageInfo?.endCursor) || null,
  };
}

/** WATCH_QUERY's answer as a snapshot (first page only), or null when it is
 *  not one. */
export function mapWatchAnswer(raw: unknown): { snapshot: WatchSnapshot; next: string | null; cost: number | null } | null {
  const data = (raw as { data?: { rateLimit?: { cost?: unknown }; repository?: Record<string, unknown> | null } } | null)?.data;
  const repo = data?.repository;
  if (!repo) return null;
  const page = mapPrPage(repo.open);
  const issuesConn = repo.issues as { totalCount?: unknown; nodes?: unknown } | null | undefined;
  if (!page || !issuesConn || typeof issuesConn.totalCount !== 'number' || !Array.isArray(issuesConn.nodes)) return null;
  const recentNodes = (repo.recent as { nodes?: unknown } | null | undefined)?.nodes;
  const recent: Record<string, string> = {};
  if (Array.isArray(recentNodes)) {
    for (const n of recentNodes) {
      const r = n as { number?: unknown; state?: unknown } | null;
      if (typeof r?.number === 'number' && (r.state === 'MERGED' || r.state === 'CLOSED')) recent[String(r.number)] = r.state;
    }
  }
  return {
    snapshot: {
      prs: page.prs,
      prTotal: page.total,
      recent,
      issues: issuesConn.nodes.flatMap((n) => { const i = mapIssue(n); return i ? [i] : []; }),
      issueTotal: issuesConn.totalCount,
    },
    next: page.hasNext ? page.cursor : null,
    cost: typeof data?.rateLimit?.cost === 'number' ? data.rateLimit.cost : null,
  };
}

/** WATCH_PAGE_QUERY's answer, or null. */
export function mapWatchPage(raw: unknown): { prs: WatchPr[]; cost: number | null } | null {
  const data = (raw as { data?: { rateLimit?: { cost?: unknown }; repository?: Record<string, unknown> | null } } | null)?.data;
  const page = data?.repository ? mapPrPage(data.repository.open) : null;
  if (!page) return null;
  return { prs: page.prs, cost: typeof data?.rateLimit?.cost === 'number' ? data.rateLimit.cost : null };
}

// ── Edge detection (pure) ──────────────────────────────────────────────────

/** A repo key as the factory compares them: `host/owner/repo`, lowercased
 *  (the shape PrProvider.parseRemoteKey gives); a bare `owner/repo` is read
 *  as github.com. Null when it is not a GitHub repo key. The one shared
 *  normalizer (thread ids, fact.emit and bot profiles use it too). */
export { normalizeRepoKey };

function prPayload(pr: WatchPr): Record<string, unknown> {
  return {
    author: pr.author,
    title: pr.title,
    headRefName: pr.headRefName,
    isCrossRepository: pr.isCrossRepository,
    isDraft: pr.isDraft,
    labels: pr.labels,
    mergeStateStatus: pr.mergeStateStatus,
    checks: pr.checks,
  };
}

function prStateOf(pr: WatchPr): WatchedPrState {
  return {
    headSha: pr.headSha, checks: pr.checks, labels: pr.labels, state: pr.state, author: pr.author,
    ...(pr.labelsTruncated ? { labelsTruncated: true } : {}),
    ...(pr.unconfirmedSha ? { unconfirmedSha: pr.unconfirmedSha } : {}),
  };
}

export interface RepoDiff {
  next: RepoWatchState;
  drafts: FactDraft[];
  /** The open PR count went over MAX_OPEN_PRS at this poll (rising edge). */
  capRising: boolean;
}

/**
 * Diff one poll against the saved state of its repo. No previous state = a
 * baseline: the snapshot is recorded and nothing is emitted. Pure.
 */
export function diffRepo(prev: RepoWatchState | undefined, snap: WatchSnapshot, repoKey: string, now: number): RepoDiff {
  const capped = (snap.openTotal ?? snap.prTotal) > REPO_WATCH_LIMITS.MAX_OPEN_PRS;
  const prsComplete = !capped && snap.prs.length >= snap.prTotal;
  const issuesComplete = snap.issues.length >= snap.issueTotal;
  const next: RepoWatchState = {
    lastPollAt: now,
    baselineAt: prev?.baselineAt ?? now,
    prsComplete,
    capped,
    prs: {},
    issues: {},
  };
  const drafts: FactDraft[] = [];
  const github = (author: string | null) => ({ kind: 'github' as const, ...(author ? { id: author } : {}) });
  const prDraft = (kind: FactDraft['kind'], pr: WatchPr, extra: { ref?: Record<string, unknown>; payload?: Record<string, unknown> } = {}): FactDraft => ({
    kind,
    at: now,
    repoKey,
    ref: { pr: pr.number, headSha: pr.headSha, ...extra.ref },
    actor: github(pr.author),
    payload: { ...prPayload(pr), ...extra.payload },
  });

  for (const pr of snap.prs) {
    next.prs[String(pr.number)] = prStateOf(pr);
    if (!prev) continue;
    const was = prev.prs[String(pr.number)];
    let checksBefore: WatchChecks;
    if (!was) {
      // New since the last complete read, or created after the baseline: a
      // PR first seen otherwise is recorded silently.
      if (!prev.prsComplete && pr.createdAt <= prev.baselineAt) continue;
      drafts.push(prDraft('pr.opened', pr));
      checksBefore = 'pending';
    } else if (was.headSha !== pr.headSha) {
      drafts.push(prDraft('pr.head_moved', pr, { payload: { previousHeadSha: was.headSha } }));
      // A new head starts with no result: a head that is already green or
      // red when first seen still yields its ci fact.
      checksBefore = 'pending';
    } else {
      checksBefore = pr.checksHeld ? pr.checks : was.checks;
    }
    // A label list cut short on either side cannot tell an added label from
    // one that was not read before.
    if (was && !was.labelsTruncated && !pr.labelsTruncated) {
      const before = new Set(was.labels);
      for (const label of pr.labels) {
        if (!before.has(label)) drafts.push(prDraft('pr.labelled', pr, { ref: { label } }));
      }
    }
    if (pr.checks !== checksBefore && pr.checks !== 'pending') {
      drafts.push(prDraft(pr.checks === 'pass' ? 'ci.green' : 'ci.failed', pr));
    }
  }

  if (prev) {
    for (const [n, was] of Object.entries(prev.prs)) {
      if (next.prs[n]) continue;
      // Not read this time: gone only when the read was complete.
      if (!prsComplete) {
        next.prs[n] = was;
        continue;
      }
      const closedAs = snap.recent[n];
      drafts.push({
        kind: closedAs === 'MERGED' ? 'pr.merged' : 'pr.closed',
        at: now,
        repoKey,
        ref: { pr: Number(n), headSha: was.headSha },
        actor: github(was.author),
        payload: { author: was.author, labels: was.labels, ...(closedAs ? {} : { stateUnknown: true }) },
      });
    }
  }

  for (const issue of snap.issues) {
    next.issues[String(issue.number)] = { labels: issue.labels, state: 'OPEN', ...(issue.labelsTruncated ? { labelsTruncated: true } : {}) };
    if (!prev) continue;
    const was = prev.issues[String(issue.number)];
    const base = { at: now, repoKey, actor: github(issue.author) };
    const payload = { author: issue.author, title: issue.title, labels: issue.labels };
    if (!was) {
      // The issue read is a window (newest update first): an older issue
      // entering it is recorded, only one created after the baseline is new.
      if (issue.createdAt > prev.baselineAt) drafts.push({ kind: 'issue.opened', ...base, ref: { issue: issue.number }, payload });
      continue;
    }
    if (was.labelsTruncated || issue.labelsTruncated) continue;
    const before = new Set(was.labels);
    for (const label of issue.labels) {
      if (!before.has(label)) drafts.push({ kind: 'issue.labelled', ...base, ref: { issue: issue.number, label }, payload });
    }
  }
  if (prev && !issuesComplete) {
    // Outside the window is not closed: keep what was known, bounded.
    const kept = Object.keys(prev.issues).filter((n) => !next.issues[n]);
    for (const n of kept.slice(-REPO_WATCH_LIMITS.MAX_KEPT_ISSUES)) next.issues[n] = prev.issues[n];
  }

  return { next, drafts, capRising: capped && !(prev?.capped ?? false) };
}

// ── Loop ───────────────────────────────────────────────────────────────────

export interface WatchedRepo {
  repoKey: string;
  repoPath: string;
  /** The enabled bots on this repo (ids sorted). */
  bots: Array<Pick<BotProfile, 'id' | 'workspaceId'>>;
}

/** The repos the enabled bots act on, by normalized key (first repoPath by
 *  bot id wins), split into the watched ones (≤ MAX_REPOS, by key order) and
 *  the ones over the cap. */
export function watchedRepos(bots: readonly BotProfile[]): { watched: WatchedRepo[]; overCap: WatchedRepo[] } {
  const byKey = new Map<string, WatchedRepo>();
  for (const bot of [...bots].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!bot.enabled || !bot.repo) continue;
    const key = normalizeRepoKey(bot.repo.repoKey);
    if (!key || !bot.repo.repoPath) continue;
    const entry = byKey.get(key) ?? { repoKey: key, repoPath: bot.repo.repoPath, bots: [] };
    entry.bots.push({ id: bot.id, workspaceId: bot.workspaceId });
    byKey.set(key, entry);
  }
  const all = [...byKey.values()].sort((a, b) => a.repoKey.localeCompare(b.repoKey));
  return { watched: all.slice(0, REPO_WATCH_LIMITS.MAX_REPOS), overCap: all.slice(REPO_WATCH_LIMITS.MAX_REPOS) };
}

export interface RepoWatchPorts {
  facts: Pick<FactLogApi, 'append'>;
  bots: Pick<BotDirectoryApi, 'listEnabled'>;
  graphql: WatchGraphql;
  /** The read of a GitLab repo key; missing = a GitLab repo is not read. */
  gitlab?: GitlabWatchReader;
  /** `<wmuxDir>/factory/repo-watch.json` */
  stateFile: string;
  /** factory settings `enabled`; false = nothing is watched (and the state
   *  is dropped, so turning it on again starts from a baseline). Default on. */
  enabled?: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string, err?: unknown) => void;
}

export interface PollOutcome {
  ok: boolean;
  /** gh calls made by this poll. */
  calls: number;
  /** Drafts appended (refusals included). */
  emitted: number;
  baseline: boolean;
  /** GraphQL points this poll cost, when GitHub said. */
  cost: number | null;
  /** Rate-limited: the next poll is not before this. */
  retryAt?: number;
  error?: string;
}

interface Loop { repo: WatchedRepo; timer: unknown; inFlight: Promise<PollOutcome> | null; stopped: boolean }

function isStateFile(v: unknown): v is RepoWatchFile {
  const f = v as RepoWatchFile | null;
  return !!f && f.version === 1 && !!f.repos && typeof f.repos === 'object' && !Array.isArray(f.repos);
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isLabels = (v: unknown): v is string[] => Array.isArray(v) && v.every((l) => typeof l === 'string');
const isEntryKey = (k: string): boolean => /^[1-9]\d*$/.test(k);

function isPrState(v: unknown): v is WatchedPrState {
  return isRecord(v) && typeof v.headSha === 'string' && v.headSha.length > 0
    && (v.checks === 'pass' || v.checks === 'fail' || v.checks === 'pending')
    && isLabels(v.labels) && typeof v.state === 'string'
    && (v.author === null || typeof v.author === 'string')
    && (v.labelsTruncated === undefined || typeof v.labelsTruncated === 'boolean')
    && (v.unconfirmedSha === undefined || (typeof v.unconfirmedSha === 'string' && v.unconfirmedSha.length > 0));
}

function isIssueState(v: unknown): v is WatchedIssueState {
  return isRecord(v) && isLabels(v.labels) && typeof v.state === 'string'
    && (v.labelsTruncated === undefined || typeof v.labelsTruncated === 'boolean');
}

/** A saved repo state, every entry checked: one bad entry rejects the repo
 *  (it then starts from a baseline, never from a guess). */
export function isRepoState(v: unknown): v is RepoWatchState {
  if (!isRecord(v)) return false;
  return Number.isFinite(v.lastPollAt) && Number.isFinite(v.baselineAt)
    && typeof v.prsComplete === 'boolean' && typeof v.capped === 'boolean'
    && isRecord(v.prs) && Object.entries(v.prs).every(([k, e]) => isEntryKey(k) && isPrState(e))
    && isRecord(v.issues) && Object.entries(v.issues).every(([k, e]) => isEntryKey(k) && isIssueState(e));
}

export class RepoWatch {
  private repos: Record<string, RepoWatchState> = {};
  private loops = new Map<string, Loop>();
  private overCapNoted = new Set<string>();
  /** GitLab repos backing off after a missing glab or a sign-out (noted once). */
  private gitlabBlocked = new Set<string>();
  private reconcileTimer: unknown = null;
  private writes: Promise<void> = Promise.resolve();
  private started = false;
  private disposed = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(private readonly ports: RepoWatchPorts) {
    this.now = ports.now ?? Date.now;
    this.setTimer = ports.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = ports.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = ports.log ?? ((msg, err) => console.warn(`[factory] repo watch: ${msg}`, err ?? ''));
  }

  /** Load the saved state and start the loops. A file that does not read is
   *  treated as absent (every repo starts from a baseline). */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      const file = await atomicReadJSON<RepoWatchFile>(this.ports.stateFile, { validate: isStateFile });
      for (const [key, state] of Object.entries(file?.repos ?? {})) {
        const k = normalizeRepoKey(key);
        if (k && isRepoState(state)) this.repos[k] = state;
      }
    } catch (err) {
      this.log('state unreadable; starting from a baseline', err);
    }
    this.reconcile();
  }

  /** Stop every loop; resolves once the queued state writes landed. */
  dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconcileTimer !== null) this.clearTimer(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const loop of this.loops.values()) this.stopLoop(loop);
    this.loops.clear();
    return this.writes;
  }

  /** The repos being polled now (keys). */
  watching(): string[] {
    return [...this.loops.keys()];
  }

  /** The saved state of one repo (tests, diagnostics). */
  stateOf(repoKey: string): RepoWatchState | undefined {
    return this.repos[repoKey];
  }

  /** Settle pending state writes (tests). */
  flush(): Promise<void> {
    return this.writes;
  }

  /** Bring the loops in line with the enabled bots' repos; runs every poll
   *  interval, since bots change at runtime. */
  reconcile(): void {
    if (this.disposed) return;
    if (this.reconcileTimer !== null) this.clearTimer(this.reconcileTimer);
    this.reconcileTimer = this.setTimer(() => this.reconcile(), REPO_WATCH_LIMITS.POLL_MS);
    let bots: BotProfile[] = [];
    let on = true;
    try {
      on = this.ports.enabled ? this.ports.enabled() : true;
      // A guest workspace has no repository; skipped all the same.
      if (on) bots = this.ports.bots.listEnabled().filter((b) => !guestSide(b.workspaceId));
    } catch (err) {
      // Unreadable directory: keep what runs, change nothing.
      this.log('bot directory unreadable', err);
      return;
    }
    const { watched, overCap } = watchedRepos(on ? bots : []);
    const keys = new Set(watched.map((r) => r.repoKey));
    let dropped = false;
    for (const [key, loop] of this.loops) {
      if (keys.has(key)) continue;
      this.stopLoop(loop);
      this.loops.delete(key);
      this.gitlabBlocked.delete(key);
    }
    for (const key of Object.keys(this.repos)) {
      if (!keys.has(key)) {
        delete this.repos[key];
        dropped = true;
      }
    }
    if (dropped) this.save();
    for (const repo of watched) {
      const loop = this.loops.get(repo.repoKey);
      if (loop) {
        loop.repo = repo;
        continue;
      }
      const fresh: Loop = { repo, timer: null, inFlight: null, stopped: false };
      this.loops.set(repo.repoKey, fresh);
      this.schedule(fresh, 0);
    }
    const overKeys = new Set(overCap.map((r) => r.repoKey));
    for (const repo of overCap) {
      if (this.overCapNoted.has(repo.repoKey)) continue;
      // Noted only once its refusal landed: a failed append is retried next round.
      if (this.refuse(repo, { reason: 'repos', limit: REPO_WATCH_LIMITS.MAX_REPOS }).failed === 0) this.overCapNoted.add(repo.repoKey);
    }
    for (const key of [...this.overCapNoted]) if (!overKeys.has(key)) this.overCapNoted.delete(key);
  }

  private stopLoop(loop: Loop): void {
    loop.stopped = true;
    if (loop.timer !== null) this.clearTimer(loop.timer);
    loop.timer = null;
  }

  private schedule(loop: Loop, delayMs: number): void {
    if (loop.stopped || this.disposed) return;
    if (loop.timer !== null) this.clearTimer(loop.timer);
    loop.timer = this.setTimer(() => {
      loop.timer = null;
      void this.tick(loop);
    }, Math.max(0, delayMs));
  }

  private async tick(loop: Loop): Promise<void> {
    if (loop.stopped || this.disposed) return;
    const outcome = await this.runPoll(loop);
    const wait = outcome.retryAt !== undefined
      ? Math.max(REPO_WATCH_LIMITS.POLL_MS, outcome.retryAt - this.now())
      : REPO_WATCH_LIMITS.POLL_MS;
    this.schedule(loop, wait);
  }

  /** One poll of a watched repo now (one in flight per repo). */
  pollNow(repoKey: string): Promise<PollOutcome> | null {
    const loop = this.loops.get(normalizeRepoKey(repoKey) ?? '');
    return loop ? this.runPoll(loop) : null;
  }

  private runPoll(loop: Loop): Promise<PollOutcome> {
    if (loop.inFlight) return loop.inFlight;
    const run = this.poll(loop).finally(() => {
      loop.inFlight = null;
    });
    loop.inFlight = run;
    return run;
  }

  private async poll(loop: Loop): Promise<PollOutcome> {
    const { repoKey, repoPath } = loop.repo;
    // Every host that is not GitHub's goes to glab, as in the rest of the
    // factory (hostLane.ts), a GitHub Enterprise server on its own domain too.
    if (isGitlabRepoKey(repoKey)) return this.pollGitlab(loop);
    const parts = splitRepoKey(repoKey);
    const outcome: PollOutcome = { ok: false, calls: 0, emitted: 0, baseline: false, cost: null };
    if (!parts) return { ...outcome, error: 'not a GitHub repo key' };
    const vars = { owner: parts.owner, repo: parts.repo };
    let first: ReturnType<typeof mapWatchAnswer>;
    try {
      outcome.calls++;
      const read = await this.ports.graphql(repoPath, repoKey, WATCH_QUERY, vars);
      if (!read.ok) return read.code === 'rate-limited' ? { ...outcome, retryAt: read.retryAt, error: read.message } : { ...outcome, error: read.message };
      first = mapWatchAnswer(read.value);
      if (!first) return { ...outcome, error: 'unexpected answer' };
      outcome.cost = first.cost;
      if (first.next && first.snapshot.prs.length < REPO_WATCH_LIMITS.MAX_OPEN_PRS) {
        outcome.calls++;
        const page = await this.ports.graphql(repoPath, repoKey, WATCH_PAGE_QUERY, { ...vars, after: first.next });
        if (!page.ok) return page.code === 'rate-limited' ? { ...outcome, retryAt: page.retryAt, error: page.message } : { ...outcome, error: page.message };
        const more = mapWatchPage(page.value);
        if (!more) return { ...outcome, error: 'unexpected answer' };
        const seen = new Set(first.snapshot.prs.map((p) => p.number));
        first.snapshot.prs.push(...more.prs.filter((p) => !seen.has(p.number)).slice(0, REPO_WATCH_LIMITS.MAX_OPEN_PRS - first.snapshot.prs.length));
        if (more.cost !== null) outcome.cost = (outcome.cost ?? 0) + more.cost;
      }
    } catch (err) {
      this.log(`poll of ${repoKey} failed`, err);
      return { ...outcome, error: err instanceof Error ? err.message : String(err) };
    }
    return this.settle(loop, first.snapshot, outcome);
  }

  /** A poll of a GitLab repo (repoWatchGitlab.ts). A missing glab or a
   *  sign-out is noted once and asked again after GITLAB_BACKOFF_MS. */
  private async pollGitlab(loop: Loop): Promise<PollOutcome> {
    const { repoKey, repoPath } = loop.repo;
    const outcome: PollOutcome = { ok: false, calls: 0, emitted: 0, baseline: false, cost: null };
    if (!this.ports.gitlab) return { ...outcome, error: 'GitLab repos are not read' };
    let read: Awaited<ReturnType<GitlabWatchReader>>;
    try {
      read = await this.ports.gitlab(repoPath, repoKey, this.repos[repoKey]);
    } catch (err) {
      this.log(`poll of ${repoKey} failed`, err);
      return { ...outcome, error: err instanceof Error ? err.message : String(err) };
    }
    outcome.calls = read.calls;
    if (!read.ok) {
      if (!read.backoff) return { ...outcome, error: read.message };
      if (!this.gitlabBlocked.has(repoKey)) {
        this.gitlabBlocked.add(repoKey);
        this.log(`${repoKey} not read: ${read.message}`);
      }
      return { ...outcome, retryAt: this.now() + REPO_WATCH_LIMITS.GITLAB_BACKOFF_MS, error: read.message };
    }
    this.gitlabBlocked.delete(repoKey);
    return this.settle(loop, read.snapshot, outcome);
  }

  /** Diff a poll's snapshot against the saved state, append its facts, and
   *  save the new state once they all landed. */
  private settle(loop: Loop, snapshot: WatchSnapshot, outcome: PollOutcome): PollOutcome {
    const { repoKey } = loop.repo;
    if (loop.stopped || this.disposed) return outcome;
    const prev = this.repos[repoKey];
    const diff = diffRepo(prev, snapshot, repoKey, this.now());
    outcome.baseline = !prev;
    let failed = 0;
    for (const draft of diff.drafts) {
      const r = this.append(draft);
      if (r === 'appended') outcome.emitted++;
      else if (r === 'error') failed++;
    }
    if (diff.capRising) {
      const r = this.refuse(loop.repo, { reason: 'open_prs', limit: REPO_WATCH_LIMITS.MAX_OPEN_PRS, openPrs: snapshot.openTotal ?? snapshot.prTotal });
      outcome.emitted += r.appended;
      failed += r.failed;
    }
    if (failed > 0) {
      // The state is not advanced: the next poll sees the same edges again,
      // and the fact log drops the ones that did land.
      return { ...outcome, error: `${failed} fact(s) not appended` };
    }
    this.repos[repoKey] = diff.next;
    this.save();
    return { ...outcome, ok: true };
  }

  /** 'skipped' = the log deduplicated or refused it; 'error' = it threw. */
  private append(draft: FactDraft): 'appended' | 'skipped' | 'error' {
    try {
      return this.ports.facts.append(draft) !== null ? 'appended' : 'skipped';
    } catch (err) {
      this.log(`fact ${draft.kind} not appended`, err);
      return 'error';
    }
  }

  /** A watch_cap refusal, one per workspace whose bots watch the repo. */
  private refuse(repo: WatchedRepo, detail: Record<string, unknown>): { appended: number; failed: number } {
    const seen = new Set<string>();
    let n = 0;
    let failed = 0;
    for (const bot of repo.bots) {
      if (seen.has(bot.workspaceId)) continue;
      seen.add(bot.workspaceId);
      const ok = this.append({
        kind: 'bot.refused',
        at: this.now(),
        workspaceId: bot.workspaceId,
        repoKey: repo.repoKey,
        ref: { botId: bot.id, method: REPO_WATCH_METHOD },
        actor: { kind: 'system' },
        payload: { code: 'watch_cap', ...detail },
      });
      if (ok === 'appended') n++;
      else if (ok === 'error') failed++;
    }
    return { appended: n, failed };
  }

  private save(): void {
    const snapshot: RepoWatchFile = { version: 1, repos: { ...this.repos } };
    const file = this.ports.stateFile;
    this.writes = this.writes.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await atomicWriteJSON(file, snapshot);
      } catch (err) {
        this.log('state not saved', err);
      }
    });
  }
}
