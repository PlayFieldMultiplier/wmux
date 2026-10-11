#!/usr/bin/env node
// Trust metrics for merged PRs: revert rate and 1-week survival.
//
// Is the work that lands on main kept? For every PR merged into main in the
// window it reports how many were later reverted (by `git revert`, followed
// through revert-of-revert chains), the median time to that revert, and the
// share of PRs merged at least 7 days ago whose change was still in main 7 days
// after the merge. The rules live in scripts/lib/trust-metrics.mjs.
//
// Usage: node scripts/trust-metrics.mjs [--since 30d|4w|YYYY-MM-DD] [--ref origin/main] [--json] [--no-gh]
//   --since  window start (default 30d)
//   --ref    the main line to read (default origin/main; fetch first)
//   --json   print the result object instead of the table
//   --no-gh  do not ask GitHub for the PR of a commit whose subject names none
// Read-only: `git log` always, and `gh api .../commits/<sha>/pulls` only for
// the few first-parent commits whose subject carries no PR number.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, DAY_MS, GIT_LOG_FORMAT, parseGitLog, parseSince, prNumberOf, SURVIVAL_DAYS } from './lib/trust-metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const JSON_OUT = argv.includes('--json');
const USE_GH = !argv.includes('--no-gh');
const REF = flag('--ref', 'origin/main');
const SINCE_ARG = flag('--since', '30d');

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function repoSlug() {
  const url = run('git', ['remote', 'get-url', 'origin']).trim();
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

const now = Date.now();
const since = parseSince(SINCE_ARG, now);
const commits = parseGitLog(
  run('git', ['log', '--first-parent', REF, `--since=${Math.floor(since / 1000)}`, `--format=${GIT_LOG_FORMAT}`]),
);

// A commit whose subject names no PR (an edited squash title, a direct push):
// ask GitHub which PR, if any, carried it.
const slug = USE_GH ? repoSlug() : null;
const ghPr = new Map();
if (slug) {
  for (const c of commits) {
    if (prNumberOf(c.subject) !== null) continue;
    try {
      const n = run('gh', ['api', `repos/${slug}/commits/${c.sha}/pulls`, '--jq', '[.[] | select(.merged_at != null)][0].number // empty']).trim();
      if (/^\d+$/.test(n)) ghPr.set(c.sha, Number(n));
    } catch {
      /* offline or not signed in: the commit stays unattributed */
    }
  }
}

const result = analyze(commits, { since, now, prOf: (sha) => ghPr.get(sha) ?? null });
const unattributed = commits.filter((c) => c.at >= since && prNumberOf(c.subject) === null && !ghPr.has(c.sha)).length;

if (JSON_OUT) {
  console.log(JSON.stringify({ ref: REF, unattributedCommits: unattributed, ...result }, null, 2));
  process.exit(0);
}

const t = result.totals;
const pct = (x) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const rows = [
  ['window', `${day(since)} .. ${day(now)} (${REF})`],
  ['merged PRs', String(t.merged)],
  ['revert PRs (excluded)', String(t.revertPrs)],
  ['reverted', String(t.reverted)],
  ['revert rate', pct(t.revertRate)],
  [`merged >= ${SURVIVAL_DAYS}d ago`, String(t.eligible7d)],
  [`survived ${SURVIVAL_DAYS}d`, `${t.survived7d} (${pct(t.survivalRate7d)})`],
  ['median time to revert', t.medianTimeToRevertHours === null ? '-' : `${t.medianTimeToRevertHours.toFixed(1)}h`],
];
if (unattributed > 0) rows.push(['commits with no PR', String(unattributed)]);
const w = Math.max(...rows.map(([k]) => k.length));
console.log(rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n'));
if (result.reverted.length > 0) {
  console.log('\nreverted PRs:');
  for (const p of result.reverted) {
    const after = (p.timeToRevertMs / DAY_MS).toFixed(1);
    console.log(`  #${p.pr}  merged ${day(p.mergedAt)}  reverted after ${after}d by ${p.revertedBy.slice(0, 9)}${p.inMainNow ? ' (re-applied)' : ''}`);
  }
}
console.log('\nOnly `git revert` is seen; a change undone by hand or in part is not.');
