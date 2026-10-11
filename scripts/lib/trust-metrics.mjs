// Trust metrics over merged PRs: revert rate and 1-week survival.
//
// Pure functions over `git log --first-parent` records, so the rules can be
// tested on a fixture and the script (scripts/trust-metrics.mjs) only reads.
//
// Definitions (printed by the script too):
//   merged PR      a first-parent commit on main that names a PR: a squash
//                  subject ending `(#N)` or `Merge pull request #N from ...`
//   revert commit  subject `Revert "..."` / `Reapply "..."`, or a body line
//                  `This reverts commit <sha>` (git revert writes both)
//   revert PR      a merged PR whose commit is a revert commit; it is reported
//                  on its own and left out of the revert-rate denominator
//   reverted       a later revert commit on main undid the PR's commit; a
//                  revert of that revert re-applies it (chains are followed)
//   survived 7d    the PR merged at least 7 days ago and its change was in main
//                  7 days after the merge (never reverted then, or re-applied)
// Not seen: a change undone by hand instead of `git revert`, or undone only in
// part. Those are invisible to every rule here.

export const DAY_MS = 86_400_000;
export const SURVIVAL_DAYS = 7;

const REC = '\x1e';
const FIELD = '\x00';

/** The `git log` format parseGitLog reads. */
export const GIT_LOG_FORMAT = '%H%x00%ct%x00%s%x00%b%x1e';

/** `git log --format=GIT_LOG_FORMAT` output → commits, newest first as git prints them. */
export function parseGitLog(raw) {
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
export function prNumberOf(subject) {
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  if (squash) return Number(squash[1]);
  const merge = /^Merge pull request #(\d+) from /.exec(subject);
  return merge ? Number(merge[1]) : null;
}

/**
 * What a commit reverts, or null when it is not a revert.
 *   sha: from `This reverts commit <sha>` (the reliable key)
 *   pr:  the PR the quoted subject names, a fallback when the body
 *        was edited away (the quoted subject is the reverted commit's own)
 */
export function revertTarget(commit) {
  const quoted = /^(?:Revert|Reapply) "(.*)"/.exec(commit.subject);
  const body = /This reverts commit ([0-9a-f]{7,40})/.exec(commit.body);
  if (!quoted && !body) return null;
  return { sha: body ? body[1] : null, pr: quoted ? prNumberOf(quoted[1]) : null };
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Rows and totals for the PRs merged at or after `since`.
 * `commits`: every first-parent commit from `since` to now, newest first as
 * `git log --first-parent` prints them; that order breaks same-second ties.
 * `prOf(sha)`: optional resolver for a commit whose subject names no PR.
 */
export function analyze(commits, { since, now, prOf = () => null }) {
  const bySha = new Map();
  const byPr = new Map();
  // Oldest first; `seq` keeps main's own order when two commits share a second.
  const byOrder = (a, b) => a.at - b.at || a.seq - b.seq;
  const ordered = commits.map((c, i) => ({ ...c, seq: commits.length - i })).sort(byOrder);
  for (const c of ordered) {
    const pr = prNumberOf(c.subject) ?? prOf(c.sha);
    const row = { ...c, pr, target: revertTarget(c) };
    bySha.set(c.sha, row);
    if (pr !== null && !byPr.has(pr)) byPr.set(pr, row);
  }
  const find = (sha) => {
    if (bySha.has(sha)) return bySha.get(sha);
    for (const [k, v] of bySha) if (k.startsWith(sha)) return v;
    return null;
  };
  const resolve = (t) => (t.sha ? find(t.sha) : null) ?? (t.pr !== null ? byPr.get(t.pr) ?? null : null);

  // Every revert commit flips the root it ultimately points at: an odd depth
  // undoes the original change, an even depth (a revert of a revert) re-applies it.
  const events = new Map(); // root sha → [{ at, reverted }]
  for (const c of bySha.values()) {
    if (!c.target) continue;
    let node = c;
    let depth = 0;
    const seen = new Set();
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

  const revertedAt = (sha, until) => {
    let state = false;
    for (const e of (events.get(sha) ?? []).filter((x) => x.at <= until).sort(byOrder)) state = e.reverted;
    return state;
  };

  const prs = [];
  const revertPrs = [];
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
      medianTimeToRevertHours: (() => {
        const m = median(reverted.map((p) => p.timeToRevertMs));
        return m === null ? null : m / 3_600_000;
      })(),
    },
    reverted,
    revertPrs,
  };
}

/** `30d` / `2w` / `YYYY-MM-DD` → epoch ms. */
export function parseSince(value, now) {
  const rel = /^(\d+)([dw])$/.exec(value);
  if (rel) return now - Number(rel[1]) * (rel[2] === 'w' ? 7 : 1) * DAY_MS;
  const abs = Date.parse(value);
  if (Number.isNaN(abs)) throw new Error(`--since: expected Nd, Nw or YYYY-MM-DD, got ${value}`);
  return abs;
}
