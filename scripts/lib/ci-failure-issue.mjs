// Nightly red runs as GitHub issues: the pure parts of scripts/ci-failure-issue.mjs.
//
// runtime.yml and windows.yml run on main (nightly, on push, on demand) and
// gate nothing. A red run used to notify by email only. Now the last step of
// each job opens one issue per workflow, titled `Nightly red: <workflow>` and
// labelled `ci-nightly`, or comments on it while it is open; the next green
// run closes it. repoWatch turns a new issue into an `issue.opened` fact and
// the triage bot wakes on it (src/main/factory/roleDefaults.ts), so a red
// night becomes a bot task.
//
// Everything here takes an injected `gh(args) => stdout` runner, so the tests
// drive it with a fake and the command line is the only file that spawns.
//
// The issue body is plain data from fixed templates: the run URL, the event,
// the commit and the failed job names. Never log text: a log can carry
// anything a test printed, and the issue is read by a bot.
//
// Races, accepted and written down here:
// - windows.yml runs two shards, each with its own step. Two shards failing
//   within the same second can both find no open issue and both create one.
//   The window is one `gh issue list` round trip; the cost is a duplicate
//   issue to close by hand.
// - A green shard closes the issue only when every other job in the run has
//   already finished green. If the other shard is still running, the green
//   one leaves the issue alone and the last shard to finish decides; if both
//   finish the same second, neither may close it, and the next green run does.

export const LABEL = 'ci-nightly';
export const LABEL_COLOR = 'B60205';
export const LABEL_DESCRIPTION = 'A scheduled or main-branch CI workflow went red';
export const TITLE_PREFIX = 'Nightly red: ';

/** The one issue title per workflow. */
export function issueTitle(workflow) {
  if (!workflow || !String(workflow).trim()) throw new Error('workflow name is required (GITHUB_WORKFLOW)');
  return `${TITLE_PREFIX}${String(workflow).trim()}`;
}

/** The run's page, from the GITHUB_* variables every Actions step gets. */
export function runUrl(env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  for (const name of ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID']) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

function stepFailed(job) {
  return (job.steps ?? []).some((step) => FAILED.has(step.conclusion));
}

/**
 * Names of the run's failed jobs, from `gh run view --json jobs`. A finished
 * job counts by its conclusion. A job still in progress counts only when one
 * of its steps already failed: that is the job running this very step on the
 * failure path (its own conclusion is not in yet), or the other shard on its
 * way to red. A job in progress with nothing failed is left out.
 */
export function failedJobNames(jobsJson) {
  const names = [];
  for (const job of jobsJson?.jobs ?? []) {
    const failed = job.status === 'completed' ? FAILED.has(job.conclusion) : stepFailed(job);
    if (failed && job.name) names.push(String(job.name));
  }
  return [...new Set(names)].sort();
}

/**
 * Whether every job other than this one finished green, so a green step may
 * close the issue. This job is the one still in progress (the step runs inside
 * it); a second job in progress is the other shard, not done yet, and then the
 * answer is no.
 */
export function othersAllGreen(jobsJson) {
  const jobs = jobsJson?.jobs ?? [];
  const running = jobs.filter((job) => job.status !== 'completed');
  if (running.length !== 1 || stepFailed(running[0])) return false;
  return jobs
    .filter((job) => job.status === 'completed')
    .every((job) => job.conclusion === 'success' || job.conclusion === 'skipped');
}

function sanitize(value) {
  // Single line, no markdown that could close the code span or ping anyone.
  return String(value ?? '').replace(/[\r\n`@]/g, ' ').trim() || 'unknown';
}

export function renderFailureBody({ url, event, sha, jobs }) {
  const jobLines = jobs.length > 0 ? jobs.map((name) => `- \`${sanitize(name)}\``) : ['- (none reported yet)'];
  return [
    `Run: ${url}`,
    `Event: \`${sanitize(event)}\``,
    `Commit: \`${sanitize(sha)}\``,
    '',
    'Failed jobs:',
    ...jobLines,
    '',
    'Opened by scripts/ci-failure-issue.mjs. The logs are on the run page.',
  ].join('\n');
}

export function renderGreenComment(url) {
  return `green again at ${url}`;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`could not parse ${what}: ${error.message}`);
  }
}

/** The open `ci-nightly` issue with exactly this title, or null. */
export function findOpenIssue(gh, { repo, title }) {
  const out = gh(['issue', 'list', '-R', repo, '--state', 'open', '--label', LABEL,
    '--limit', '100', '--json', 'number,title']);
  const issues = parseJson(out || '[]', 'gh issue list');
  const match = issues
    .filter((issue) => issue.title === title)
    .sort((a, b) => a.number - b.number)[0];
  return match ? match.number : null;
}

function readJobs(gh, { repo, runId }) {
  return parseJson(gh(['run', 'view', String(runId), '-R', repo, '--json', 'jobs']) || '{}', 'gh run view');
}

/**
 * One report. `state` is 'failure' or 'success'. `gh(args, { allowFailure })`
 * runs one command and returns its stdout; `log` prints a line. Returns what
 * it did: 'created', 'commented', 'closed' or 'none'.
 */
export function report({ state, env, gh, log = () => undefined }) {
  if (state !== 'failure' && state !== 'success') throw new Error(`--state must be failure or success, not ${state}`);
  const repo = env.GITHUB_REPOSITORY;
  const title = issueTitle(env.GITHUB_WORKFLOW);
  const url = runUrl(env);

  const existing = findOpenIssue(gh, { repo, title });

  if (state === 'success') {
    if (existing === null) {
      log(`no open issue titled "${title}"; nothing to close`);
      return 'none';
    }
    if (!othersAllGreen(readJobs(gh, { repo, runId: env.GITHUB_RUN_ID }))) {
      log(`another job in this run is not green (yet); leaving #${existing} open`);
      return 'none';
    }
    gh(['issue', 'close', String(existing), '-R', repo, '--comment', renderGreenComment(url)]);
    log(`closed #${existing}`);
    return 'closed';
  }

  const jobs = failedJobNames(readJobs(gh, { repo, runId: env.GITHUB_RUN_ID }));
  const body = renderFailureBody({ url, event: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA, jobs });

  if (existing !== null) {
    gh(['issue', 'comment', String(existing), '-R', repo, '--body', body]);
    log(`commented on #${existing}`);
    return 'commented';
  }
  // Exists after the first time; the failure is ignored like `|| true`.
  gh(['label', 'create', LABEL, '-R', repo, '--color', LABEL_COLOR, '--description', LABEL_DESCRIPTION],
    { allowFailure: true });
  gh(['issue', 'create', '-R', repo, '--title', title, '--label', 'bug', '--label', LABEL, '--body', body]);
  log(`opened "${title}"`);
  return 'created';
}
