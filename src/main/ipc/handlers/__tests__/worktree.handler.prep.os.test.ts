// The Git page's "create worktree" prepares the new worktree like every other
// worktree a person opens: the trusted config files are copied in and the
// setup command runs; an unapproved wmux.json runs nothing, and says why.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { ProjectConfigState } from '../../../../shared/wmuxProjectConfig';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
const hooks = vi.hoisted(() => ({ ensured: [] as string[] }));
vi.mock('../../../git/secretHookHost', () => ({ ensureSecretHook: (cwd: string) => hooks.ensured.push(cwd) }));
const project = vi.hoisted(() => ({ state: null as ProjectConfigState | null }));
vi.mock('../../../project/ProjectConfigStore', () => ({
  getProjectConfigStore: () => ({ getState: async () => project.state ?? { found: false } }),
}));

import { addPreparedWorktree } from '../worktree.handler';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('addPreparedWorktree', () => {
  let base: string;
  let repo: string;
  beforeEach(() => {
    hooks.ensured.length = 0;
    base = realpathSync.native(mkdtempSync(join(os.tmpdir(), 'wmux-wtprep-')));
    repo = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    g(repo, ['config', 'user.email', 't@t']);
    g(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', 'base']);
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const trusted = (fanout: NonNullable<ProjectConfigState['config']>['fanout'], trust: ProjectConfigState['trust'] = 'trusted'): ProjectConfigState => ({
    found: true, root: repo, configPath: join(repo, 'wmux.json'), trust, contentHash: 'a'.repeat(64), config: { version: 1, fanout },
  });

  it('copies the selected files and runs the setup command in the new worktree', async () => {
    project.state = trusted({ copy: ['.env', '.env.local'], setup: 'node -e "require(\'fs\').writeFileSync(\'setup-ran\', \'1\')"' });
    const res = await addPreparedWorktree(repo, 'feat/a');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prep).toMatchObject({ status: 'ready', setupRan: true, copy: { copied: 1, missing: 1 } });
    expect(readFileSync(join(res.worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(existsSync(join(res.worktreePath, 'setup-ran'))).toBe(true);
    expect(hooks.ensured).toEqual([res.worktreePath]);
  });

  it('skips preparation from a config changed since approval and reports it', async () => {
    project.state = trusted({ copy: ['.env'], setup: 'node -e "require(\'fs\').writeFileSync(\'setup-ran\', \'1\')"' }, 'stale');
    const res = await addPreparedWorktree(repo, 'feat/b');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prep).toMatchObject({ status: 'skipped', reason: 'stale' });
    expect(existsSync(join(res.worktreePath, '.env'))).toBe(false);
    expect(existsSync(join(res.worktreePath, 'setup-ran'))).toBe(false);
  });

  it('keeps the worktree when the setup fails', async () => {
    project.state = trusted({ setup: 'node -e "process.exit(2)"' });
    const res = await addPreparedWorktree(repo, 'feat/c');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prep).toMatchObject({ status: 'failed', error: 'exited with code 2' });
    expect(existsSync(res.worktreePath)).toBe(true);
  });

  it('adds nothing to the result when the project declares no preparation', async () => {
    project.state = null;
    const res = await addPreparedWorktree(repo, 'feat/d');
    expect(res).toEqual({ ok: true, worktreePath: expect.any(String) });
  });
});
