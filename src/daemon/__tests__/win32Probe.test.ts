import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1493: the Windows probes moved from wmic.exe to CIM through PowerShell.
// #2398: the per-process reads then moved to native calls; only the boot ID
// still runs PowerShell. These pin the parsing and the fail-closed contract
// with a mocked execFile and native read; win32Probe.runtime.test.ts proves
// the real probes on a Windows box.
const { execFileMock, execFileSyncMock, tryProcessIdentityMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  tryProcessIdentityMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));
vi.mock('../../main/pty/winSnapshotNative', () => ({ tryProcessIdentity: tryProcessIdentityMock }));

import {
  classifyReapIdentity,
  getProcessCreatedAtFt,
  getProcessStartTime,
  getWin32BootId,
  getWin32BootIdSync,
  isWin32ShellProcess,
  parseWin32BootId,
  resetNativeProcessReadWarn,
  resetWin32BootIdCache,
  setNativeProcessReadWarn,
} from '../phantomExit';

type Callback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

function execFileReturns(stdout: string): void {
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Callback) => {
    cb(null, { stdout, stderr: '' });
  });
}

function execFileFails(message: string): void {
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Callback) => {
    cb(new Error(message));
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  execFileSyncMock.mockReset();
  tryProcessIdentityMock.mockReset();
  resetWin32BootIdCache();
  resetNativeProcessReadWarn();
  setNativeProcessReadWarn(() => undefined);
});

describe('parseWin32BootId', () => {
  it('reads the wmic-format DMTF boot time', () => {
    expect(parseWin32BootId('LastBootUpTime=20260915084549.500977+540\r\n')).toBe(
      '20260915084549.500977+540',
    );
  });

  it('accepts a negative UTC offset', () => {
    expect(parseWin32BootId('LastBootUpTime=20260915084549.500977-420')).toBe(
      '20260915084549.500977-420',
    );
  });

  it('rejects empty or malformed output', () => {
    expect(parseWin32BootId('')).toBeNull();
    expect(parseWin32BootId('LastBootUpTime=')).toBeNull();
    expect(parseWin32BootId('LastBootUpTime=9/15/2026 8:45:49 AM')).toBeNull();
  });
});

describe('getWin32BootId', () => {
  it('runs Windows PowerShell with a CIM query, never wmic', async () => {
    execFileReturns('LastBootUpTime=20260915084549.500977+540\r\n');
    await expect(getWin32BootId()).resolves.toBe('20260915084549.500977+540');
    const [file, args] = execFileMock.mock.calls[0];
    expect(String(file).toLowerCase()).toMatch(/windowspowershell\\v1\.0\\powershell\.exe$/);
    expect(String(file).toLowerCase()).not.toContain('wmic');
    expect(args.join(' ')).toContain('Win32_OperatingSystem');
  });

  it('memoizes the first good read, sync and async alike', async () => {
    execFileReturns('LastBootUpTime=20260915084549.500977+540');
    await getWin32BootId();
    await getWin32BootId();
    expect(getWin32BootIdSync()).toBe('20260915084549.500977+540');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('throws on a probe failure so the caller keeps its fallback', async () => {
    execFileFails('spawn ENOENT');
    await expect(getWin32BootId()).rejects.toThrow();
  });

  it('throws on unparseable output instead of caching garbage', async () => {
    execFileReturns('');
    await expect(getWin32BootId()).rejects.toThrow();
    execFileReturns('LastBootUpTime=20260915084549.500977+540');
    await expect(getWin32BootId()).resolves.toBe('20260915084549.500977+540');
  });

  it('sync read parses the same output', () => {
    execFileSyncMock.mockReturnValue('LastBootUpTime=20260915084549.500977+540\r\n');
    expect(getWin32BootIdSync()).toBe('20260915084549.500977+540');
  });
});

// #2398: process start time and executable are read natively now.
const FT = 134296036801234567n; // 2026-07-27T05:28:00.1234567Z

function identityReturns(imagePath: string | null, createdAt = FT): void {
  tryProcessIdentityMock.mockReturnValue({ createdAt, imagePath });
}

const withPlatform = <T>(platform: NodeJS.Platform, body: () => T): T => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return body();
  } finally {
    if (orig) Object.defineProperty(process, 'platform', orig);
  }
};

describe('process start time', () => {
  it('is the native FILETIME, with no subprocess', async () => {
    identityReturns('C:\\x\\cmd.exe');
    expect(withPlatform('win32', () => getProcessCreatedAtFt(4321))).toBe(FT);
    await expect(withPlatform('win32', () => getProcessStartTime(4321))).resolves.toBe('134296036801234567');
    expect(tryProcessIdentityMock).toHaveBeenCalledWith(4321);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('is null when the read fails (fail closed)', () => {
    tryProcessIdentityMock.mockReturnValue({ failure: 'OpenProcess failed (error 5)', gone: false });
    expect(withPlatform('win32', () => getProcessCreatedAtFt(4321))).toBeNull();
  });

  it('is never read natively off Windows', () => {
    identityReturns('/bin/bash');
    expect(withPlatform('linux', () => getProcessCreatedAtFt(4321))).toBeNull();
    expect(tryProcessIdentityMock).not.toHaveBeenCalled();
  });
});

describe('failed native reads', () => {
  it('log one line a minute, counting the failures in between', () => {
    const warn = vi.fn();
    setNativeProcessReadWarn(warn);
    vi.useFakeTimers();
    try {
      tryProcessIdentityMock.mockReturnValue({ failure: 'OpenProcess failed (error 5)', gone: false });
      for (let pid = 1; pid <= 5; pid++) withPlatform('win32', () => getProcessCreatedAtFt(pid));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('pid 1: OpenProcess failed (error 5)');
      vi.advanceTimersByTime(60_000);
      withPlatform('win32', () => getProcessCreatedAtFt(6));
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1][0]).toContain('pid 6: OpenProcess failed (error 5) (4 more since the last warning)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('do not count a pid that is gone', () => {
    const warn = vi.fn();
    setNativeProcessReadWarn(warn);
    tryProcessIdentityMock.mockReturnValue({ failure: 'OpenProcess failed (error 87)', gone: true });
    expect(withPlatform('win32', () => getProcessCreatedAtFt(99))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('isWin32ShellProcess', () => {
  it('matches the executable basename case-insensitively', async () => {
    identityReturns('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    await expect(isWin32ShellProcess(10, 'PowerShell.exe')).resolves.toBe(true);
  });

  it('matches a full expected path', async () => {
    identityReturns('C:\\Program Files\\Git\\bin\\bash.exe');
    await expect(isWin32ShellProcess(11, 'C:\\Program Files\\Git\\bin\\bash.exe')).resolves.toBe(true);
  });

  it('rejects a different executable', async () => {
    identityReturns('C:\\Windows\\System32\\notepad.exe');
    await expect(isWin32ShellProcess(12, 'powershell.exe')).resolves.toBe(false);
  });

  it('false when the path is withheld or the read fails', async () => {
    identityReturns(null);
    await expect(isWin32ShellProcess(13, 'cmd.exe')).resolves.toBe(false);
    tryProcessIdentityMock.mockReturnValue({ failure: 'boom', gone: false });
    await expect(isWin32ShellProcess(14, 'cmd.exe')).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('start-time compatibility with pre-#2398 records', () => {
  it('a DMTF pidStartTime from the CIM/wmic era authorizes against the native FILETIME', () => {
    // CIM printed `20260727142800.123456+540` for this process: the same
    // instant in UTC+9, truncated to microseconds.
    expect(
      classifyReapIdentity({ storedStartTime: '20260727142800.123456+540', currentCreatedAtFt: FT, looksLikeOurShell: false }),
    ).toBe('start-time');
  });

  it('an unreadable start time still refuses the kill', () => {
    expect(
      classifyReapIdentity({ storedStartTime: '20260727142800.123456+540', currentCreatedAtFt: null, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });
});
