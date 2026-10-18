// Nightly red issues (scripts/lib/ci-failure-issue.mjs, scripts/ci-failure-issue.mjs).
//
// A red run on main opens one `Nightly red: <workflow>` issue, or comments on
// the open one; a green run closes it. These drive the logic with a fake gh
// and pin the argv it sends, since the argv is the whole contract with GitHub.
import { describe, expect, it } from 'vitest';
import {
  failedJobNames,
  issueTitle,
  newestReportedRun,
  othersAllGreen,
  renderFailureBody,
  report,
  runUrl,
} from '../lib/ci-failure-issue.mjs';

const ENV = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'acme/app',
  GITHUB_RUN_ID: '42',
  GITHUB_WORKFLOW: 'Runtime suite',
  GITHUB_EVENT_NAME: 'schedule',
  GITHUB_SHA: 'a'.repeat(40),
};
const RUN_URL = 'https://github.com/acme/app/actions/runs/42';

function job(name, status, conclusion, stepConclusions = []) {
  return {
    name,
    status,
    conclusion,
    steps: stepConclusions.map((c, i) => ({ name: `step ${i}`, number: i + 1, status: 'completed', conclusion: c })),
  };
}

// The job running the report step: in progress, one step already red.
const SELF_RED = job('validate-runtime', 'in_progress', '', ['success', 'failure']);
const SELF_GREEN = job('validate-runtime', 'in_progress', '', ['success', 'success']);

function fakeGh({ issues = [], jobs = [], issue = { body: '', comments: [] } } = {}) {
  const calls = [];
  const gh = (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(issues);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify(issue);
    if (args[0] === 'run' && args[1] === 'view') return JSON.stringify({ jobs });
    return '';
  };
  return { gh, calls, writes: () => calls.filter((c) => !['list', 'view'].includes(c.args[1])) };
}

describe('issueTitle', () => {
  it('is "Nightly red: " and the workflow name, one issue per workflow', () => {
    expect(issueTitle('Runtime suite')).toBe('Nightly red: Runtime suite');
    expect(issueTitle('Windows full suite')).toBe('Nightly red: Windows full suite');
  });

  it('refuses a missing workflow name', () => {
    expect(() => issueTitle('')).toThrow(/GITHUB_WORKFLOW/);
    expect(() => issueTitle(undefined)).toThrow(/GITHUB_WORKFLOW/);
  });
});

describe('runUrl', () => {
  it('builds the run page from the GITHUB_* variables', () => {
    expect(runUrl(ENV)).toBe(RUN_URL);
  });
});

describe('failedJobNames', () => {
  it('keeps finished red jobs and running jobs with a red step, drops the rest', () => {
    const jobs = {
      jobs: [
        job('windows (2/2)', 'completed', 'failure'),
        job('windows (1/2)', 'in_progress', '', ['success', 'failure']),
        job('other', 'in_progress', '', ['success']),
        job('green', 'completed', 'success'),
        job('slow', 'completed', 'timed_out'),
      ],
    };
    expect(failedJobNames(jobs)).toEqual(['slow', 'windows (1/2)', 'windows (2/2)']);
  });
});

describe('othersAllGreen', () => {
  it('is true when this job is the only one left and the rest are green', () => {
    expect(othersAllGreen({ jobs: [SELF_GREEN, job('windows (2/2)', 'completed', 'success')] })).toBe(true);
  });

  it('is false while another job is still running, or when one went red', () => {
    expect(othersAllGreen({ jobs: [SELF_GREEN, job('b', 'in_progress', '', ['success'])] })).toBe(false);
    expect(othersAllGreen({ jobs: [SELF_GREEN, job('b', 'completed', 'failure')] })).toBe(false);
  });
});

describe('renderFailureBody', () => {
  it('is fixed-template data: run, event, commit, job names, nothing else', () => {
    const body = renderFailureBody({ url: RUN_URL, event: 'push', sha: 'b'.repeat(40), jobs: ['windows (1/2)'] });
    expect(body).toBe([
      `Run: ${RUN_URL}`,
      'Event: `push`',
      `Commit: \`${'b'.repeat(40)}\``,
      '',
      'Failed jobs:',
      '- `windows (1/2)`',
      '',
      'Opened by scripts/ci-failure-issue.mjs. The logs are on the run page.',
    ].join('\n'));
  });

  it('cannot break out of its code spans or mention anyone', () => {
    const body = renderFailureBody({ url: RUN_URL, event: 'push', sha: 'x', jobs: ['a`b\n@team'] });
    expect(body).toContain('- `a b  team`');
    expect(body).not.toContain('@');
  });
});

describe('report --state failure', () => {
  it('creates the issue, label first, when none is open', () => {
    const fake = fakeGh({ issues: [{ number: 7, title: 'Nightly red: Windows full suite' }], jobs: [SELF_RED] });
    expect(report({ state: 'failure', env: ENV, gh: fake.gh })).toBe('created');

    expect(fake.calls[0].args).toEqual([
      'issue', 'list', '-R', 'acme/app', '--state', 'open', '--label', 'ci-nightly',
      '--limit', '100', '--json', 'number,title',
    ]);
    const writes = fake.writes();
    expect(writes).toHaveLength(2);
    expect(writes[0].args.slice(0, 5)).toEqual(['label', 'create', 'ci-nightly', '-R', 'acme/app']);
    expect(writes[0].options).toEqual({ allowFailure: true });
    const create = writes[1].args;
    expect(create.slice(0, 10)).toEqual([
      'issue', 'create', '-R', 'acme/app', '--title', 'Nightly red: Runtime suite',
      '--label', 'bug', '--label', 'ci-nightly',
    ]);
    const body = create[create.indexOf('--body') + 1];
    expect(body).toContain(`Run: ${RUN_URL}`);
    expect(body).toContain('Event: `schedule`');
    expect(body).toContain(`Commit: \`${'a'.repeat(40)}\``);
    expect(body).toContain('- `validate-runtime`');
  });

  it('comments on the open issue instead of opening a second one', () => {
    const fake = fakeGh({
      issues: [{ number: 12, title: 'Nightly red: Runtime suite' }, { number: 9, title: 'Nightly red: Runtime' }],
      jobs: [SELF_RED],
    });
    expect(report({ state: 'failure', env: ENV, gh: fake.gh })).toBe('commented');

    const writes = fake.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0].args.slice(0, 5)).toEqual(['issue', 'comment', '12', '-R', 'acme/app']);
    expect(writes[0].args[6]).toContain('- `validate-runtime`');
  });
});

describe('report --state success', () => {
  it('closes the open issue with "green again at <run url>"', () => {
    const fake = fakeGh({ issues: [{ number: 12, title: 'Nightly red: Runtime suite' }], jobs: [SELF_GREEN] });
    expect(report({ state: 'success', env: ENV, gh: fake.gh })).toBe('closed');

    expect(fake.writes().map((c) => c.args)).toEqual([
      ['issue', 'close', '12', '-R', 'acme/app', '--comment', `green again at ${RUN_URL}`],
    ]);
  });

  it('does nothing when no issue is open', () => {
    const fake = fakeGh({ issues: [], jobs: [SELF_GREEN] });
    expect(report({ state: 'success', env: ENV, gh: fake.gh })).toBe('none');
    expect(fake.writes()).toEqual([]);
  });

  it('leaves the issue open when a newer red run reported after this green one started', () => {
    // This run is 42; the issue's newest red report is run 57 (a push run
    // that started later and finished first).
    const issue = {
      body: 'Run: https://github.com/acme/app/actions/runs/40',
      comments: [{ body: 'Run: https://github.com/acme/app/actions/runs/57' }],
    };
    const fake = fakeGh({ issues: [{ number: 12, title: 'Nightly red: Runtime suite' }], jobs: [SELF_GREEN], issue });
    expect(report({ state: 'success', env: ENV, gh: fake.gh })).toBe('none');
    expect(fake.writes()).toEqual([]);
  });

  it('reads the newest run id from the body and every comment', () => {
    expect(newestReportedRun({ body: 'runs/7 and /actions/runs/31', comments: [{ body: '/actions/runs/12' }] })).toBe(31);
    expect(newestReportedRun({})).toBe(0);
  });

  it('leaves the issue open while the other shard is still running or went red', () => {
    const issues = [{ number: 12, title: 'Nightly red: Runtime suite' }];
    for (const other of [job('windows (2/2)', 'in_progress', '', ['success']), job('windows (2/2)', 'completed', 'failure')]) {
      const fake = fakeGh({ issues, jobs: [SELF_GREEN, other] });
      expect(report({ state: 'success', env: ENV, gh: fake.gh })).toBe('none');
      expect(fake.writes()).toEqual([]);
    }
  });
});

describe('report arguments', () => {
  it('refuses an unknown state', () => {
    expect(() => report({ state: 'red', env: ENV, gh: fakeGh().gh })).toThrow(/--state/);
  });
});
