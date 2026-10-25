// GetSystemDirectoryW and the local-fixed-drive check, read for real (both
// read-only). Windows only: elsewhere the helpers answer "cannot tell".
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { onLocalFixedDrive, systemDirectory } from '../netWinPaths';

describe.runIf(process.platform === 'win32')('netWinPaths (win32)', () => {
  it('System32 comes from Windows, not from the environment', () => {
    const dir = systemDirectory();
    expect(dir).toMatch(/^[A-Za-z]:\\.+\\system32$/i);
    expect(fs.existsSync(path.win32.join(dir ?? '', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))).toBe(true);
  });

  it('the system drive is a local fixed disk; a share, a relative path and an absent drive are not', () => {
    expect(onLocalFixedDrive(path.win32.join(systemDirectory() ?? 'C:\\Windows\\System32', 'cmd.exe'))).toBe(true);
    expect(onLocalFixedDrive('\\\\server\\share\\wmux.exe')).toBe(false);
    expect(onLocalFixedDrive('wmux.exe')).toBe(false);
    const absent = 'QRSTUVWXYZ'.split('').find((d) => !fs.existsSync(`${d}:\\`));
    if (absent) expect(onLocalFixedDrive(`${absent}:\\apps\\wmux.exe`)).toBe(false);
  });
});

describe.runIf(process.platform !== 'win32')('netWinPaths (elsewhere)', () => {
  it('cannot tell, so nothing is run and no rule is offered', () => {
    expect(systemDirectory()).toBeNull();
    expect(onLocalFixedDrive('C:\\x\\wmux.exe')).toBe(false);
  });
});
