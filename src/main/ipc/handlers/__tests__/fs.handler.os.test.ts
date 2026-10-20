import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSensitivePath, resolveAccessiblePath } from '../fs.handler';

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(() => []),
  },
}));

describe('fs.handler security helpers', () => {
  // Use an OS-native absolute home path. The previous Windows-only hardcode
  // (`path.join('C:', 'Users', 'tester')`) produced "C:/Users/tester" on
  // Unix, which path.resolve treats as a relative segment under cwd. The
  // resulting absolute path no longer prefix-matches `home`, so
  // isSensitivePath returned false and realpath was unexpectedly called.
  const home = process.platform === 'win32'
    ? path.join('C:', 'Users', 'tester')
    : path.join('/home', 'tester');
  let realpathSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    realpathSpy = vi.spyOn(fs.promises, 'realpath');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats the daemon auth token path as sensitive', () => {
    expect(isSensitivePath(path.join(home, '.wmux', 'daemon-auth-token'))).toBe(true);
  });

  it('rejects a symlink whose canonical target is sensitive', async () => {
    realpathSpy.mockResolvedValue(path.join(home, '.ssh', 'id_rsa'));

    await expect(resolveAccessiblePath(path.join(home, 'project', 'link-to-secret'))).resolves.toBeNull();
  });

  it('rejects a direct sensitive path before canonical lookup', async () => {
    await expect(resolveAccessiblePath(path.join(home, '.wmux-auth-token'))).resolves.toBeNull();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('returns the canonical path for an allowed target', async () => {
    const canonical = path.join(home, 'project', 'src', 'index.ts');
    realpathSpy.mockResolvedValue(canonical);

    await expect(resolveAccessiblePath(path.join(home, 'project', 'src', '..', 'src', 'index.ts'))).resolves.toBe(canonical);
  });

  it.each(['//host/share', '\\\\host\\share', '\\\\server\\share\\repo', '\\\\?\\UNC\\host\\share', '\\\\.\\pipe\\x', '\\\\?\\C:\\x'])(
    'refuses the network or device path %s before canonical lookup',
    async (p) => {
      await expect(resolveAccessiblePath(p)).resolves.toBeNull();
      expect(realpathSpy).not.toHaveBeenCalled();
    },
  );

  it('refuses a non-drive spelling whose real path is a network share', async () => {
    realpathSpy.mockResolvedValue('\\\\server\\share\\repo');
    // Relative, so it is not a drive path on any platform.
    await expect(resolveAccessiblePath(path.join('project', 'link-to-share'))).resolves.toBeNull();
  });

  it('keeps a mapped drive working, spelled from its drive', async () => {
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'Z:\\' ? '\\\\server\\share\\' : '\\\\server\\share\\repo'));
    await expect(resolveAccessiblePath('Z:\\repo')).resolves.toBe('Z:\\repo');
    // The answer and a folder below it pass the check when a caller hands them back.
    await expect(resolveAccessiblePath('Z:\\repo')).resolves.toBe('Z:\\repo');
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'Z:\\' ? '\\\\server\\share\\' : '\\\\server\\share\\repo\\src'));
    await expect(resolveAccessiblePath('Z:\\repo\\src')).resolves.toBe('Z:\\repo\\src');
  });

  it('answers with the drive path when its root does not lead to the share', async () => {
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'D:\\' ? 'D:\\' : '\\\\server\\share\\repo'));
    await expect(resolveAccessiblePath('D:\\work\\link')).resolves.toBe('D:\\work\\link');
    // The answer and a folder below it pass the check again.
    await expect(resolveAccessiblePath('D:\\work\\link')).resolves.toBe('D:\\work\\link');
    await expect(resolveAccessiblePath('D:\\work\\link\\child')).resolves.toBe('D:\\work\\link\\child');
  });

  it('answers with the drive path when the drive root cannot be read', async () => {
    realpathSpy.mockImplementation(async (p: fs.PathLike) => {
      if (p === 'Z:\\') throw new Error('EACCES');
      return '\\\\server\\share\\repo';
    });
    await expect(resolveAccessiblePath('Z:\\repo')).resolves.toBe('Z:\\repo');
  });

  it('refuses a drive path whose real path is a device path', async () => {
    realpathSpy.mockResolvedValue('\\\\?\\GLOBALROOT\\Device\\x');
    await expect(resolveAccessiblePath('Z:\\x')).resolves.toBeNull();
  });

  it('keeps a WSL share as its real path', async () => {
    realpathSpy.mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
    await expect(resolveAccessiblePath(path.join(home, 'project', 'repo'))).resolves.toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
  });

  it('returns null when canonicalization fails', async () => {
    realpathSpy.mockRejectedValue(new Error('ENOENT'));

    await expect(resolveAccessiblePath(path.join(home, 'project', 'missing.txt'))).resolves.toBeNull();
  });
});
