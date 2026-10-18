#!/usr/bin/env node
// The week's flaky tests, from every CI run's retry reports.
//
//   node scripts/flaky-weekly.mjs [--days N] [--issue] [--dir PATH] [--repo OWNER/NAME]
//
// Lists the completed runs of ci.yml, ci-cross-platform-baseline.yml,
// runtime.yml and windows.yml from the last N days (default 7), downloads each
// run's `test-report-*` artifacts into its own folder, and merges the
// retries-*.json reports (scripts/lib/flaky-weekly.mjs): one row per test that
// passed only on retry, with the number of runs it did that in.
//
// Without --issue it prints the markdown. With --issue it opens one issue,
// "Flaky tests: week of <Monday>", labelled `flaky`, or rewrites the body of
// the open one with that title; when no test needed the retry it opens
// nothing. .github/workflows/flaky-weekly.yml runs it with --issue every
// Monday.
//
// --dir keeps the downloads in PATH (they go to a temp dir, deleted after,
// otherwise). Needs `gh`, authenticated, with read access to Actions.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWeekly } from './lib/flaky-weekly.mjs';

function parseArgs(argv) {
  const opts = { days: 7, issue: false, dir: null, repo: process.env.GH_REPO || null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--issue') opts.issue = true;
    else if (arg === '--days') opts.days = Number(argv[++i]);
    else if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--repo') opts.repo = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) throw new Error('--days needs a positive number');
  return opts;
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) return { status: 1, stdout: '', stderr: result.error.message };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const warn = (message) => console.warn(`flaky-weekly: ${message}`);
  const root = opts.dir ? path.resolve(opts.dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-weekly-'));
  fs.mkdirSync(root, { recursive: true });
  try {
    const { title, body, flaky, published } = runWeekly(gh, {
      days: opts.days,
      issue: opts.issue,
      root,
      repo: opts.repo,
      warn,
    });
    if (!opts.issue) {
      console.log(`## ${title}\n\n${body}`);
    } else if (flaky.length === 0) {
      console.log(`${title}: no test needed the retry to pass; no issue opened.\n\n${body}`);
    } else if (published.action === 'edited') {
      console.log(`${title}: updated issue #${published.number}.`);
    } else {
      console.log(`${title}: opened ${published.url || 'an issue'}.`);
    }
  } finally {
    if (!opts.dir) fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`flaky-weekly: ${error.message}`);
  process.exitCode = 1;
}
