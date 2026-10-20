// @wmux-lane integration
// Runs on every OS: the handler resolves and stats these drive paths with the
// host's own path rules, which differ on Windows.
// worktree:list on a mapped network drive: git answers the drive's folders in
// share spelling, and the handler spells them from the drive again so a path
// the renderer hands back is accepted.
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

const gitMock = vi.hoisted(() => vi.fn());
vi.mock('../../../git/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../git/git')>()),
  git: gitMock,
}));

import { registerWorktreeHandlers } from '../worktree.handler';
import { IPC } from '../../../../shared/constants';

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });

// Z: leads to \\server\share.
async function onZ(p: fs.PathLike): Promise<string> {
  const s = String(p);
  if (s === 'Z:\\') return '\\\\server\\share\\';
  return `\\\\server\\share\\${s.split('Z:\\')[1] ?? ''}`;
}

function porcelain(...paths: string[]): string {
  return paths.map((p, i) => `worktree ${p}\nHEAD ${String(i).repeat(40)}\nbranch refs/heads/b${i}\n`).join('\n');
}

describe('worktree:list on a mapped drive', () => {
  const list = (repoPath: string) => captured.get(IPC.WORKTREE_LIST)?.({} as never, repoPath);

  beforeEach(() => {
    gitMock.mockReset();
    vi.spyOn(fs.promises, 'realpath').mockImplementation(onZ as never);
    registerWorktreeHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers every path in drive spelling, leaves out one on another share, and accepts an answer back', async () => {
    gitMock.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return ok('//server/share/work/alpha\n');
      if (args[0] === 'worktree') {
        return ok(porcelain('//server/share/work/alpha', '//server/share/work/alpha-worktrees/feat', '//elsewhere/share/x'));
      }
      return ok('');
    });
    const res = (await list('Z:\\work\\alpha')) as { ok: true; repoPath: string; mainPath: string; worktrees: Array<{ path: string }> };
    expect(res.ok).toBe(true);
    expect(res.repoPath).toBe('Z:\\work\\alpha');
    expect(res.mainPath).toBe('Z:\\work\\alpha');
    expect(res.worktrees.map((w) => w.path)).toEqual(['Z:\\work\\alpha', 'Z:\\work\\alpha-worktrees\\feat']);
    const again = (await list(res.worktrees[1].path)) as { ok: boolean };
    expect(again.ok).toBe(true);
  });

  it('refuses a repository whose main worktree is on a share no drive leads to', async () => {
    gitMock.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return ok('//server/share/work/alpha\n');
      if (args[0] === 'worktree') return ok(porcelain('//elsewhere/share/main', '//server/share/work/alpha'));
      return ok('');
    });
    await expect(list('Z:\\work\\alpha')).resolves.toMatchObject({ ok: false });
  });

  it('adds no worktree when the main worktree is on a share no drive leads to', async () => {
    gitMock.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return ok('//server/share/work/alpha\n');
      if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain('//elsewhere/share/main', '//server/share/work/alpha'));
      return ok('');
    });
    const add = captured.get(IPC.WORKTREE_ADD);
    await expect(add?.({} as never, 'Z:\\work\\alpha', 'feat')).resolves.toMatchObject({ ok: false });
    expect(gitMock.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'add')).toBe(false);
  });
});
