import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {sendRequest,setWorkspaceToken} from '../client';
import {resolveSelfContext,getParentPidDefault} from '../identity';
import {resolveCodexManagedExecutable} from '../../shared/codexManagedExecutable';
import {tokenizeCommandLine} from '../../mcp/codexThreadIdentity';

/** wmux.cmd's private steps for `wmux codex` (see buildShimCmd). */
export const CODEX_HANDOFF_FLAG = '--wmux-handoff';
export const CODEX_RELEASE_FLAG = '--wmux-release';
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CodexLaunch {
  executable:string;
  codeHome:string;
  url:string;
  authToken:string;
  leaseId:string;
  /** The caller's directory, when the arguments name none. */
  cd?:string;
}

/** Reserve this pane's Codex relay lease for a launch with `args`. */
async function prepareLaunch(args:string[]):Promise<CodexLaunch> {
  if (process.platform !== 'win32') throw new Error('wmux codex currently supports native Windows terminals.');
  if (args.some(arg=>arg === '--no-daemon' || /^--remote(?:=|$)/.test(arg) || /^--remote-auth-token-env(?:=|$)/.test(arg))) {
    throw new Error('wmux codex owns its pane connection. Use native codex for --no-daemon or a custom --remote.');
  }
  const self = await resolveSelfContext({sendRequest,env:process.env,ppid:process.ppid,
    callerPid:process.pid,getParentPid:getParentPidDefault});
  if (!self.ptyId || !self.workspaceToken) throw new Error('Run wmux codex directly in a wmux terminal pane.');
  setWorkspaceToken(self.workspaceToken);
  const codeHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'));
  // Outlive main's 100s deadline and the runtime's lock/version/start/probe bounds.
  const response = await sendRequest('codex.relay.prepare',{codeHome},110_000);
  if (!response.ok) throw new Error(response.error);
  const lease = response.result as {url?:unknown;authToken?:unknown;leaseId?:unknown};
  if (typeof lease?.leaseId !== 'string') throw new Error('wmux returned no Codex pane lease.');
  try {
    if (typeof lease.url !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(lease.url) ||
        typeof lease.authToken !== 'string' || !/^[a-f0-9]{64}$/.test(lease.authToken) ||
        !LEASE_ID.test(lease.leaseId)) throw new Error('Invalid Codex pane connection.');
    const executable = resolveCodexManagedExecutable(codeHome);
    // --cd keeps a TUI in the caller's directory rather than the daemon's cwd.
    const hasCwd = args.some(arg=>arg === '-C' || /^--cd(?:=|$)/.test(arg) || /^-C./.test(arg));
    return {executable,codeHome,url:lease.url,authToken:lease.authToken,leaseId:lease.leaseId,...(hasCwd ? {} : {cd:process.cwd()})};
  } catch (error) {
    await releaseLease(lease.leaseId);
    throw error;
  }
}

function releaseLease(leaseId:string):Promise<unknown> {
  return sendRequest('codex.relay.close',{leaseId}).catch(()=>undefined);
}

/** One argument, always quoted (cmd leaves `&` and `^` inside quotes alone),
 * as the Microsoft C runtime reads it back. */
export function quoteWindowsArg(value:string):string {
  return `"${value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`;
}

/**
 * wmux.cmd's `codex --wmux-handoff`: reserve the lease and print, for the
 * script's `for /f` alone, how to start Codex from its console. The script
 * puts the bearer in a variable named `codex`: its launch line ends in
 * `--remote-auth-token-env %*`, and `%*` starts with `codex`.
 */
export async function codexHandoff(raw:string|undefined, output:NodeJS.WriteStream = process.stdout):Promise<void> {
  // A console or a file would show or keep the bearer: only the script's pipe may carry it.
  if (output.isTTY || !(output instanceof net.Socket)) throw new Error(`${CODEX_HANDOFF_FLAG} is wmux.cmd's own step. Run wmux codex.`);
  if (typeof raw !== 'string' || /[\r\n]/.test(raw)) throw new Error('wmux.cmd passed no Codex arguments.');
  const tokens = tokenizeCommandLine(raw);
  if (tokens[0]?.toLowerCase() !== 'codex') throw new Error('wmux.cmd passed no Codex arguments.');
  const launch = await prepareLaunch(tokens.slice(1));
  // Each value is one line of `set "NAME=value"`, and the paths sit inside quotes there.
  if ([launch.executable,launch.codeHome,launch.cd ?? ''].some(value=>/[\r\n"]/.test(value))) {
    await releaseLease(launch.leaseId);
    throw new Error('This Codex path cannot be passed through wmux.cmd.');
  }
  const lines = [
    `WMUX_CODEX_EXE=${launch.executable}`,
    `WMUX_CODEX_LAUNCH=--remote ${launch.url}${launch.cd === undefined ? '' : ` --cd ${quoteWindowsArg(launch.cd)}`}`,
    `WMUX_CODEX_HOME=${launch.codeHome}`,
    `codex=${launch.authToken}`,
    // Last: the script launches only once it holds the lease to release.
    `WMUX_CODEX_LEASE=${launch.leaseId}`,
  ];
  try {
    await new Promise<void>((resolve,reject)=>output.write(`${lines.join('\n')}\n`,error=>error ? reject(error) : resolve()));
  } catch (error) {
    await releaseLease(launch.leaseId);
    throw error;
  }
}

/** wmux.cmd's `codex --wmux-release <lease>`, after Codex exits. */
export async function codexRelease(leaseId:string|undefined):Promise<void> {
  if (typeof leaseId !== 'string' || !LEASE_ID.test(leaseId)) throw new Error('Invalid Codex pane lease.');
  const self = await resolveSelfContext({sendRequest,env:process.env,ppid:process.ppid,
    callerPid:process.pid,getParentPid:getParentPidDefault});
  let released = false;
  if (self.workspaceToken) {
    setWorkspaceToken(self.workspaceToken);
    const response = await sendRequest('codex.relay.close',{leaseId}).catch(()=>undefined) as {ok?:unknown} | undefined;
    released = response?.ok === true;
  }
  // Codex has exited either way; the link it leaves behind is bounded on its own.
  if (!released) process.stderr.write('wmux: could not close this pane\'s Codex link; it closes within 30 seconds or with the pane.\n');
}

/** Foreground native TUI. The child gets a per-launch bearer; neither its value
 * nor the relay response is printed or written to disk. */
export async function handleCodex(args:string[]):Promise<void> {
  if (args[0] === CODEX_HANDOFF_FLAG && args.length === 1) return codexHandoff(process.env.WMUX_CODEX_ARGS);
  if (args[0] === CODEX_RELEASE_FLAG && args.length === 2) return codexRelease(args[1]);
  // A GUI-subsystem host (wmux.exe run as Node) is not attached to the
  // console: a TUI it spawned would get a console of its own (#2612).
  if (process.platform === 'win32' && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error('wmux codex needs this terminal\'s console. Run it as `wmux codex` in a wmux terminal pane.');
  }
  const launch = await prepareLaunch(args);
  try {
    const tokenName = `WMUX_CODEX_RELAY_${randomBytes(8).toString('hex').toUpperCase()}`;
    const argv = ['--remote',launch.url,'--remote-auth-token-env',tokenName,...(launch.cd === undefined ? [] : ['--cd',launch.cd]),...args];
    const code = await new Promise<number>((resolve,reject)=>{
      const child = spawn(launch.executable,argv,{stdio:'inherit',env:{...process.env,CODEX_HOME:launch.codeHome,[tokenName]:launch.authToken}});
      child.once('error',reject);
      child.once('exit',(code)=>resolve(code ?? 1));
    });
    process.exitCode = code;
  } finally {
    await releaseLease(launch.leaseId);
  }
}
