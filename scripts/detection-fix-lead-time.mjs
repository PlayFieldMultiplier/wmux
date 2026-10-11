#!/usr/bin/env node
// Agent-status detection fix lead time (PRD E0 R0-4).
//
// How many releases' worth of "the pane showed the wrong state" fixes shipped,
// and how long each took from report to release. The rule that picks those
// fixes out of CHANGELOG.md is fixed (scripts/lib/detection-fixes.mjs), and
// `--list` prints every entry it picked, so the count can be audited and
// re-run.
//
// For each picked entry:
//   reported  the earliest issue it cites, or that a PR it cites closes
//   opened    the earliest PR it cites, opened (the fix started)
//   merged    the latest merge among the PRs it cites and the PRs that closed
//             the issues it cites (an entry citing nothing is traced to the
//             PR that added it to the changelog)
//   released  the release's tag date (the CHANGELOG date if there is no tag)
// and reports report → release, report → merge, merge → release (the wait a
// detection hotfix outside the app release would remove), and PR open →
// release for the entries that cite no issue.
//
// Usage: node scripts/detection-fix-lead-time.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--list] [--json]
//   default window: the 90 days up to the newest release
// Needs `gh` signed in (GitHub GraphQL) and the release tags fetched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daysBetween, entryDates, isDetectionFix, parseChangelog, percentile } from './lib/detection-fixes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const LIST = argv.includes('--list');
const JSON_OUT = argv.includes('--json');

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();

function repoSlug() {
  const url = run('git', ['remote', 'get-url', 'origin']);
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/.exec(url);
  if (!m) throw new Error(`origin is not a GitHub remote: ${url}`);
  return { owner: m[1], name: m[2] };
}

/** Annotated tag date of vX.Y.Z, or null. */
function tagDate(version) {
  try {
    return run('git', ['for-each-ref', `refs/tags/v${version}`, '--format=%(creatordate:iso-strict)']) || null;
  } catch {
    return null;
  }
}

/** The PR that first added `title` to the changelog (a fragment or CHANGELOG.md), or null. */
function prThatAdded(title, slug) {
  const needle = title.slice(0, 60);
  const shas = run('git', ['log', '--reverse', '--format=%H', '-S', needle, '--', 'CHANGELOG.md', 'changelog.d']).split('\n').filter(Boolean);
  for (const sha of shas) {
    const prs = JSON.parse(run('gh', ['api', `repos/${slug.owner}/${slug.name}/commits/${sha}/pulls`]));
    const merged = prs.filter((p) => p.merged_at).map((p) => p.number);
    if (merged.length > 0) return merged[0];
  }
  return null;
}

/** number → issue/PR facts, from GitHub GraphQL in batches. */
function fetchItems(numbers, slug) {
  const items = new Map();
  const list = [...new Set(numbers)];
  for (let i = 0; i < list.length; i += 40) {
    const batch = list.slice(i, i + 40);
    const fields = batch.map((n) => `n${n}: issueOrPullRequest(number: ${n}) {
      __typename
      ... on Issue { createdAt closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { mergedAt } } }
      ... on PullRequest { createdAt mergedAt closingIssuesReferences(first: 10) { nodes { createdAt } } }
    }`).join('\n');
    const query = `query { repository(owner: "${slug.owner}", name: "${slug.name}") { ${fields} } }`;
    const repo = JSON.parse(run('gh', ['api', 'graphql', '-f', `query=${query}`])).data.repository;
    for (const n of batch) {
      const it = repo[`n${n}`];
      if (!it) continue;
      items.set(n, it.__typename === 'PullRequest'
        ? { type: 'PullRequest', createdAt: it.createdAt, mergedAt: it.mergedAt, closes: it.closingIssuesReferences.nodes }
        : { type: 'Issue', createdAt: it.createdAt, closedBy: it.closedByPullRequestsReferences.nodes });
    }
  }
  return items;
}

function stats(xs) {
  return { n: xs.length, median: percentile(xs, 50), p90: percentile(xs, 90) };
}

const day = (d) => (d === null ? '-' : `${d.toFixed(1)}d`);

function main() {
  const releases = parseChangelog(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')).filter((r) => r.date);
  const until = flag('--until') ?? releases[0].date;
  const since = flag('--since') ?? new Date(Date.parse(until) - 90 * 86_400_000).toISOString().slice(0, 10);
  const inWindow = releases.filter((r) => r.date >= since && r.date <= until);
  const slug = repoSlug();

  const entries = [];
  for (const r of inWindow) {
    const releasedAt = tagDate(r.version) ?? `${r.date}T00:00:00Z`;
    for (const f of r.fixed.filter((x) => isDetectionFix(x.title))) {
      const refs = f.refs.length > 0 ? f.refs : [prThatAdded(f.title, slug)].filter((n) => n !== null);
      entries.push({ version: r.version, releasedAt, title: f.title, refs, traced: f.refs.length === 0 && refs.length > 0 });
    }
  }
  const items = fetchItems(entries.flatMap((e) => e.refs), slug);
  for (const e of entries) Object.assign(e, entryDates(e.refs, items));

  const report = {
    window: { since, until, releases: inWindow.length },
    rule: 'scripts/lib/detection-fixes.mjs isDetectionFix (Fixed entry titles)',
    entries: entries.length,
    withIssue: entries.filter((e) => e.reportedAt).length,
    withMergedPr: entries.filter((e) => e.mergedAt).length,
    unresolved: entries.filter((e) => !e.reportedAt && !e.mergedAt).length,
    reportToRelease: stats(entries.map((e) => daysBetween(e.reportedAt, e.releasedAt)).filter((d) => d !== null)),
    reportToMerge: stats(entries.map((e) => daysBetween(e.reportedAt, e.mergedAt)).filter((d) => d !== null)),
    mergeToRelease: stats(entries.map((e) => daysBetween(e.mergedAt, e.releasedAt)).filter((d) => d !== null)),
    openToRelease: stats(entries.map((e) => daysBetween(e.openedAt, e.releasedAt)).filter((d) => d !== null)),
    perRelease: inWindow.map((r) => ({ version: r.version, date: r.date, fixes: entries.filter((e) => e.version === r.version).length })).filter((r) => r.fixes > 0),
    list: entries,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const row = (label, s) => `  ${label.padEnd(18)} ${String(s.n).padStart(3)}   median ${day(s.median).padStart(7)}   p90 ${day(s.p90).padStart(7)}`;
  console.log([
    `detection-fix lead time  ${since} → ${until}  (${inWindow.length} releases)`,
    `  rule: ${report.rule}`,
    `  entries ${report.entries}: citing or closing an issue ${report.withIssue}, with a merged PR ${report.withMergedPr}, unresolved ${report.unresolved}`,
    row('report → release', report.reportToRelease),
    row('report → merge', report.reportToMerge),
    row('merge → release', report.mergeToRelease),
    row('PR open → release', report.openToRelease),
    `  per release: ${report.perRelease.map((r) => `${r.version} ${r.fixes}`).join(' · ')}`,
  ].join('\n'));
  if (LIST) {
    console.log('');
    for (const e of entries) {
      console.log(`  ${e.version.padEnd(8)} ${e.refs.map((n) => `#${n}`).join(',').padEnd(12)}${e.traced ? '*' : ' '} report→release ${day(daysBetween(e.reportedAt, e.releasedAt)).padStart(6)}  merge→release ${day(daysBetween(e.mergedAt, e.releasedAt)).padStart(6)}  ${e.title.slice(0, 90)}`);
    }
    console.log('  * traced to the PR that added the entry (it cites no number)');
  }
}

main();
