// TaskPrService — the PR body goes to `gh pr create` on stdin, never on argv
// (Windows caps a command line at 32,767 characters; a longer one fails to
// spawn with ENAMETOOLONG before gh starts).

import { describe, it, expect, vi } from 'vitest';
import { TaskPrService, type PrExec, type CreatePrInput } from '../TaskPrService';
import type { GitLines } from '../../git/secretScan';
import type { ForgeHosts } from '../../../shared/forgeHosts';

vi.mock('../../../shared/forgeHosts', async (orig) => ({
  ...(await orig<typeof import('../../../shared/forgeHosts')>()),
  forgeHosts: (): ForgeHosts => ({ gh: new Set(), glab: new Map() }),
}));

const VALID_PR = 'https://github.com/acme/widget/pull/42';
const BRANCH_SHA = 'c0ffee'.padEnd(40, '0');

const INPUT: CreatePrInput = {
  taskId: 'wtask-1',
  verifiedWorkspaceId: 'ws-owner',
  worktreePath: '/wt/task-1',
  branch: 'wtask/task-1-abcd1234',
  title: 'Fix the thing',
};

type Call = { cmd: string; args: string[]; input: string | undefined };

function run() {
  const calls: Call[] = [];
  const exec: PrExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts.input });
    const a = args.join(' ');
    if (cmd === 'gh' || cmd === 'gh.exe') {
      if (a.startsWith('repo view')) return { stdout: 'main', stderr: '' };
      if (a.startsWith('pr create')) return { stdout: `Creating pull request\n${VALID_PR}`, stderr: '' };
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'check-ref-format') return { stdout: `${args[2]}\n`, stderr: '' };
    if (args[0] === 'rev-parse') return { stdout: `${BRANCH_SHA}\n`, stderr: '' };
    if (a === 'remote get-url --push origin') return { stdout: 'https://github.com/acme/widget.git\n', stderr: '' };
    if (a === 'remote') return { stdout: 'origin', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const cleanScan = (): GitLines => async () => true;
  const svc = new TaskPrService({
    daemon: { rpc: async () => ({ ok: true }) },
    cache: { invalidate: () => undefined },
    exec,
    scanGit: cleanScan,
    secretGuard: () => false,
  });
  return { svc, calls, create: () => calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create') };
}

describe('TaskPrService — PR body on stdin', () => {
  it('a 40,000-character body is written to stdin with --body-file -, and no argv carries it', async () => {
    const body = `-${'x'.repeat(39_999)}`;
    const { svc, calls, create } = run();
    const res = await svc.createPr({ ...INPUT, body });
    expect(res).toMatchObject({ ok: true, prUrl: VALID_PR });
    const pr = create();
    expect(pr).toBeDefined();
    const at = pr!.args.indexOf('--body-file');
    expect(at).toBeGreaterThan(-1);
    expect(pr!.args[at + 1]).toBe('-');
    expect(pr!.args).not.toContain('--body');
    expect(pr!.input).toBe(body);
    for (const c of calls) {
      expect(c.args.join(' ').length).toBeLessThan(1_000);
      if (c !== pr) expect(c.input).toBeUndefined();
    }
  });

  it('the default body takes the same stdin path', async () => {
    const { svc, create } = run();
    await svc.createPr(INPUT);
    expect(create()!.args.slice(-2)).toEqual(['--body-file', '-']);
    expect(create()!.input).toBe(`wmux fan-out task: ${INPUT.title}`);
  });
});
