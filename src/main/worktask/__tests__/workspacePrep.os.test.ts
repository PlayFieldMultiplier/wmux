// New workspace preparation: the trust gate, the bot/fan-out copy rule, and
// the copy itself against a real repository and worktree.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  copyWorkspaceFiles,
  resolveWorkspacePrep,
  runWorkspacePrep,
  type WorkspacePrepProgress,
} from '../workspacePrep';
import type { ProjectConfigState, ProjectTrustState, WmuxProjectFanout } from '../../../shared/wmuxProjectConfig';

function stateWith(fanout: WmuxProjectFanout, trust: ProjectTrustState = 'trusted'): ProjectConfigState {
  return { found: true, root: '/repo', configPath: '/repo/wmux.json', contentHash: 'a'.repeat(64), trust, config: { version: 1, fanout } };
}

describe('resolveWorkspacePrep', () => {
  it('copies into a worktree a person opened', () => {
    const plan = resolveWorkspacePrep(stateWith({ copy: ['.env'], setup: 'npm ci' }), 'human');
    expect(plan).toEqual({ copy: ['.env'], setup: 'npm ci' });
  });

  it('does not copy into bot and fan-out worktrees unless the toggle is on', () => {
    const off = resolveWorkspacePrep(stateWith({ copy: ['.env'], setup: 'npm ci' }), 'automated');
    expect(off).toEqual({ copy: [], copyBlocked: true, setup: 'npm ci' });
    const on = resolveWorkspacePrep(stateWith({ copy: ['.env'], copyIntoAutomated: true }), 'automated');
    expect(on).toEqual({ copy: ['.env'] });
  });

  it.each<ProjectTrustState>(['untrusted', 'stale', 'denied'])('runs nothing from a %s config and says why', (trust) => {
    const plan = resolveWorkspacePrep(stateWith({ copy: ['.env'], setup: 'npm ci' }, trust), 'human');
    expect(plan).toEqual({ copy: [], skipped: trust });
  });

  it('a trust record from before copy settings existed does not cover them: no copy, a reason, the setup still runs', () => {
    const legacy = { ...stateWith({ copy: ['.env'], copyIntoAutomated: true, setup: 'npm ci' }), copyReviewed: false };
    expect(resolveWorkspacePrep(legacy, 'automated')).toEqual({ copy: [], copySkipped: 'needs-review', setup: 'npm ci' });
    expect(resolveWorkspacePrep(legacy, 'human')).toEqual({ copy: [], copySkipped: 'needs-review', setup: 'npm ci' });
  });

  it('skips everything when a declared part was rejected', () => {
    const plan = resolveWorkspacePrep(stateWith({ setup: 'npm ci', invalidFields: ['copy'] }), 'human');
    expect(plan).toEqual({ copy: [], skipped: 'malformed' });
  });

  it('has nothing to do when nothing is declared', () => {
    expect(resolveWorkspacePrep({ found: false }, 'human')).toEqual({ copy: [] });
    expect(resolveWorkspacePrep(stateWith({ portRange: { min: 3000, max: 3001 } }, 'untrusted'), 'human')).toEqual({ copy: [] });
  });
});

describe('copyWorkspaceFiles and runWorkspacePrep (real git)', () => {
  let tmp: string;
  let repo: string;
  let wt: string;
  const g = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-prep-')));
    repo = path.join(tmp, 'repo with space');
    fs.mkdirSync(repo);
    g(repo, 'init', '-q');
    g(repo, 'config', 'user.email', 'a@b.c');
    g(repo, 'config', 'user.name', 'a');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env*\nconfig/local.json\n');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(repo, '.env.local'), 'LOCAL=1\n');
    fs.mkdirSync(path.join(repo, 'config'));
    fs.writeFileSync(path.join(repo, 'config', 'local.json'), '{}\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'not ignored\n');
    wt = path.join(tmp, 'wt');
    g(repo, 'worktree', 'add', '-q', wt, '-b', 'task');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('copies selected ignored files, counts a missing one, refuses tracked and non-ignored files', async () => {
    const r = await copyWorkspaceFiles(repo, wt, ['.env', 'config/local.json', '.env.missing', 'tracked.txt', 'untracked.txt']);
    expect(r).toEqual({ copied: 2, missing: 1, present: 0, refused: 2 });
    expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(fs.existsSync(path.join(wt, 'config', 'local.json'))).toBe(true);
    expect(fs.existsSync(path.join(wt, 'untracked.txt'))).toBe(false);
    // The copies stay out of the worktree's status: nothing to commit.
    expect(g(wt, 'status', '--porcelain')).toBe('');
  });

  it.skipIf(process.platform === 'win32')('follows a link to a file inside the checkout, never one outside it or a tracked link out of the worktree', async () => {
    const wtL = path.join(tmp, 'wt-links');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'id_rsa'), 'PRIVATE\n');
    fs.symlinkSync('.env.local', path.join(repo, '.env.linked'));
    fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(repo, '.env.escape'));
    g(repo, 'worktree', 'add', '-q', wtL, '-b', 'links');
    // A tracked link in the worktree pointing out of it must not receive a copy.
    fs.symlinkSync(outside, path.join(wtL, 'config'));
    const r = await copyWorkspaceFiles(repo, wtL, ['.env.linked', '.env.escape', 'config/local.json']);
    expect(r).toEqual({ copied: 1, missing: 0, present: 0, refused: 2 });
    expect(fs.readFileSync(path.join(wtL, '.env.linked'), 'utf8')).toBe('LOCAL=1\n');
    expect(fs.existsSync(path.join(outside, 'local.json'))).toBe(false);
  });

  it('never overwrites a file already in the worktree', async () => {
    fs.writeFileSync(path.join(wt, '.env.local'), 'KEEP\n');
    const r = await copyWorkspaceFiles(repo, wt, ['.env.local']);
    expect(r).toEqual({ copied: 0, missing: 0, present: 1, refused: 0 });
    expect(fs.readFileSync(path.join(wt, '.env.local'), 'utf8')).toBe('KEEP\n');
  });

  it('a failed setup is a failed result with the output tail, after the copy', async () => {
    const wt2 = path.join(tmp, 'wt2');
    g(repo, 'worktree', 'add', '-q', wt2, '-b', 'task2');
    const progress: WorkspacePrepProgress[] = [];
    const r = await runWorkspacePrep(
      { plan: { copy: ['.env'], setup: 'boom' }, sourceRoot: repo, copyDestDir: wt2, worktreePath: wt2, onProgress: (p) => progress.push(p) },
      { runSetup: async () => ({ ok: false, error: 'exited with code 1: line1\nline2', summary: 'exited with code 1', tail: 'line1\nline2\n' }), now: () => 42 },
    );
    expect(r).toMatchObject({ status: 'failed', setupRan: true, error: 'exited with code 1', outputTail: ['line1', 'line2'] });
    expect(r.copy.copied).toBe(1);
    expect(progress.map((p) => p.phase)).toEqual(['copying', 'setup']);
    expect(progress[1]).toMatchObject({ setupStartedAt: 42, copy: { copied: 1 } });
  });

  it('reports copy settings that need review and copies nothing', async () => {
    const wt5 = path.join(tmp, 'wt5');
    g(repo, 'worktree', 'add', '-q', wt5, '-b', 'task5');
    const legacy = { ...stateWith({ copy: ['.env'] }), copyReviewed: false };
    const r = await runWorkspacePrep({ plan: resolveWorkspacePrep(legacy, 'human'), sourceRoot: repo, copyDestDir: wt5, worktreePath: wt5 });
    expect(r).toMatchObject({ status: 'ready', copySkipped: 'needs-review', copy: { copied: 0 } });
    expect(fs.existsSync(path.join(wt5, '.env'))).toBe(false);
  });

  it('reports a skipped plan without touching the worktree', async () => {
    const wt3 = path.join(tmp, 'wt3');
    g(repo, 'worktree', 'add', '-q', wt3, '-b', 'task3');
    let ran = false;
    const r = await runWorkspacePrep(
      { plan: resolveWorkspacePrep(stateWith({ copy: ['.env'], setup: 'npm ci' }, 'stale'), 'human'), sourceRoot: repo, copyDestDir: wt3, worktreePath: wt3 },
      { runSetup: async () => { ran = true; return { ok: true }; } },
    );
    expect(r).toMatchObject({ status: 'skipped', reason: 'stale', setupRan: false });
    expect(ran).toBe(false);
    expect(fs.existsSync(path.join(wt3, '.env'))).toBe(false);
  });

  it('git worktree remove deletes the copies with the folder', async () => {
    const wt4 = path.join(tmp, 'wt4');
    g(repo, 'worktree', 'add', '-q', wt4, '-b', 'task4');
    await copyWorkspaceFiles(repo, wt4, ['.env']);
    g(repo, 'worktree', 'remove', wt4);
    expect(fs.existsSync(wt4)).toBe(false);
  });
});
