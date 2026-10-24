/**
 * Windows: put the CLI's stdout and stderr on the console they were meant for (#2672).
 *
 * wmux.exe is Electron run as Node, a GUI-subsystem program, and that breaks
 * its console output two ways:
 *   - With nothing redirected, Electron attaches to the parent console and
 *     points both streams at a write-only CONOUT$. Node cannot read that
 *     handle's console mode, takes it for a file and writes UTF-8 bytes, which
 *     the console decodes in its code page (949 garbles Korean).
 *   - With a stream redirected (`> file`, `| more`, `2> file`), Electron does
 *     not attach, and the stream left on the console arrives as a NULL std
 *     handle: everything written to it is lost.
 *
 * A stream that is not already a TTY or a pipe, and whose std handle is the
 * console or none at all, becomes a tty.WriteStream on CONOUT$ opened for
 * reading and writing: libuv writes that with WriteConsoleW, intact in any
 * code page. When CONOUT$ cannot be opened the process is attached to the
 * parent's console first. A stream redirected to a file, a pipe or NUL is left
 * alone, and any failure leaves today's streams.
 */
import fs from 'node:fs';
import net from 'node:net';
import tty from 'node:tty';

const CONOUT = '\\\\.\\CONOUT$';
/** GetStdHandle's STD_OUTPUT_HANDLE and STD_ERROR_HANDLE, as DWORDs. */
const STD_HANDLE = { stdout: 0xfffffff5, stderr: 0xfffffff4 } as const;
const ATTACH_PARENT_PROCESS = 0xffffffff;
/** NtQueryVolumeInformationFile's FileFsDeviceInformation, and its DeviceType for a console. */
const FILE_FS_DEVICE_INFORMATION = 4;
const FILE_DEVICE_CONSOLE = 0x50;

type StdName = keyof typeof STD_HANDLE;

interface Kernel {
  /** Whether this stream's std handle is the console, or none at all. */
  consoleOrNone(name: StdName): boolean;
  attachToParentConsole(): void;
}

type Koffi = { load(lib: string): { func(signature: string): (...args: unknown[]) => unknown } };

/** koffi is native and ships beside this bundle; without it the CLI keeps today's streams. */
function loadKernel(): Kernel | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as Koffi;
    const kernel32 = koffi.load('kernel32.dll');
    const ntdll = koffi.load('ntdll.dll');
    const getStdHandle = kernel32.func('void * __stdcall GetStdHandle(uint32_t which)');
    const attachConsole = kernel32.func('int __stdcall AttachConsole(uint32_t pid)');
    const queryVolume = ntdll.func('int32_t __stdcall NtQueryVolumeInformationFile(void *handle, _Out_ uint8_t *status, _Out_ uint8_t *info, uint32_t length, int32_t infoClass)');
    return {
      consoleOrNone(name) {
        try {
          const handle = getStdHandle(STD_HANDLE[name]);
          if (handle === null) return true;
          const info = Buffer.alloc(8);
          return queryVolume(handle, Buffer.alloc(16), info, info.length, FILE_FS_DEVICE_INFORMATION) === 0 &&
            info.readUInt32LE(0) === FILE_DEVICE_CONSOLE;
        } catch {
          return false;
        }
      },
      attachToParentConsole() {
        try { attachConsole(ATTACH_PARENT_PROCESS); } catch { /* the open that follows tells */ }
      },
    };
  } catch {
    return null;
  }
}

function openConsole(): number | undefined {
  try { return fs.openSync(CONOUT, 'r+'); } catch { return undefined; }
}

export function routeConsoleStdio(): void {
  if (process.platform !== 'win32') return;
  const candidates = (['stdout', 'stderr'] as const).filter((name) => {
    const stream = process[name];
    return !stream.isTTY && !(stream instanceof net.Socket);
  });
  if (candidates.length === 0) return;
  const kernel = loadKernel();
  if (!kernel) return;
  const targets = candidates.filter((name) => kernel.consoleOrNone(name));
  if (targets.length === 0) return;
  let fd = openConsole();
  if (fd === undefined) {
    kernel.attachToParentConsole();
    fd = openConsole();
  }
  for (const name of targets) {
    fd ??= openConsole();
    if (fd === undefined) return;
    let stream: tty.WriteStream;
    try {
      stream = new tty.WriteStream(fd);
    } catch {
      fs.closeSync(fd);
      return;
    }
    fd = undefined;
    Object.defineProperty(process, name, { configurable: true, enumerable: true, get: () => stream });
    // The global console may already hold the stream it replaces.
    (console as unknown as Record<string, unknown>)[name === 'stdout' ? '_stdout' : '_stderr'] = stream;
  }
}
