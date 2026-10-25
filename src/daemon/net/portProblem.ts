// === Why a listener could not bind (`net.listenProblem`) ===
//
// Read-only. For a failed bind it reads, on Windows, the ranges Windows
// reserves (`netsh interface ipv4 show excludedportrange protocol=tcp`), the
// port's holder (`netstat -ano -p TCP` → PID → `tasklist`), and suggests the
// first port after it that is outside those ranges and binds on loopback. A
// suggestion only: a loopback bind does not prove the listener's own bind will
// succeed, and a failed rebind keeps the old listener (A2A) or says so again.
//
// Nothing is killed, no range or service is touched. Each tool gets the 3 s
// lookup deadline; a tool that fails or times out just leaves its part empty,
// except the reserved ranges: without them a Windows EACCES is only "denied",
// never guessed to be "in use".
//
// Imports node builtins and shared modules only.

import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {
  classifyListenError,
  holderPids,
  parseExcludedPortRanges,
  parseNetstatListeners,
  parseTasklistImage,
  pickFreePort,
  type ExcludedPortRange,
  type ListenProblemReport,
  type PortHolder,
} from '../../shared/netListen';
import { systemDirectory } from '../../shared/netWinPaths';

export const LOOKUP_TIMEOUT_MS = 3_000;

export type LookupExec = (file: string, args: string[], opts: { timeout: number }) => Promise<string>;

const defaultExec: LookupExec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    // latin1 keeps every byte: the localized headers are skipped, and the
    // columns read (numbers, ASCII image names) are the same in any codepage.
    execFile(file, args, { timeout: opts.timeout, windowsHide: true, encoding: 'latin1' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/** A loopback trial bind: does nothing else hold this port right now? */
export function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}


export interface ListenFailure {
  code: string | null;
  port: number;
  address: string | null;
}

export interface ListenProblemDeps {
  platform?: NodeJS.Platform;
  exec?: LookupExec;
  isFree?: (port: number) => Promise<boolean>;
  /** This daemon's image name (wmux.exe; electron.exe in development): a holder with it is "another copy of wmux". */
  selfImage?: string;
  /** This daemon's PID: a holder with it is one of this wmux's own listeners. */
  selfPid?: number;
  /** System32, where the tools are run from (netWinPaths.ts); null leaves every tool's part empty. */
  system32?: () => string | null;
}

type Tool = (file: string) => string;

/** A System32 tool's absolute path; throws (as a failed tool) when System32 could not be read. */
function toolIn(system32: () => string | null): Tool {
  return (file) => {
    const dir = system32();
    if (!dir) throw new Error('the System32 folder could not be read');
    return path.win32.join(dir, file);
  };
}

/** The ranges Windows reserves, or null when netsh could not be read. */
async function excludedRanges(exec: LookupExec, tool: Tool): Promise<ExcludedPortRange[] | null> {
  try {
    return parseExcludedPortRanges(
      await exec(tool('netsh.exe'), ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { timeout: LOOKUP_TIMEOUT_MS }),
    );
  } catch {
    return null;
  }
}

async function portHolder(port: number, exec: LookupExec, tool: Tool, selfImage: string, selfPid: number): Promise<PortHolder | null> {
  let pid: number | undefined;
  try {
    pid = holderPids(parseNetstatListeners(await exec(tool('NETSTAT.EXE'), ['-ano', '-p', 'TCP'], { timeout: LOOKUP_TIMEOUT_MS })), port)[0];
    if (pid === undefined) {
      pid = holderPids(parseNetstatListeners(await exec(tool('NETSTAT.EXE'), ['-ano', '-p', 'TCPv6'], { timeout: LOOKUP_TIMEOUT_MS })), port)[0];
    }
  } catch {
    return null;
  }
  if (pid === undefined) return null;
  if (pid === selfPid) return { kind: 'self', pid };
  let image: string | null = null;
  try {
    image = parseTasklistImage(await exec(tool('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: LOOKUP_TIMEOUT_MS }), pid);
  } catch {
    image = null;
  }
  if (!image) return { kind: 'unnamed', pid };
  if (image.toLowerCase() === selfImage.toLowerCase()) return { kind: 'wmux', pid };
  return { kind: 'process', pid, image };
}

export async function diagnoseListenProblem(failure: ListenFailure, deps: ListenProblemDeps = {}): Promise<ListenProblemReport> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  const isFree = deps.isFree ?? loopbackPortFree;
  const selfImage = deps.selfImage ?? path.basename(process.execPath);
  const selfPid = deps.selfPid ?? process.pid;
  const tool = toolIn(deps.system32 ?? systemDirectory);
  const ranges = platform === 'win32' ? await excludedRanges(exec, tool) : [];
  const problem = classifyListenError(failure.code, failure.port, platform, ranges, failure.address);
  if (problem.kind === 'address-gone' || problem.kind === 'other') return { problem, holder: null, suggestion: null };
  const [holder, suggestion] = await Promise.all([
    problem.kind === 'port-in-use' && platform === 'win32' ? portHolder(failure.port, exec, tool, selfImage, selfPid) : Promise.resolve(null),
    pickFreePort(failure.port, ranges ?? [], isFree),
  ]);
  return { problem, holder, suggestion };
}
