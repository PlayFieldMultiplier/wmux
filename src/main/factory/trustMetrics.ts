// ─── Trust metrics — revert rate and 1-week survival of merged PRs ─────────
//
// The main-process port of scripts/lib/trust-metrics.mjs (the CLI's rules):
// the same pure functions over `git log --first-parent` records, so Moa's
// `trustMetrics.read` and the morning report give the numbers the CLI gives
// on the same log. The .mjs stays the CLI's; the main bundle imports this
// file instead. Definitions (identical to the CLI):
//   merged PR      a first-parent commit on main that names a PR: a squash
//                  subject ending `(#N)` or `Merge pull request #N from ...`
//   revert commit  subject `Revert "..."` / `Reapply "..."`, or a body line
//                  `This reverts commit <sha>`
//   revert PR      a merged PR whose commit is a revert commit; reported on
//                  its own and left out of the revert-rate denominator
//   reverted       a later revert commit on main undid the PR's commit; a
//                  revert of that revert re-applies it (chains are followed)
//   survived 7d    merged at least 7 days ago and still in main 7 days later
// Only `git revert` is seen; a change undone by hand or in part is not.
//
// `readTrustMetrics` reads the log itself and refuses a shallow clone whose
// oldest commit is inside the window (the counts would look complete).

export const DAY_MS = 86_400_000;
export const SURVIVAL_DAYS = 7;

const REC = '\x1e';
const FIELD = '\x00';

/** The `git log` format parseGitLog reads. */
export const GIT_LOG_FORMAT = '%H%x00%ct%x00%s%x00%b%x1e';

export interface TrustCommit {
  sha: string;
  /** Commit time, epoch ms. */
  at: number;
  subject: string;
  body: string;
}

export interface TrustPrRow {
  pr: number;
  sha: string;
  mergedAt: number;
  subject: string;
  reverted: boolean;
  revertedBy: string | null;
  inMainNow: boolean;
  timeToRevertMs: number | null;
  survival7d: boolean | null;
}

export interface TrustRevertPr {
  pr: number;
  sha: string;
  mergedAt: number;
  subject: string;
}

export interface TrustTotals {
  merged: number;
  revertPrs: number;
  reverted: number;
  revertRate: number | null;
  eligible7d: number;
  survived7d: number;
  survivalRate7d: number | null;
  medianTimeToRevertHours: number | null;
}

export interface TrustAnalysis {
  since: number;
  now: number;
  totals: TrustTotals;
  reverted: TrustPrRow[];
  revertPrs: TrustRevertPr[];
}

/** `git log --format=GIT_LOG_FORMAT` output → commits, newest first as git prints them. */
export function parseGitLog(raw: string): TrustCommit[] {
  return raw
    .split(REC)
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.includes(FIELD))
    .map((r) => {
      const [sha, ct, subject, body = ''] = r.split(FIELD);
      return { sha: sha.trim(), at: Number(ct) * 1000, subject, body };
    });
}

/** The PR a first-parent commit merged, from its subject, or null. */
export function prNumberOf(subject: string): number | null {
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  if (squash) return Number(squash[1]);
  const merge = /^Merge pull request #(\d+) from /.exec(subject);
  return merge ? Number(merge[1]) : null;
}

/** What a commit reverts, or null when it is not a revert. */
export function revertTarget(commit: Pick<TrustCommit, 'subject' | 'body'>): { sha: string | null; pr: number | null } | null {
  const quoted = /^(?:Revert|Reapply) "(.*)"/.exec(commit.subject);
  const body = /This reverts commit ([0-9a-f]{7,40})/.exec(commit.body);
  if (!quoted && !body) return null;
  return { sha: body ? body[1] : null, pr: quoted ? prNumberOf(quoted[1]) : null };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface Row extends TrustCommit {
  seq: number;
  pr: number | null;
  target: { sha: string | null; pr: number | null } | null;
}

interface RevertEvent { at: number; seq: number; reverted: boolean; by: string }

/**
 * Rows and totals for the PRs merged at or after `since`. `commits`: every
 * first-parent commit from `since` to now, newest first as `git log
 * --first-parent` prints them; that order breaks same-second ties.
 * `prOf(sha)`: optional resolver for a commit whose subject names no PR.
 */
export function analyze(
  commits: readonly TrustCommit[],
  opts: { since: number; now: number; prOf?: (sha: string) => number | null },
): TrustAnalysis {
  const { since, now } = opts;
  const prOf = opts.prOf ?? (() => null);
  const bySha = new Map<string, Row>();
  const byPr = new Map<number, Row>();
  const byOrder = (a: { at: number; seq: number }, b: { at: number; seq: number }) => a.at - b.at || a.seq - b.seq;
  const ordered = commits.map((c, i) => ({ ...c, seq: commits.length - i })).sort(byOrder);
  for (const c of ordered) {
    const pr = prNumberOf(c.subject) ?? prOf(c.sha);
    const row: Row = { ...c, pr, target: revertTarget(c) };
    bySha.set(c.sha, row);
    if (pr !== null && !byPr.has(pr)) byPr.set(pr, row);
  }
  const find = (sha: string): Row | null => {
    const exact = bySha.get(sha);
    if (exact) return exact;
    for (const [k, v] of bySha) if (k.startsWith(sha)) return v;
    return null;
  };
  const resolve = (t: { sha: string | null; pr: number | null }): Row | null =>
    (t.sha ? find(t.sha) : null) ?? (t.pr !== null ? byPr.get(t.pr) ?? null : null);

  // Every revert commit flips the root it ultimately points at: an odd depth
  // undoes the original change, an even depth re-applies it.
  const events = new Map<string, RevertEvent[]>();
  for (const c of bySha.values()) {
    if (!c.target) continue;
    let node: Row | null = c;
    let depth = 0;
    const seen = new Set<string>();
    while (node?.target && !seen.has(node.sha)) {
      seen.add(node.sha);
      node = resolve(node.target);
      depth += 1;
    }
    if (!node || node.target) continue; // points outside the log, or a cycle
    const list = events.get(node.sha) ?? [];
    list.push({ at: c.at, seq: c.seq, reverted: depth % 2 === 1, by: c.sha });
    events.set(node.sha, list);
  }

  const revertedAt = (sha: string, until: number): boolean => {
    let state = false;
    for (const e of (events.get(sha) ?? []).filter((x) => x.at <= until).sort(byOrder)) state = e.reverted;
    return state;
  };

  const prs: TrustPrRow[] = [];
  const revertPrs: TrustRevertPr[] = [];
  for (const c of bySha.values()) {
    if (c.at < since || c.pr === null) continue;
    if (c.target) {
      revertPrs.push({ pr: c.pr, sha: c.sha, mergedAt: c.at, subject: c.subject });
      continue;
    }
    const evs = (events.get(c.sha) ?? []).sort(byOrder);
    const first = evs.find((e) => e.reverted) ?? null;
    const eligible = c.at <= now - SURVIVAL_DAYS * DAY_MS;
    prs.push({
      pr: c.pr,
      sha: c.sha,
      mergedAt: c.at,
      subject: c.subject,
      reverted: first !== null,
      revertedBy: first?.by ?? null,
      inMainNow: !revertedAt(c.sha, now),
      timeToRevertMs: first ? first.at - c.at : null,
      survival7d: eligible ? !revertedAt(c.sha, c.at + SURVIVAL_DAYS * DAY_MS) : null,
    });
  }
  prs.sort((a, b) => a.mergedAt - b.mergedAt);

  const reverted = prs.filter((p) => p.reverted);
  const eligible = prs.filter((p) => p.survival7d !== null);
  const survived = eligible.filter((p) => p.survival7d);
  const medianMs = median(reverted.map((p) => p.timeToRevertMs ?? 0));
  return {
    since,
    now,
    totals: {
      merged: prs.length,
      revertPrs: revertPrs.length,
      reverted: reverted.length,
      revertRate: prs.length ? reverted.length / prs.length : null,
      eligible7d: eligible.length,
      survived7d: survived.length,
      survivalRate7d: eligible.length ? survived.length / eligible.length : null,
      medianTimeToRevertHours: medianMs === null ? null : medianMs / 3_600_000,
    },
    reverted,
    revertPrs,
  };
}

// ── Reading a repository ────────────────────────────────────────────────────

/** `git <args>` in `cwd`: stdout, or a thrown error. */
export type TrustGit = (args: string[], cwd: string) => Promise<string>;

export type TrustReadResult =
  | { ok: true; ref: string; unattributedCommits: number; analysis: TrustAnalysis }
  | { ok: false; code: 'shallow' | 'git_failed'; message: string };

const REF_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

/**
 * The trust metrics of `ref` (default `origin/main`) in `repoPath` for the
 * window starting at `since`. A shallow clone whose oldest commit on `ref` is
 * not older than `since` is refused: part of the window would be missing.
 */
export async function readTrustMetrics(
  repoPath: string,
  opts: { since: number; now: number; ref?: string; git: TrustGit },
): Promise<TrustReadResult> {
  const ref = opts.ref ?? 'origin/main';
  if (!REF_RE.test(ref)) return { ok: false, code: 'git_failed', message: 'not a ref name' };
  try {
    const shallow = (await opts.git(['rev-parse', '--is-shallow-repository'], repoPath)).trim();
    if (shallow === 'true') {
      const all = (await opts.git(['log', '--first-parent', ref, '--format=%ct'], repoPath)).trim().split('\n');
      const oldest = Number(all[all.length - 1]) * 1000;
      if (!(oldest < opts.since)) {
        return {
          ok: false,
          code: 'shallow',
          message: `the clone is shallow and starts ${Number.isFinite(oldest) ? new Date(oldest).toISOString().slice(0, 10) : 'at an unknown date'}, inside the window; fetch deeper first`,
        };
      }
    }
    const raw = await opts.git(
      ['log', '--first-parent', ref, `--since=${Math.floor(opts.since / 1000)}`, `--format=${GIT_LOG_FORMAT}`],
      repoPath,
    );
    const commits = parseGitLog(raw);
    const analysis = analyze(commits, { since: opts.since, now: opts.now });
    const unattributedCommits = commits.filter((c) => c.at >= opts.since && prNumberOf(c.subject) === null).length;
    return { ok: true, ref, unattributedCommits, analysis };
  } catch (err) {
    return { ok: false, code: 'git_failed', message: err instanceof Error ? err.message.slice(0, 300) : 'git failed' };
  }
}
