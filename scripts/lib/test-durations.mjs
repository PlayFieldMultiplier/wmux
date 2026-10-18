// Test file durations: what CI records, what is checked in, and how the shards
// are cut from it.
//
// Vitest's own `--shard` (BaseSequencer.shard in vitest 5) sorts the files by
// a hash of their path and gives every shard the same number of files. With a
// few files that take minutes and many that take milliseconds, equal counts
// are far from equal time: on main the integration lane's shards took 447 s
// and 235 s. scripts/lib/duration-sequencer.mjs cuts the shards by duration
// instead, reading vitest.durations.json, which this module renders.
//
// Where the numbers come from: scripts/vitest-retry-reporter.mjs (CI only)
// writes test-results/durations-<project>.json for every project that ran, and
// those files are uploaded with the test-report-* artifacts. Download a few
// runs and `node scripts/test-durations.mjs --write <dir>` takes the median of
// each file across them. A duration is TestModule.diagnostic().duration: the
// time of the file's tests and hooks, the same number vitest keeps in its own
// results cache. It leaves out the import and environment time, so the
// balancer adds a fixed FILE_COST_MS to every file.
//
// Report format (version 1), one per project that ran:
//   {
//     "version": 1,
//     "project": "integration",
//     "shard": "1/2",                // null when not sharded
//     "platform": "linux",
//     "files": { "src/x/__tests__/a.test.ts": 1234.5 }
//   }
//
// vitest.durations.json: { "integration": { "<path>": ms }, "unit": { ... } },
// keys sorted, values rounded to 100 ms, so a refresh diffs cleanly.

import fs from 'node:fs';
import path from 'node:path';

export const DURATIONS_VERSION = 1;
export const DURATIONS_PREFIX = 'durations-';
export const DURATIONS_FILE_NAME = 'vitest.durations.json';

/**
 * Added to every file's weight when balancing. `duration` counts only tests
 * and hooks; importing the file and setting up its environment cost something
 * too, and half the unit files record under 50 ms, so without this the
 * balancer would treat hundreds of files as free and pile them on one shard.
 */
export const FILE_COST_MS = 500;

/**
 * Every finished module's duration, grouped by the vitest project that ran it:
 * a Map from project name to { "<posix path>": ms }. Every project that ran a
 * module has an entry, an empty one included. A module that did not finish
 * (skipped, never started) has no real duration and is left out.
 * Duck-typed on the reporter API: TestModule.project.name / relativeModuleId /
 * state() / diagnostic().duration.
 */
export function collectDurations(testModules) {
  const byProject = new Map();
  for (const module of testModules) {
    const project = module.project?.name ?? '';
    if (!byProject.has(project)) byProject.set(project, {});
    const state = module.state?.();
    if (state && state !== 'passed' && state !== 'failed') continue;
    const duration = module.diagnostic?.()?.duration;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) continue;
    byProject.get(project)[toPosix(module.relativeModuleId)] = duration;
  }
  return byProject;
}

export function buildDurationsReport({ project, shard, platform, files }) {
  return {
    version: DURATIONS_VERSION,
    project,
    shard: shard ? `${shard.index}/${shard.count}` : null,
    platform,
    files: sortKeys(files),
  };
}

/** durations-*.json files under dir, searched recursively (one dir per run). */
export function findDurationReports(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith(DURATIONS_PREFIX) && entry.name.endsWith('.json')) found.push(full);
    }
  };
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) walk(dir);
  return found.sort();
}

export function readDurationsReport(file) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (report?.version !== DURATIONS_VERSION || typeof report.project !== 'string' || !isPlainObject(report.files)) {
    throw new Error(`${file}: not a version ${DURATIONS_VERSION} durations report`);
  }
  return report;
}

export function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The median duration of every file across reports, per project:
 * { project: { path: ms } }. Only the projects in `projects` are kept, and with
 * `testFiles` only the paths in it (a file deleted since is dropped).
 */
export function mergeDurationReports(reports, { projects, testFiles } = {}) {
  const samples = new Map();
  for (const report of reports) {
    if (projects && !projects.includes(report.project)) continue;
    if (!samples.has(report.project)) samples.set(report.project, new Map());
    const byFile = samples.get(report.project);
    for (const [file, ms] of Object.entries(report.files)) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
      if (testFiles && !testFiles.has(file)) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(ms);
    }
  }
  const out = {};
  for (const [project, byFile] of samples) {
    out[project] = {};
    for (const [file, values] of byFile) out[project][file] = median(values);
  }
  return out;
}

/**
 * Durations from vitest's local results cache
 * (node_modules/.vite/vitest/<hash>/results.json):
 * { version, results: [["<project>:<path>", { duration, failed }], ...] }
 * (an object of the same keys is read too). A key with no project name comes
 * from a run without `projects`; its lane is `integration` when the path is in
 * `integration` (vitest.lanes.json), else `unit`. Only `testFiles` are kept.
 */
export function durationsFromVitestCache(cache, { integration, testFiles }) {
  const integrationSet = new Set(integration);
  const entries = Array.isArray(cache?.results) ? cache.results : Object.entries(cache?.results ?? {});
  const out = { integration: {}, unit: {} };
  for (const [key, value] of entries) {
    const colon = key.indexOf(':');
    if (colon < 0) continue;
    const file = toPosix(key.slice(colon + 1));
    if (testFiles && !testFiles.has(file)) continue;
    const duration = value?.duration;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) continue;
    const named = key.slice(0, colon);
    const lane = named || (integrationSet.has(file) ? 'integration' : 'unit');
    if (!out[lane]) continue;
    out[lane][file] = duration;
  }
  return out;
}

/** vitest.durations.json's text: projects and paths sorted, ms rounded to 100. */
export function renderDurationsFile(durations) {
  const out = {};
  for (const project of Object.keys(durations).sort()) {
    out[project] = {};
    for (const file of Object.keys(durations[project]).sort()) {
      out[project][file] = Math.round(durations[project][file] / 100) * 100;
    }
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The checked-in durations, or {} when the file is missing or unreadable. */
export function readDurationsFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Split `items` ({ path, project }) into `count` shards of about equal time.
 *
 * Each project is balanced on its own, because a combined run (the nightly
 * runs both lanes) runs one project after the other with its own worker
 * count: shard i gets bucket i of every project. Within a project it is
 * greedy longest-processing-time: heaviest file first (ties by path), each to
 * the shard with the smallest total so far (ties to the lower shard). A file
 * with no recorded duration weighs the median of the project's recorded ones.
 * The result depends only on the set of items, never on their order.
 *
 * Returns an array of `count` arrays of the given items.
 */
export function balanceShards(items, durations, count) {
  const shards = Array.from({ length: count }, () => []);
  const byProject = new Map();
  for (const item of items) {
    if (!byProject.has(item.project)) byProject.set(item.project, []);
    byProject.get(item.project).push(item);
  }
  for (const project of [...byProject.keys()].sort()) {
    const known = isPlainObject(durations?.[project]) ? durations[project] : {};
    const recorded = Object.values(known).filter((ms) => typeof ms === 'number' && Number.isFinite(ms));
    const fallback = median(recorded) ?? 0;
    const weighted = byProject
      .get(project)
      .map((item) => ({
        item,
        weight: (typeof known[item.path] === 'number' ? known[item.path] : fallback) + FILE_COST_MS,
      }))
      .sort((a, b) => compareText(a.item.path, b.item.path) || compareText(a.item.pool ?? '', b.item.pool ?? ''))
      .sort((a, b) => b.weight - a.weight);
    const totals = new Array(count).fill(0);
    for (const { item, weight } of weighted) {
      let target = 0;
      for (let i = 1; i < count; i++) if (totals[i] < totals[target]) target = i;
      totals[target] += weight;
      shards[target].push(item);
    }
  }
  return shards;
}

// Plain code-unit order, the same on every machine (localeCompare is not).
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKeys(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort(compareText)) out[key] = obj[key];
  return out;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}
