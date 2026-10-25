// === Run one program through the Windows consent prompt and wait for it ===
//
// The firewall Fix and Remove need administrator rights; wmux does not have
// them and must not keep them. Each click runs one Windows PowerShell through
// ShellExecuteExW with the `runas` verb, which shows the consent (or
// credential) prompt. Called from main only, never from the daemon, never
// without a click.
//
// koffi, the same loading pattern as selfElevation.ts. ShellExecuteExW blocks
// until the prompt is answered, and the wait for the child can take seconds,
// so both run through koffi's async calls on its worker pool: the main
// (UI) thread keeps pumping messages and the window never reads as "Not
// responding".
//
// No stderr crosses an elevated boundary, so nothing here reads text:
// - ShellExecuteExW FALSE + GetLastError() 1223 (ERROR_CANCELLED) means the
//   prompt was declined.
// - Otherwise the child's exit code (GetExitCodeProcess) is the answer; the
//   scripts exit 10/11/12 per failed stage.
// koffi saves the thread's last error right after every call (async ones too,
// on the worker that made it) and restores it before the next call, so the
// GetLastError() issued right after the async ShellExecuteExW completes reads
// that call's error. This holds while no other koffi async call completes in
// between; main makes none (one elevation at a time, see firewallFix.ts).

import path from 'node:path';

const SEE_MASK_NOCLOSEPROCESS = 0x40;
const SEE_MASK_NOASYNC = 0x100;
/** No error message box of ShellExecuteEx's own (a hidden window could never be answered). */
const SEE_MASK_FLAG_NO_UI = 0x400;
const SW_HIDE = 0;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;
/** How long to wait for the elevated child once it started. */
export const ELEVATED_WAIT_MS = 60_000;
/** After that wait, how often to look whether the child has exited. */
export const ELEVATED_POLL_MS = 2_000;
/**
 * How long a child that outlived the wait is tracked at most. A firewall
 * script that has not ended in 10 minutes is wedged (a hung PowerShell
 * start); past that the slot is released rather than held until restart.
 */
export const ELEVATED_TRACK_MS = 10 * 60_000;

export interface ShellRunResult {
  /** ShellExecuteExW returned TRUE (the child started). */
  started: boolean;
  /** GetLastError() right after a FALSE return; null when it started. */
  lastError: number | null;
  /** The child's exit code; null when it did not start, the wait timed out, or the code could not be read. */
  exitCode: number | null;
  /**
   * Only when the wait timed out: the child still runs (a medium-integrity
   * wmux cannot end an elevated one), and this settles when it exits, or
   * after ELEVATED_TRACK_MS. The caller starts no second elevation before
   * then.
   */
  stillRunning?: Promise<void>;
}

type KoffiFn = ((...args: unknown[]) => unknown) & { async: (...args: unknown[]) => void };
interface Win32 {
  ShellExecuteExW: KoffiFn;
  GetLastError: KoffiFn;
  WaitForSingleObject: KoffiFn;
  GetExitCodeProcess: KoffiFn;
  CloseHandle: KoffiFn;
  sizeofSei: number;
}

let win32: Win32 | null = null;

function load(): Win32 {
  if (win32) return win32;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi') as {
    load(name: string): { func(signature: string): KoffiFn };
    struct(name: string, fields: Record<string, string>): unknown;
    sizeof(type: unknown): number;
  };
  // SHELLEXECUTEINFOW. Handles and HWND as 64-bit integers: wmux ships x64 and arm64 only.
  const sei = koffi.struct('WMUX_SHELLEXECUTEINFOW', {
    cbSize: 'uint32',
    fMask: 'uint32',
    hwnd: 'int64',
    lpVerb: 'str16',
    lpFile: 'str16',
    lpParameters: 'str16',
    lpDirectory: 'str16',
    nShow: 'int',
    hInstApp: 'int64',
    lpIDList: 'void *',
    lpClass: 'str16',
    hkeyClass: 'int64',
    dwHotKey: 'uint32',
    hIconOrMonitor: 'int64',
    hProcess: 'int64',
  });
  const shell32 = koffi.load('shell32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  win32 = {
    ShellExecuteExW: shell32.func('int __stdcall ShellExecuteExW(_Inout_ WMUX_SHELLEXECUTEINFOW *pExecInfo)'),
    GetLastError: kernel32.func('uint32 __stdcall GetLastError()'),
    WaitForSingleObject: kernel32.func('uint32 __stdcall WaitForSingleObject(int64 hHandle, uint32 dwMilliseconds)'),
    GetExitCodeProcess: kernel32.func('int __stdcall GetExitCodeProcess(int64 hProcess, _Out_ uint32 *lpExitCode)'),
    CloseHandle: kernel32.func('int __stdcall CloseHandle(int64 hObject)'),
    sizeofSei: koffi.sizeof(sei),
  };
  return win32;
}

function callAsync<T>(fn: KoffiFn, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (err: unknown, res: T) => (err ? reject(err) : resolve(res)));
  });
}

export interface ShellRunOptions {
  /** `runas` to elevate. Tests use `open`, which never prompts. */
  verb: 'runas' | 'open';
  /** An absolute path: no PATH lookup. */
  file: string;
  parameters: string;
  /** The window that parents the consent prompt (BrowserWindow.getNativeWindowHandle()), or null. */
  hwnd: Buffer | null;
  waitMs?: number;
  /** How long a child that outlived `waitMs` is tracked (ELEVATED_TRACK_MS). */
  trackMs?: number;
}

function hwndValue(buf: Buffer | null): bigint {
  if (!buf || buf.length === 0) return 0n;
  return buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0));
}

/**
 * Look at a child that outlived the wait every ELEVATED_POLL_MS, with a
 * zero-timeout wait on the JS thread: a blocking wait would hold one of
 * libuv's four pool threads for as long as a wedged PowerShell lives. Gives
 * up after `trackMs`.
 */
function whenExited(w: Win32, handle: bigint, trackMs: number): Promise<void> {
  const until = Date.now() + trackMs;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (w.WaitForSingleObject(handle, 0) === WAIT_TIMEOUT && Date.now() < until) return;
      clearInterval(timer);
      w.CloseHandle(handle);
      resolve();
    }, ELEVATED_POLL_MS);
    timer.unref?.();
  });
}

/** Start `file` through ShellExecuteExW and wait for it to exit. Windows only. */
export async function shellExecuteAndWait(opts: ShellRunOptions): Promise<ShellRunResult> {
  if (process.platform !== 'win32') throw new Error('shellExecuteAndWait: Windows only');
  // A drive path: `path.win32.isAbsolute` also takes a UNC share.
  if (!/^[A-Za-z]:\\/.test(opts.file) || !path.win32.isAbsolute(opts.file)) throw new Error('shellExecuteAndWait: the program must be an absolute drive path');
  const w = load();
  const sei: Record<string, unknown> = {
    cbSize: w.sizeofSei,
    fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
    hwnd: hwndValue(opts.hwnd),
    lpVerb: opts.verb,
    lpFile: opts.file,
    lpParameters: opts.parameters,
    lpDirectory: null,
    nShow: SW_HIDE,
    hInstApp: 0,
    lpIDList: null,
    lpClass: null,
    hkeyClass: 0,
    dwHotKey: 0,
    hIconOrMonitor: 0,
    hProcess: 0,
  };
  const ok = await callAsync<number>(w.ShellExecuteExW, sei);
  if (!ok) return { started: false, lastError: w.GetLastError() as number, exitCode: null };
  const handle = BigInt(sei['hProcess'] as number | bigint);
  // NOCLOSEPROCESS can still leave no handle (the request went to an existing
  // process): nothing to wait on or track, so nothing holds the caller's slot.
  if (handle === 0n) return { started: true, lastError: null, exitCode: null };
  let keep = false;
  try {
    const waited = await callAsync<number>(w.WaitForSingleObject, handle, opts.waitMs ?? ELEVATED_WAIT_MS);
    if (waited === WAIT_TIMEOUT) {
      keep = true;
      return { started: true, lastError: null, exitCode: null, stillRunning: whenExited(w, handle, opts.trackMs ?? ELEVATED_TRACK_MS) };
    }
    if (waited !== WAIT_OBJECT_0) return { started: true, lastError: null, exitCode: null };
    const code = [0];
    if (!w.GetExitCodeProcess(handle, code)) return { started: true, lastError: null, exitCode: null };
    return { started: true, lastError: null, exitCode: code[0] };
  } finally {
    if (!keep) w.CloseHandle(handle);
  }
}

const TOKEN_QUERY = 0x0008;
const TOKEN_ELEVATION_TYPE = 18;
const CURRENT_PROCESS = -1;

let elevationType: number | null | undefined;

/**
 * TOKEN_ELEVATION_TYPE of wmux's own token: 1 Default (no split token: a
 * standard user, or UAC off), 2 Full (elevated), 3 Limited (an admin's
 * filtered token: the prompt asks Yes/No). Null when it cannot be read.
 */
export function tokenElevationType(): number | null {
  if (elevationType !== undefined) return elevationType;
  elevationType = null;
  if (process.platform !== 'win32') return elevationType;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as {
      load(name: string): { func(name: string, result: string, args: string[]): (...args: unknown[]) => number };
    };
    const advapi32 = koffi.load('advapi32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const openProcessToken = advapi32.func('OpenProcessToken', 'int', ['int64', 'uint32', 'void *']);
    const getTokenInformation = advapi32.func('GetTokenInformation', 'int', ['int64', 'int', 'void *', 'uint32', 'void *']);
    const closeHandle = kernel32.func('CloseHandle', 'int', ['int64']);
    const handle = Buffer.alloc(8);
    if (!openProcessToken(CURRENT_PROCESS, TOKEN_QUERY, handle)) return elevationType;
    const token = handle.readBigInt64LE(0);
    try {
      const out = Buffer.alloc(4);
      const returned = Buffer.alloc(4);
      if (getTokenInformation(token, TOKEN_ELEVATION_TYPE, out, 4, returned)) elevationType = out.readUInt32LE(0);
    } finally {
      closeHandle(token);
    }
  } catch {
    // Unknown: the hint falls back to the consent wording.
  }
  return elevationType;
}
