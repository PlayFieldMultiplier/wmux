// GetSystemDirectoryW and the local-fixed-drive check, read for real (both
// read-only). Windows only: elsewhere the helpers answer "cannot tell".
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { canonicalExePath, longPathName, onLocalFixedDrive, systemDirectory } from '../netWinPaths';

/** GetShortPathNameW, for a real 8.3 alias to expand (test only). */
function shortPathName(p: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi') as { load(name: string): { func(name: string, result: string, args: string[]): (...a: unknown[]) => number } };
  const f = koffi.load('kernel32.dll').func('GetShortPathNameW', 'uint32', ['str16', 'void *', 'uint32']);
  const buf = Buffer.alloc(32_768 * 2);
  const n = f(p, buf, 32_768);
  return n > 0 && n < 32_768 ? buf.toString('utf16le', 0, n * 2) : null;
}

describe.runIf(process.platform === 'win32')('netWinPaths (win32)', () => {
  it('System32 comes from Windows, not from the environment', () => {
    const dir = systemDirectory();
    expect(dir).toMatch(/^[A-Za-z]:\\.+\\system32$/i);
    expect(fs.existsSync(path.win32.join(dir ?? '', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))).toBe(true);
  });

  it('an 8.3 alias expands to the long path the firewall accepts; the program path is that form', () => {
    const long = path.win32.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Common Files');
    const short = shortPathName(long);
    // 8.3 names can be turned off per volume; then there is no alias to expand.
    if (short && short.includes('~')) {
      expect(longPathName(short)?.toLowerCase()).toBe(long.toLowerCase());
      expect(canonicalExePath(short).toLowerCase()).toBe(long.toLowerCase());
    }
    expect(canonicalExePath(process.execPath)).not.toMatch(/\\[^\\]{1,6}~\d/);
    expect(longPathName('C:\\wmux-no-such-folder\\x.exe')).toBeNull();
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
