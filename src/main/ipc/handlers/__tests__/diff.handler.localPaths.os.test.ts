// The Git page's repo lookup (diff:resolveRepo) and folder scan
// (diff:scanRepos) open local folders only: a network or device path is
// refused before realpath, the folder walk or git sees it.
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

const scanReposMock = vi.hoisted(() => vi.fn());
vi.mock('../../../git/scanRepos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../git/scanRepos')>()),
  scanRepos: scanReposMock,
}));

import { registerDiffHandlers } from '../diff.handler';
import { IPC } from '../../../../shared/constants';

const NETWORK_PATHS = ['//host/share', '\\\\host\\share', '\\\\?\\UNC\\host\\share', '\\\\.\\pipe\\x'];

describe('diff:resolveRepo and diff:scanRepos accept local paths only', () => {
  let realpathSpy: ReturnType<typeof vi.spyOn>;
  let readdirSpy: ReturnType<typeof vi.spyOn>;
  const invoke = (channel: string, cwd: string) => captured.get(channel)?.({} as never, cwd);

  beforeEach(() => {
    gitMock.mockReset();
    scanReposMock.mockReset();
    realpathSpy = vi.spyOn(fs.promises, 'realpath');
    readdirSpy = vi.spyOn(fs.promises, 'readdir');
    registerDiffHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(NETWORK_PATHS)('diff:resolveRepo refuses %s without touching it', async (cwd) => {
    await expect(invoke(IPC.DIFF_RESOLVE_REPO, cwd)).resolves.toEqual({ ok: false });
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(gitMock).not.toHaveBeenCalled();
  });

  it.each(NETWORK_PATHS)('diff:scanRepos refuses %s without touching it', async (cwd) => {
    await expect(invoke(IPC.DIFF_SCAN_REPOS, cwd)).resolves.toEqual({ ok: false });
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(readdirSpy).not.toHaveBeenCalled();
    expect(scanReposMock).not.toHaveBeenCalled();
    expect(gitMock).not.toHaveBeenCalled();
  });

  it('diff:resolveRepo still resolves a local folder', async () => {
    const local = process.platform === 'win32' ? 'D:\\work\\repo' : '/work/repo';
    realpathSpy.mockResolvedValue(local);
    gitMock.mockResolvedValue({ code: 0, stdout: `${local}\n`, stderr: '' });
    await expect(invoke(IPC.DIFF_RESOLVE_REPO, local)).resolves.toEqual({ ok: true, repoPath: local });
    expect(gitMock).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], local);
  });

  describe('on a mapped drive', () => {
    // Z: leads to \\server\share; git answers its folders in share spelling.
    const onZ = async (p: fs.PathLike) => {
      const s = String(p);
      if (s === 'Z:\\') return '\\\\server\\share\\';
      return `\\\\server\\share\\${s.split(/Z:\\/)[1] ?? ''}`;
    };
    const gitTop = (cwd: string) => `//server/share/${cwd.split('Z:\\')[1].replace(/\\/g, '/')}\n`;

    it('diff:resolveRepo answers in drive spelling, and the answer passes again', async () => {
      realpathSpy.mockImplementation(onZ);
      gitMock.mockImplementation(async (_args: string[], cwd: string) => ({ code: 0, stdout: gitTop(cwd), stderr: '' }));
      await expect(invoke(IPC.DIFF_RESOLVE_REPO, 'Z:\\work\\alpha')).resolves.toEqual({ ok: true, repoPath: 'Z:\\work\\alpha' });
      await expect(invoke(IPC.DIFF_RESOLVE_REPO, 'Z:\\work\\alpha')).resolves.toEqual({ ok: true, repoPath: 'Z:\\work\\alpha' });
    });

    it('diff:resolveRepo refuses a toplevel git reports on a share no drive leads to', async () => {
      realpathSpy.mockImplementation(onZ);
      gitMock.mockResolvedValue({ code: 0, stdout: '//elsewhere/share/repo\n', stderr: '' });
      await expect(invoke(IPC.DIFF_RESOLVE_REPO, 'Z:\\work\\alpha')).resolves.toEqual({ ok: false });
    });

    it.each([
      ['a junction on a local drive', 'C:\\work\\link', async (p: fs.PathLike) => (String(p) === 'C:\\' ? 'C:\\' : '\\\\host\\share')],
      ['a link on Z: to another share', 'Z:\\work\\link', async (p: fs.PathLike) => (String(p) === 'Z:\\' ? '\\\\server\\share\\' : '\\\\other\\share\\repo')],
      ['a drive path on a share whose drive root cannot be read', 'Y:\\work\\repo', async (p: fs.PathLike) => {
        if (String(p) === 'Y:\\') throw new Error('EACCES');
        return '\\\\server\\share\\repo';
      }],
    ])('refuses %s, with no git, readdir or folder scan after realpath', async (_name, cwd, real) => {
      realpathSpy.mockImplementation(real);
      await expect(invoke(IPC.DIFF_RESOLVE_REPO, cwd)).resolves.toEqual({ ok: false });
      await expect(invoke(IPC.DIFF_SCAN_REPOS, cwd)).resolves.toEqual({ ok: false });
      expect(gitMock).not.toHaveBeenCalled();
      expect(readdirSpy).not.toHaveBeenCalled();
      expect(scanReposMock).not.toHaveBeenCalled();
    });

    it('diff:scanRepos answers every repo in drive spelling', async () => {
      realpathSpy.mockImplementation(onZ);
      gitMock.mockImplementation(async (_args: string[], cwd: string) => ({ code: 0, stdout: gitTop(cwd), stderr: '' }));
      scanReposMock.mockImplementation(async (root: string, toplevelOf: (dir: string) => Promise<string | null>) =>
        (await Promise.all(['alpha', 'beta'].map((n) => toplevelOf(`${root}\\${n}`)))).filter(Boolean));
      await expect(invoke(IPC.DIFF_SCAN_REPOS, 'Z:\\work\\two')).resolves.toEqual({
        ok: true,
        repoPaths: ['Z:\\work\\two\\alpha', 'Z:\\work\\two\\beta'],
      });
    });
  });
});
