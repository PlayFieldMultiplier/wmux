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
});
