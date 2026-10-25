// The native plumbing of the elevated Fix, exercised WITHOUT elevation: the
// `open` verb runs cmd.exe as this user (no consent prompt), so the struct
// layout, the async ShellExecuteExW, the out-parameter hProcess, the wait and
// the exit code are all real. A missing program proves GetLastError() reads
// the failed call's own error across the async boundary. The `runas` path
// itself (and its 1223) is only run by the CI firewall round trip.
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { shellExecuteAndWait, tokenElevationType } from '../elevate';

const system32 = path.win32.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32');

describe.runIf(process.platform === 'win32')('shellExecuteAndWait (open verb, no elevation)', () => {
  it('starts the program hidden, waits for it and reads its exit code', async () => {
    const r = await shellExecuteAndWait({ verb: 'open', file: path.win32.join(system32, 'cmd.exe'), parameters: '/d /c exit 7', hwnd: null });
    expect(r).toEqual({ started: true, lastError: null, exitCode: 7 });
  }, 30_000);

  it('a program that does not exist: FALSE and its Win32 error, no dialog', async () => {
    const r = await shellExecuteAndWait({ verb: 'open', file: path.win32.join(system32, 'wmux-no-such-program-a6.exe'), parameters: '', hwnd: null });
    expect(r.started).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.lastError).toBe(2); // ERROR_FILE_NOT_FOUND
  }, 30_000);

  it('refuses a relative program path', async () => {
    await expect(shellExecuteAndWait({ verb: 'open', file: 'cmd.exe', parameters: '', hwnd: null })).rejects.toThrow(/absolute/);
  });

  it('reads the token elevation type (1, 2 or 3)', () => {
    expect([1, 2, 3]).toContain(tokenElevationType());
  });
});
