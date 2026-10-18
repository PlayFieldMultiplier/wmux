// #2407 — a WSL pane's Linux cwd must reach the daemon's git watcher as a
// path this Windows process can read; every other cwd goes in unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitWatchArgs, gitWatchPath } from '../gitWatchPath';

const ubuntu = { distribution: 'Ubuntu-24.04', user: 'dev' };

describe('gitWatchPath', () => {
  it('maps a distro-internal path to the session distro\'s UNC share', () => {
    expect(gitWatchPath('/home/dev/e2e-wsl-2403', ubuntu)).toBe('\\\\wsl$\\Ubuntu-24.04\\home\\dev\\e2e-wsl-2403');
    expect(gitWatchPath('/', ubuntu)).toBe('\\\\wsl$\\Ubuntu-24.04\\');
  });

  it('maps a drive-mount path to the host drive', () => {
    expect(gitWatchPath('/mnt/d/wmux-work/a b/repo', ubuntu)).toBe('D:\\wmux-work\\a b\\repo');
    expect(gitWatchPath('/mnt/c', ubuntu)).toBe('C:\\');
  });

  it('uses the distro recorded at spawn for a default-distro pane', () => {
    // A pane spawned without `-d` has its wslTarget from the cwd probe's
    // $WSL_DISTRO_NAME, so it is a named distro here like any other.
    expect(gitWatchPath('/home/me/repo', { distribution: 'Debian', user: 'me' })).toBe('\\\\wsl$\\Debian\\home\\me\\repo');
  });

  it('leaves a non-WSL session\'s cwd unchanged', () => {
    expect(gitWatchPath('/home/dev/repo', undefined)).toBe('/home/dev/repo');
    expect(gitWatchPath('D:\\wmux', undefined)).toBe('D:\\wmux');
  });

  it('leaves a cwd it cannot translate safely unchanged', () => {
    for (const cwd of [
      '~',
      '~/repo',
      'relative/dir',
      '//server/share',
      '/home/dev/a\\b',
      '/mnt/d/x/repo.',
      'D:\\already\\host',
      '\\\\wsl$\\Ubuntu-24.04\\home\\dev',
    ]) {
      expect(gitWatchPath(cwd, ubuntu)).toBe(cwd);
    }
  });
});

describe('gitWatchArgs', () => {
  it('passes a non-WSL session through without a gitdir mapper', () => {
    expect(gitWatchArgs('s1', { cwd: 'D:\\repo' })).toEqual(['s1', 'D:\\repo']);
  });

  it('maps a WSL session\'s cwd and its worktree gitdirs with the same distro', () => {
    const [id, cwd, mapGitDir] = gitWatchArgs('s1', { cwd: '/home/dev/wt', wslTarget: ubuntu });
    expect(id).toBe('s1');
    expect(cwd).toBe('\\\\wsl$\\Ubuntu-24.04\\home\\dev\\wt');
    expect(mapGitDir?.('/home/dev/repo/.git/worktrees/wt')).toBe('\\\\wsl$\\Ubuntu-24.04\\home\\dev\\repo\\.git\\worktrees\\wt');
    expect(mapGitDir?.('/mnt/d/repo/.git/worktrees/wt')).toBe('D:\\repo\\.git\\worktrees\\wt');
  });
});

describe('daemon git watcher wiring (#2407)', () => {
  // wireContextWatchers is a closure inside the daemon entry module, which a
  // unit test cannot import; assert its call sites instead (see
  // agentStateReaderWiring.test.ts for the same approach).
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  it('feeds every git watcher update through gitWatchArgs', () => {
    const all = src.match(/gitWatcher\.update\(/g) ?? [];
    const mapped = src.match(/gitWatcher\.update\(\.\.\.gitWatchArgs\(/g) ?? [];
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(mapped).toHaveLength(all.length);
  });

  it('reads the session\'s WSL target for a cwd change', () => {
    const start = src.indexOf('const onCwd = (payload: { sessionId: string; cwd: string }) => {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('};', start));
    expect(body).toContain('sessionManager.getSession(payload.sessionId)?.meta.wslTarget');
    expect(body).toContain('gitWatchArgs(payload.sessionId, { cwd: payload.cwd, wslTarget })');
  });
});
