// ─── Repo watch, GitLab side — a GitLab project read into the same snapshot ──
//
// A repo key whose host is not GitHub's (hostLane.ts isGitlabRepoKey) is read
// with glab instead of gh, into the WatchSnapshot repoWatch.ts diffs, so the
// same facts come out: an MR is a PR whose number is its iid, and its
// headSha is the MR's diffHeadSha (what the merge lane's laneFacts reads).
//
// One GraphQL read per poll (GITLAB_WATCH_QUERY: the open and locked MRs
// with their head pipeline's jobs, the recently merged and closed MRs, and
// the open issues); a second only for a second page of open MRs. A locked MR
// (a merge in progress) is read with the open ones, so a poll in that window
// does not take it for closed.
//
// An MR's checks follow laneFacts (GlabPrService): its head pipeline, on the
// head, with every job that may not fail passed. A merged-results pipeline
// runs on GitLab's merge of the head into the target, so its verdict counts
// only once the head is one of that commit's parents: a REST read, at most
// GITLAB_WATCH_LIMITS.PARENT_READS per poll, remembered by commit; an MR
// still unconfirmed is pending and asked again next poll.
//
// A missing glab or a definite sign-out answers `backoff`: the watch waits
// REPO_WATCH_LIMITS.GITLAB_BACKOFF_MS before asking again.

import { glabJobBucket, glabMergeState, mapGlabPipelineStatus } from '../github/GlabPrService';
import type { PrReviewRead } from '../../shared/prReview';
import { REPO_WATCH_LIMITS, type RepoWatchState, type WatchChecks, type WatchIssue, type WatchPr, type WatchSnapshot } from './repoWatch';

export const GITLAB_WATCH_LIMITS = {
  /** Jobs read per head pipeline (laneFacts reads as many). */
  JOBS: 100,
  /** Locked MRs (merges in progress) read with the open ones. */
  LOCKED: 20,
  /** Merge-commit parent reads per poll. */
  PARENT_READS: 1,
  /** Merge commits whose parents are remembered. */
  PARENTS_KEPT: 512,
} as const;

const MR_FIELDS = `iid title createdAt state draft diffHeadSha sourceBranch sourceProjectId targetProjectId detailedMergeStatus conflicts
      author { username }
      labels(first: ${REPO_WATCH_LIMITS.LABELS}) { count nodes { title } }
      headPipeline { sha status mergeRequestEventType jobs(first: ${GITLAB_WATCH_LIMITS.JOBS}, retried: false) { pageInfo { hasNextPage } nodes { status allowFailure } } }`;

/** The one read per poll. */
export const GITLAB_WATCH_QUERY = `query($fullPath: ID!) {
  project(fullPath: $fullPath) {
    open: mergeRequests(state: opened, first: ${REPO_WATCH_LIMITS.PAGE}, sort: CREATED_DESC) {
      count
      pageInfo { hasNextPage endCursor }
      nodes { ${MR_FIELDS} }
    }
    locked: mergeRequests(state: locked, first: ${GITLAB_WATCH_LIMITS.LOCKED}) {
      count
      nodes { ${MR_FIELDS} }
    }
    merged: mergeRequests(state: merged, first: ${REPO_WATCH_LIMITS.RECENT_CLOSED}, sort: UPDATED_DESC) { nodes { iid } }
    closed: mergeRequests(state: closed, first: ${REPO_WATCH_LIMITS.RECENT_CLOSED}, sort: UPDATED_DESC) { nodes { iid } }
    issues(state: opened, first: ${REPO_WATCH_LIMITS.PAGE}, sort: UPDATED_DESC) {
      count
      nodes { iid title createdAt author { username } labels(first: ${REPO_WATCH_LIMITS.LABELS}) { count nodes { title } } }
    }
  }
}`;

/** The second page of open MRs. */
export const GITLAB_WATCH_PAGE_QUERY = `query($fullPath: ID!, $after: String!) {
  project(fullPath: $fullPath) {
    open: mergeRequests(state: opened, first: ${REPO_WATCH_LIMITS.PAGE}, after: $after, sort: CREATED_DESC) {
      count
      pageInfo { hasNextPage endCursor }
      nodes { ${MR_FIELDS} }
    }
  }
}`;

/** A glab GraphQL read (GlabPrService.watchGraphql): a missing glab or a
 *  sign-out is told apart from any other failure. */
export type GitlabWatchAnswer = PrReviewRead<unknown> | { ok: false; code: 'cli-missing' | 'unauthenticated'; message: string };

export interface GitlabWatchPorts {
  graphql: (repoPath: string, repoKey: string, query: string, variables: Record<string, string>) => Promise<GitlabWatchAnswer>;
  /** The parents of a commit in the project; [] when unreadable. */
  commitParents: (repoPath: string, repoKey: string, sha: string) => Promise<string[]>;
}

/** A merged-results verdict waiting for its parent check. */
export interface UnconfirmedChecks {
  pr: number;
  pipelineSha: string;
  verdict: 'pass' | 'fail';
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A GitLab iid (a string in GraphQL) as a positive integer, or null. */
function iidOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function timeOf(v: unknown): number {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : 0;
}

function labelsOf(raw: unknown): { labels: string[]; truncated: boolean } {
  const c = rec(raw);
  const nodes = Array.isArray(c?.nodes) ? (c.nodes as unknown[]) : [];
  const labels = [...new Set(nodes.map((n) => str(rec(n)?.title)).filter(Boolean))].sort();
  // An unreadable count is not proof that every label was read.
  return { labels, truncated: typeof c?.count !== 'number' || c.count > nodes.length };
}

/** The head pipeline's verdict from its jobs and status, as laneFacts'
 *  merge gate reads them: a job that may not fail and failed (or was
 *  cancelled) fails it; one not finished, a job list not read whole, or a
 *  status not final holds it pending. Pure. */
export function gitlabPipelineVerdict(pipeline: unknown): WatchChecks {
  const p = rec(pipeline);
  if (!p) return 'pending';
  const jobs = rec(p.jobs);
  const nodes = Array.isArray(jobs?.nodes) ? (jobs.nodes as unknown[]) : [];
  const buckets = nodes.flatMap((n) => {
    const j = rec(n);
    return j && j.allowFailure !== true ? [glabJobBucket(j.status, false)] : [];
  });
  if (buckets.some((b) => b === 'fail' || b === 'cancel')) return 'fail';
  if (buckets.some((b) => b === 'pending')) return 'pending';
  if (rec(jobs?.pageInfo)?.hasNextPage !== false || nodes.some((n) => !rec(n))) return 'pending';
  const rollup = mapGlabPipelineStatus(str(p.status));
  return rollup === 'passing' ? 'pass' : rollup === 'failing' ? 'fail' : 'pending';
}

/** The MR's checks: its head pipeline's verdict when that pipeline ran on
 *  the head. A merged-results (or merge-train) pipeline of another commit
 *  comes back `unconfirmed`, pending until its parents are read; any other
 *  pipeline of another commit is stale, so pending. Pure. */
export function gitlabChecksOf(pipeline: unknown, headSha: string): { checks: WatchChecks; unconfirmed?: { pipelineSha: string; verdict: 'pass' | 'fail' } } {
  const p = rec(pipeline);
  if (!p) return { checks: 'pending' };
  const sha = str(p.sha);
  const verdict = gitlabPipelineVerdict(p);
  if (sha === headSha) return { checks: verdict };
  const type = str(p.mergeRequestEventType).toUpperCase();
  if (!sha || verdict === 'pending' || (type !== 'MERGED_RESULT' && type !== 'MERGE_TRAIN')) return { checks: 'pending' };
  return { checks: 'pending', unconfirmed: { pipelineSha: sha, verdict } };
}

function mapMr(raw: unknown): { pr: WatchPr; unconfirmed?: UnconfirmedChecks } | null {
  const m = rec(raw);
  const number = iidOf(m?.iid);
  if (!m || number === null || typeof m.diffHeadSha !== 'string' || !m.diffHeadSha) return null;
  const rawState = str(m.state).toLowerCase();
  const { labels, truncated } = labelsOf(m.labels);
  const { checks, unconfirmed } = gitlabChecksOf(m.headPipeline, m.diffHeadSha);
  return {
    pr: {
      number,
      title: str(m.title).slice(0, REPO_WATCH_LIMITS.TITLE_MAX),
      createdAt: timeOf(m.createdAt),
      state: rawState === 'opened' ? 'OPEN' : rawState.toUpperCase() || 'OPEN',
      isDraft: m.draft === true,
      headSha: m.diffHeadSha,
      headRefName: str(m.sourceBranch),
      // Unreadable project ids read as a fork: the cautious side.
      isCrossRepository: !(typeof m.sourceProjectId === 'number' && m.sourceProjectId === m.targetProjectId),
      mergeStateStatus: glabMergeState(m.detailedMergeStatus, m.conflicts).mergeStateStatus,
      author: str(rec(m.author)?.username) || null,
      labels,
      labelsTruncated: truncated,
      checks,
    },
    ...(unconfirmed ? { unconfirmed: { pr: number, ...unconfirmed } } : {}),
  };
}

function mapIssue(raw: unknown): WatchIssue | null {
  const i = rec(raw);
  const number = iidOf(i?.iid);
  if (!i || number === null) return null;
  const { labels, truncated } = labelsOf(i.labels);
  return {
    number,
    title: str(i.title).slice(0, REPO_WATCH_LIMITS.TITLE_MAX),
    createdAt: timeOf(i.createdAt),
    author: str(rec(i.author)?.username) || null,
    labels,
    labelsTruncated: truncated,
  };
}

interface MrPage { prs: WatchPr[]; unconfirmed: UnconfirmedChecks[]; total: number; hasNext: boolean; cursor: string | null }

function mapMrPage(conn: unknown, paged: boolean): MrPage | null {
  const c = rec(conn);
  if (!c || typeof c.count !== 'number' || !Array.isArray(c.nodes)) return null;
  const mapped = c.nodes.flatMap((n) => { const m = mapMr(n); return m ? [m] : []; });
  const info = rec(c.pageInfo);
  return {
    prs: mapped.map((m) => m.pr),
    unconfirmed: mapped.flatMap((m) => (m.unconfirmed ? [m.unconfirmed] : [])),
    total: c.count,
    hasNext: paged && info?.hasNextPage === true,
    cursor: str(info?.endCursor) || null,
  };
}

/** GITLAB_WATCH_QUERY's answer as a snapshot (first page only), or null when
 *  it is not one. A merged-results verdict is left pending in the snapshot
 *  and listed in `unconfirmed`. */
export function mapGitlabWatchAnswer(raw: unknown): { snapshot: WatchSnapshot; next: string | null; unconfirmed: UnconfirmedChecks[] } | null {
  const project = rec(rec(rec(raw)?.data)?.project);
  if (!project) return null;
  const open = mapMrPage(project.open, true);
  const locked = mapMrPage(project.locked, false);
  const issues = rec(project.issues);
  if (!open || !locked || !issues || typeof issues.count !== 'number' || !Array.isArray(issues.nodes)) return null;
  const recent: Record<string, string> = {};
  for (const [alias, state] of [['closed', 'CLOSED'], ['merged', 'MERGED']] as const) {
    const nodes = rec(project[alias])?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const n of nodes) {
      const iid = iidOf(rec(n)?.iid);
      if (iid !== null) recent[String(iid)] = state;
    }
  }
  const seen = new Set(open.prs.map((p) => p.number));
  const lockedPrs = locked.prs.filter((p) => !seen.has(p.number));
  return {
    snapshot: {
      prs: [...open.prs, ...lockedPrs],
      prTotal: open.total + locked.total,
      recent,
      issues: issues.nodes.flatMap((n) => { const i = mapIssue(n); return i ? [i] : []; }),
      issueTotal: issues.count,
    },
    next: open.hasNext ? open.cursor : null,
    unconfirmed: [...open.unconfirmed, ...locked.unconfirmed.filter((u) => !seen.has(u.pr))],
  };
}

/** GITLAB_WATCH_PAGE_QUERY's answer, or null. */
export function mapGitlabWatchPage(raw: unknown): { prs: WatchPr[]; unconfirmed: UnconfirmedChecks[] } | null {
  const page = mapMrPage(rec(rec(rec(raw)?.data)?.project)?.open, true);
  return page ? { prs: page.prs, unconfirmed: page.unconfirmed } : null;
}

export type GitlabWatchRead =
  | { ok: true; snapshot: WatchSnapshot; calls: number }
  | { ok: false; message: string; calls: number; backoff: boolean };

/**
 * One poll of a GitLab project: the snapshot, with each merged-results
 * verdict settled. A verdict of a baseline, or one the saved state already
 * holds for the same head, is kept without a read; any other is confirmed by its merge commit's
 * parents (`parents`: remembered across polls, at most PARENT_READS new
 * reads per poll) or left pending.
 */
export async function readGitlabSnapshot(
  ports: GitlabWatchPorts,
  repoPath: string,
  repoKey: string,
  prev: RepoWatchState | undefined,
  parents: Map<string, string[]>,
): Promise<GitlabWatchRead> {
  const vars = { fullPath: repoKey.split('/').slice(1).join('/') };
  let calls = 1;
  const fail = (r: Exclude<GitlabWatchAnswer, { ok: true }>): GitlabWatchRead => ({
    ok: false, message: r.message, calls, backoff: r.code === 'cli-missing' || r.code === 'unauthenticated',
  });
  const read = await ports.graphql(repoPath, repoKey, GITLAB_WATCH_QUERY, vars);
  if (!read.ok) return fail(read);
  const first = mapGitlabWatchAnswer(read.value);
  if (!first) return { ok: false, message: 'unexpected answer', calls, backoff: false };
  const { snapshot, unconfirmed } = first;
  if (first.next && snapshot.prs.length < REPO_WATCH_LIMITS.MAX_OPEN_PRS) {
    calls++;
    const page = await ports.graphql(repoPath, repoKey, GITLAB_WATCH_PAGE_QUERY, { ...vars, after: first.next });
    if (!page.ok) return fail(page);
    const more = mapGitlabWatchPage(page.value);
    if (!more) return { ok: false, message: 'unexpected answer', calls, backoff: false };
    const seen = new Set(snapshot.prs.map((p) => p.number));
    const added = more.prs.filter((p) => !seen.has(p.number)).slice(0, REPO_WATCH_LIMITS.MAX_OPEN_PRS - snapshot.prs.length);
    snapshot.prs.push(...added);
    const kept = new Set(added.map((p) => p.number));
    unconfirmed.push(...more.unconfirmed.filter((u) => kept.has(u.pr)));
  }
  let reads: number = GITLAB_WATCH_LIMITS.PARENT_READS;
  for (const u of unconfirmed) {
    const pr = snapshot.prs.find((p) => p.number === u.pr);
    if (!pr) continue;
    const was = prev?.prs[String(u.pr)];
    // A baseline emits nothing: its verdicts are recorded as read, as a
    // GitHub baseline records a head already green, so none is announced
    // later just because its parents were read later.
    if (!prev || (was && was.headSha === pr.headSha && was.checks === u.verdict)) {
      pr.checks = u.verdict;
      continue;
    }
    let known = parents.get(u.pipelineSha);
    if (!known && reads > 0) {
      reads--;
      calls++;
      const got = await ports.commitParents(repoPath, repoKey, u.pipelineSha);
      // An unreadable commit (no parents) is asked again next poll.
      if (got.length > 0) {
        known = got;
        parents.set(u.pipelineSha, got);
        while (parents.size > GITLAB_WATCH_LIMITS.PARENTS_KEPT) {
          const oldest = parents.keys().next().value;
          if (oldest === undefined) break;
          parents.delete(oldest);
        }
      }
    }
    if (known?.includes(pr.headSha)) pr.checks = u.verdict;
  }
  return { ok: true, snapshot, calls };
}

/** A RepoWatch's GitLab read (RepoWatchPorts.gitlab). */
export type GitlabWatchReader = (repoPath: string, repoKey: string, prev: RepoWatchState | undefined) => Promise<GitlabWatchRead>;

/** The reader over these ports; the merge commits' parents it reads are
 *  remembered for its life. */
export function gitlabWatchReader(ports: GitlabWatchPorts): GitlabWatchReader {
  const parents = new Map<string, string[]>();
  return (repoPath, repoKey, prev) => readGitlabSnapshot(ports, repoPath, repoKey, prev, parents);
}
