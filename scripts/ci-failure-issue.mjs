#!/usr/bin/env node
// Open, update or close the `Nightly red: <workflow>` issue for this run.
//
//   node scripts/ci-failure-issue.mjs --state failure|success [--dry-run]
//
// Runs as the last step of a job on main (runtime.yml, windows.yml), with
// GH_TOKEN set and the GITHUB_* variables Actions provides:
//
//   --state failure   comment on the open `ci-nightly` issue for this workflow,
//                     or open one (labels bug, ci-nightly) when there is none;
//   --state success   close that issue with "green again at <run url>", once
//                     every other job in the run is green too;
//   --dry-run         print the gh commands that would change something,
//                     instead of running them. Reads print too and answer
//                     "nothing found", so a dry run shows the create path.
//
// The rules and the races are in scripts/lib/ci-failure-issue.mjs.
//
// Exit code: on the failure path an error exits 1; the job is red anyway, and
// a red reporting step says the issue was not filed. On the success path an
// error is a warning and the exit is 0: a gh hiccup must not turn a green job
// red.

import { spawnSync } from 'node:child_process';
import { report } from './lib/ci-failure-issue.mjs';

function parseArgs(argv) {
  const args = { state: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--state') args.state = argv[++i] ?? null;
    else if (arg.startsWith('--state=')) args.state = arg.slice('--state='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// No shell: the body and title are argv entries, never parsed as a command
// line. libuv finds gh.exe on PATH on Windows without one.
function realGh(args, { allowFailure = false } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`gh ${args[0]} ${args[1]}: ${result.error.message}`);
  if (result.status !== 0) {
    if (allowFailure) return '';
    throw new Error(`gh ${args[0]} ${args[1]} exited ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

function dryRunGh(args) {
  console.log(`gh ${args.map(quote).join(' ')}`);
  if (args[0] === 'issue' && args[1] === 'list') return '[]';
  if (args[0] === 'run' && args[1] === 'view') return '{"jobs":[]}';
  return '';
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ci-failure-issue: ${error.message}`);
    process.exit(2);
  }
  try {
    report({
      state: args.state,
      env: process.env,
      gh: args.dryRun ? dryRunGh : realGh,
      log: (line) => console.log(`ci-failure-issue: ${line}`),
    });
  } catch (error) {
    if (args.state === 'success') {
      console.log(`::warning::ci-failure-issue: ${error.message}`);
      return;
    }
    console.error(`ci-failure-issue: ${error.message}`);
    process.exit(1);
  }
}

main();
