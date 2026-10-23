import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import fs from 'node:fs';
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

export interface CodexLaunch {
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
  const codeHome = path.win32.resolve(process.env.CODEX_HOME || path.win32.join(os.homedir(),'.codex'));
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

/** The managed binary through the install's own `current` link, relative to CODEX_HOME. */
const MANAGED_EXE_LINK = 'packages\\app-server-daemon\\current\\bin\\codex.exe';
/** What one line of the handoff may hold: printable ASCII, no quote. */
const HANDOFF_SAFE = /^[\x20\x21\x23-\x7e]*$/;

/**
 * The handoff's lines for wmux.cmd's `for /f`. cmd decodes that pipe in the
 * console's code page (949 on a Korean system), so a UTF-8 path read back
 * through it is mangled. No path crosses it: the script launches Codex in its
 * own CODEX_HOME and current directory, which it handed this CLI through the
 * environment and the working directory. The binary is named relative to
 * CODEX_HOME, inside the install that resolveCodexManagedExecutable checked.
 */
export function codexHandoffLines(launch:CodexLaunch):string[] {
  const relative = path.win32.relative(launch.codeHome,launch.executable);
  const inHome = relative !== '' && !relative.startsWith('..') && !path.win32.isAbsolute(relative) && HANDOFF_SAFE.test(relative);
  return [
    `WMUX_CODEX_EXE=${inHome ? relative : MANAGED_EXE_LINK}`,
    `WMUX_CODEX_LAUNCH=--remote ${launch.url}`,
    // The script passes its own directory as --cd when the user named none.
    ...(launch.cd === undefined ? [] : ['WMUX_CODEX_CD=1']),
    `codex=${launch.authToken}`,
    // Last: the script launches only once it holds the lease to release.
    `WMUX_CODEX_LEASE=${launch.leaseId}`,
  ];
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
  // The script resolves CODEX_HOME before this step: Codex gets the script's value, not one read back from here.
  if (!process.env.CODEX_HOME) throw new Error('wmux.cmd passed no CODEX_HOME. Set CODEX_HOME and run wmux codex again.');
  const launch = await prepareLaunch(tokens.slice(1));
  const lines = codexHandoffLines(launch);
  // The script quotes CODEX_HOME and its directory on the launch line.
  if ([launch.codeHome,launch.cd ?? ''].some(value=>/[\r\n"]/.test(value)) || !lines.every(line=>HANDOFF_SAFE.test(line))) {
    await releaseLease(launch.leaseId);
    throw new Error('This Codex path cannot be passed through wmux.cmd.');
  }
  try {
    await new Promise<void>((resolve,reject)=>output.write(`${lines.join('\n')}\n`,error=>error ? reject(error) : resolve()));
  } catch (error) {
    await releaseLease(launch.leaseId);
    throw error;
  }
}

/**
 * Report a failed `codex --wmux-handoff` to wmux.cmd's console. Returns false
 * when the caller should print the message as usual instead.
 *
 * The handoff's stderr reaches no console: wmux.exe is a GUI-subsystem
 * program, and with its stdout on the script's `for /f` pipe Electron does not
 * attach to the console, so the console handle it inherited as stderr writes
 * nowhere. The message goes to a file in %TEMP%, and only the file's ASCII
 * token crosses the pipe, as WMUX_CODEX_ERROR; the script `type`s the file.
 * UTF-16 with a BOM: `type` writes that to the console intact in any code page,
 * where UTF-8 bytes would be read in the console's (949 mangles a Korean path).
 */
export async function reportHandoffError(message:string, output:NodeJS.WriteStream = process.stdout, env:NodeJS.ProcessEnv = process.env):Promise<boolean> {
  if (output.isTTY || !(output instanceof net.Socket) || !env.TEMP) return false;
  const token = randomUUID();
  const file = path.win32.join(env.TEMP,`wmux-codex-${token}.txt`);
  try {
    fs.writeFileSync(file,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(`${message}\r\n`,'utf16le')]),{flag:'wx'});
  } catch {
    return false;
  }
  try {
    await new Promise<void>((resolve,reject)=>output.write(`WMUX_CODEX_ERROR=${token}\n`,error=>error ? reject(error) : resolve()));
    return true;
  } catch {
    fs.rmSync(file,{force:true});
    return false;
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
