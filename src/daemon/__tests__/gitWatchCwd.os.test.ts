import { describe, expect, it } from 'vitest';
import { gitWatchCwdFor } from '../gitWatchCwd';

// #2407: the git watcher runs on the Windows side and must be handed a path
// it can read, while the session keeps its Linux cwd.
describe('gitWatchCwdFor', () => {
  const wsl = { cmd: 'C:\\Windows\\System32\\wsl.exe', wslTarget: { distribution: 'Ubuntu-24.04' } };

  it('a drive-mount path is the host folder it names', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/wmux-work/repo' }, 'win32')).toBe('D:\\wmux-work\\repo');
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/c' }, 'win32')).toBe('C:\\');
  });

  it('a path inside the distro is passed as given: never read over \\\\wsl$ from the daemon', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/home/dev/e2e-wsl-2403' }, 'win32')).toBe('/home/dev/e2e-wsl-2403');
  });

  it('a wsl.exe session with no distro recorded maps the drive mount too', () => {
    expect(gitWatchCwdFor({ cmd: 'wsl.exe', cwd: '/mnt/c/repo' }, 'win32')).toBe('C:\\repo');
  });

  it('a Windows shell\'s path is never touched', () => {
    expect(gitWatchCwdFor({ cmd: 'pwsh.exe', cwd: 'D:\\repo' }, 'win32')).toBe('D:\\repo');
    expect(gitWatchCwdFor({ cmd: 'C:\\Program Files\\Git\\bin\\bash.exe', cwd: '/c/repo' }, 'win32')).toBe('/c/repo');
    expect(gitWatchCwdFor({ cmd: 'pwsh.exe', cwd: '/mnt/d/repo' }, 'win32')).toBe('/mnt/d/repo');
  });

  it('a path Windows would read as another directory is passed as given rather than translated', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/repo/..\\other' }, 'win32')).toBe('/mnt/d/repo/..\\other');
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/x/repo.' }, 'win32')).toBe('/mnt/d/x/repo.');
  });

  it('off win32 every cwd is the identity', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/repo' }, 'linux')).toBe('/mnt/d/repo');
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/repo' }, 'darwin')).toBe('/mnt/d/repo');
  });
});
