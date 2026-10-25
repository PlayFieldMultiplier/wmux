// === What the firewall Fix needs to know about Windows paths, read through koffi ===
//
// - System32 comes from GetSystemDirectoryW, never from the SystemRoot
//   environment variable: whoever sets that variable would choose the
//   powershell.exe that runs elevated (and mmc.exe elevates itself).
// - A rule is made only for a program on a local fixed disk. A mapped
//   network drive or a SUBST drive is a per-logon letter that the elevated
//   session and the firewall service do not see, and a removable drive may
//   be gone the next time a Fix's cleanup looks.
//
// Main and the daemon both use it. koffi is required at runtime (external to
// the bundle), as in elevate.ts and paneJob.ts.

const DRIVE_FIXED = 3;
const MAX_PATH_CHARS = 520;

interface Kernel32Paths {
  GetSystemDirectoryW(buf: Buffer, size: number): number;
  GetDriveTypeW(root: string): number;
  QueryDosDeviceW(name: string, buf: Buffer, size: number): number;
}

let kernel32: Kernel32Paths | null | undefined;

function load(): Kernel32Paths | null {
  if (kernel32 !== undefined) return kernel32;
  kernel32 = null;
  if (process.platform !== 'win32') return kernel32;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as { load(name: string): { func(name: string, result: string, args: string[]): unknown } };
    const k32 = koffi.load('kernel32.dll');
    kernel32 = {
      GetSystemDirectoryW: k32.func('GetSystemDirectoryW', 'uint32', ['void *', 'uint32']) as Kernel32Paths['GetSystemDirectoryW'],
      GetDriveTypeW: k32.func('GetDriveTypeW', 'uint32', ['str16']) as Kernel32Paths['GetDriveTypeW'],
      QueryDosDeviceW: k32.func('QueryDosDeviceW', 'uint32', ['str16', 'void *', 'uint32']) as Kernel32Paths['QueryDosDeviceW'],
    };
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

let systemDir: string | null | undefined;

/** `C:\Windows\System32` as Windows reports it, or null when it cannot be read (then nothing is run from it). */
export function systemDirectory(): string | null {
  if (systemDir !== undefined) return systemDir;
  const k = load();
  if (!k) return null;
  const buf = Buffer.alloc(MAX_PATH_CHARS * 2);
  const n = k.GetSystemDirectoryW(buf, MAX_PATH_CHARS);
  const dir = n > 0 && n < MAX_PATH_CHARS ? buf.toString('utf16le', 0, n * 2) : '';
  systemDir = /^[A-Za-z]:\\/.test(dir) ? dir : null;
  return systemDir;
}

/** The program's drive is a local fixed disk: not a network share, a SUBST alias or a removable drive. */
export function onLocalFixedDrive(p: string): boolean {
  const m = /^([A-Za-z]:)\\/.exec(p);
  const k = load();
  if (!m || !k) return false;
  if (k.GetDriveTypeW(`${m[1]}\\`) !== DRIVE_FIXED) return false;
  // A SUBST letter maps to a folder (`\??\C:\dir`), a volume to a device (`\Device\HarddiskVolume3`).
  const buf = Buffer.alloc(MAX_PATH_CHARS * 2);
  const n = k.QueryDosDeviceW(m[1], buf, MAX_PATH_CHARS);
  if (n === 0) return false;
  return buf.toString('utf16le', 0, n * 2).split('\0')[0].startsWith('\\Device\\');
}
