import { describe, expect, it } from 'vitest';
import { gitWatchCwdFor } from '../gitWatchCwd';

// #2407: the git watcher runs on the Windows side and must be handed a path
// it can read, while the session keeps its Linux cwd.
describe('gitWatchCwdFor', () => {
  const wsl = { cmd: 'C:\\Windows\\System32\\wsl.exe', wslTarget: { distribution: 'Ubuntu-24.04' } };

  it('a distro path goes through the \\\\wsl$ share of the pane\'s own distro', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/home/dev/e2e-wsl-2403' }, 'win32'))
      .toBe('\\\\wsl$\\Ubuntu-24.04\\home\\dev\\e2e-wsl-2403');
  });

  it('a drive-mount path is the host folder it names', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/wmux-work/repo' }, 'win32')).toBe('D:\\wmux-work\\repo');
  });

  it('a wsl.exe session with no distro recorded still maps the drive mount, and keeps a distro path as given', () => {
    const noTarget = { cmd: 'wsl.exe' };
    expect(gitWatchCwdFor({ ...noTarget, cwd: '/mnt/c/repo' }, 'win32')).toBe('C:\\repo');
    expect(gitWatchCwdFor({ ...noTarget, cwd: '/home/dev/repo' }, 'win32')).toBe('/home/dev/repo');
  });

  it('a Windows shell\'s path is never touched', () => {
    expect(gitWatchCwdFor({ cmd: 'pwsh.exe', cwd: 'D:\\repo' }, 'win32')).toBe('D:\\repo');
    expect(gitWatchCwdFor({ cmd: 'C:\\Program Files\\Git\\bin\\bash.exe', cwd: '/c/repo' }, 'win32')).toBe('/c/repo');
  });

  it('a path Windows would read as another directory is passed as given rather than translated', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/home/dev/repo/..\\other' }, 'win32')).toBe('/home/dev/repo/..\\other');
  });

  it('off win32 every cwd is the identity', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/home/dev/repo' }, 'linux')).toBe('/home/dev/repo');
    expect(gitWatchCwdFor({ ...wsl, cwd: '/home/dev/repo' }, 'darwin')).toBe('/home/dev/repo');
  });
});
