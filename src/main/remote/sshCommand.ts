// System OpenSSH, as the "Add PC over SSH" flow drives it.
//
// Everything here goes through the user's own `ssh` binary and ssh_config:
// known_hosts stays owned by OpenSSH, keys and agents stay where the user put
// them, and v1 never types a password or answers a host-key prompt. Two
// argument sets, deliberately kept apart (E7):
//
//   - bootstrap commands run one remote command and exit. They also clear
//     every config-file forward, so a `LocalForward` in the user's config can
//     neither collide with the tunnel nor open a port nobody asked for.
//   - the tunnel holds one forward open. It cannot clear config forwards
//     (ClearAllForwardings also clears the command line's own `-L`), so a
//     config forward that fails to bind is classified as its own error.
//
// Both force BatchMode (no prompt can block a hidden process), refuse a
// config-file RemoteCommand (it would replace ours, or make `-N` a hard
// error), and put `--` before the destination.

import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';
import * as fs from 'fs';

/** How a failed ssh invocation is reported to the UI. */
export type SshFailureKind =
  /** No usable key or agent identity: the remote refused us. */
  | 'auth'
  /** known_hosts has no entry for this host (BatchMode never asks). */
  | 'host-key-unknown'
  /** known_hosts has a DIFFERENT key for this host. */
  | 'host-key-changed'
  /** The host's key or `ssh -G` hostname differs from the one confirmed at add time. */
  | 'needs-confirmation'
  /** A forward from the user's ssh_config could not bind. */
  | 'forward-conflict'
  /** DNS, refused, timed out, no route. */
  | 'unreachable'
  /** No ssh binary on this computer. */
  | 'ssh-missing'
  /** The person cancelled. */
  | 'cancelled'
  /** wmux web was turned off on the host; only someone there turns it back on. */
  | 'web-stopped'
  | 'failed';

export class SshFailure extends Error {
  readonly kind: SshFailureKind;
  constructor(kind: SshFailureKind, message: string) {
    super(message);
    this.name = 'SshFailure';
    this.kind = kind;
  }
}

/**
 * An ssh destination as the user gave it: an ssh_config alias or `user@host`,
 * optionally with a port alias resolved by ssh_config. Never an option (a
 * leading '-' would be read as one), never whitespace or control characters.
 */
const ALIAS_RE = /^[A-Za-z0-9_.@%+:[\]-]{1,255}$/;

export function isValidSshAlias(alias: unknown): alias is string {
  return typeof alias === 'string' && ALIAS_RE.test(alias) && !alias.startsWith('-');
}

/** The ssh binary. A Finder-launched app has a minimal PATH, so the system
 *  copy is named outright where it is known to live. */
export function sshBinary(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' && fs.existsSync('/usr/bin/ssh')) return '/usr/bin/ssh';
  return 'ssh';
}

const COMMON_OPTS = [
  '-o', 'BatchMode=yes',
  // A config `StrictHostKeyChecking accept-new|no` would turn adding a PC into
  // trust-on-first-use; the command line wins over every config file.
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'FingerprintHash=sha256',
  '-o', 'RemoteCommand=none',
  '-o', 'RequestTTY=no',
  '-o', 'ForwardAgent=no',
  '-o', 'ForwardX11=no',
  '-o', 'ControlMaster=no',
  '-o', 'ControlPath=none',
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
];

/**
 * One remote command. `-v` is on so the stderr carries the host key the
 * server actually presented ("Server host key: …"), which is what add time
 * records and every later connection is checked against.
 */
export function bootstrapArgs(alias: string, remoteCommand: string[]): string[] {
  if (!isValidSshAlias(alias)) throw new SshFailure('failed', 'invalid ssh destination');
  return ['-v', ...COMMON_OPTS, '-o', 'ClearAllForwardings=yes', '--', alias, ...remoteCommand];
}

/** The forward itself: a local unix socket, or a pinned loopback TCP port on Windows. */
export function tunnelArgs(
  alias: string,
  local: { socketPath: string } | { port: number },
  remotePort: number,
): string[] {
  if (!isValidSshAlias(alias)) throw new SshFailure('failed', 'invalid ssh destination');
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort >= 65536) {
    throw new SshFailure('failed', 'invalid remote port');
  }
  const listen = 'socketPath' in local ? local.socketPath : `127.0.0.1:${local.port}`;
  return [
    '-v',
    '-N',
    ...COMMON_OPTS,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StreamLocalBindUnlink=yes',
    '-o', 'StreamLocalBindMask=0177',
    '-L', `${listen}:127.0.0.1:${remotePort}`,
    '--', alias,
  ];
}

/** `ssh -G` never connects: it prints the effective config for a destination. */
export function resolveArgs(alias: string): string[] {
  if (!isValidSshAlias(alias)) throw new SshFailure('failed', 'invalid ssh destination');
  return ['-G', '--', alias];
}

/** `ssh -G` output as a lowercase-keyed map (first value wins, like ssh). */
export function parseSshG(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const key = line.slice(0, sp).toLowerCase();
    if (!out.has(key)) out.set(key, line.slice(sp + 1).trim());
  }
  return out;
}

/** "debug1: Server host key: ssh-ed25519 SHA256:abc…" → "SHA256:abc…" (the destination's). */
export function parseServerHostKey(stderr: string): string | null {
  // The LAST one: with ProxyJump each hop prints its key before the destination's.
  const all = [...stderr.matchAll(/Server host key: \S+ (SHA256:[A-Za-z0-9+/=]+)/g)];
  return all.length > 0 ? all[all.length - 1][1] : null;
}

/** The lines a person would read: `-v` debug noise removed. */
function meaningfulLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(debug\d?:|OpenSSH_|Pseudo-terminal|Authenticated to |setsockopt |Transferred: |Bytes per second|Warning: Permanently added)/.test(l));
}

/** Map an ssh exit to a failure kind. ssh exits 255 for its own errors. */
export function classifySshFailure(stderr: string): SshFailureKind {
  const text = meaningfulLines(stderr).join('\n');
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(text)) return 'host-key-changed';
  if (/Host key verification failed|No .*host key is known/i.test(text)) return 'host-key-unknown';
  if (/Permission denied|Too many authentication failures|No more authentication methods/i.test(text)) return 'auth';
  if (/Address already in use|cannot listen to|Could not request local forwarding|bind.*: /i.test(text)) return 'forward-conflict';
  if (/Could not resolve hostname|Connection refused|timed out|No route to host|Network is unreachable|Connection closed by|Connection reset/i.test(text)) return 'unreachable';
  return 'failed';
}

/** A short, human-safe excerpt of what ssh said (bounded, no debug noise). */
export function sshErrorExcerpt(stderr: string): string {
  return meaningfulLines(stderr).slice(-3).join(' ').slice(0, 300);
}

export interface SshRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface RunSshOptions {
  stdin?: string | Buffer | NodeJS.ReadableStream;
  timeoutMs?: number;
  /** Bytes kept per stream; more is dropped (a remote cannot balloon main's heap). */
  maxBytes?: number;
  spawnImpl?: SpawnFn;
  signal?: AbortSignal;
}

/** Run ssh to completion. Never throws for a non-zero exit; throws `ssh-missing` when there is no binary. */
export function runSsh(args: string[], opts: RunSshOptions = {}): Promise<SshRunResult> {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(sshBinary(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      const src = opts.stdin;
      if (src && typeof src !== 'string' && !Buffer.isBuffer(src)) (src as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      reject(new SshFailure('ssh-missing', err instanceof Error ? err.message : String(err)));
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout?.on('data', (b: Buffer) => {
      if (outBytes < maxBytes) out.push(b);
      outBytes += b.length;
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (errBytes < maxBytes) errOut.push(b);
      errBytes += b.length;
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      child.kill();
      finish(() => reject(new SshFailure('cancelled', 'cancelled')));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new SshFailure('unreachable', 'ssh timed out')));
    }, opts.timeoutMs ?? 60_000);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => reject(new SshFailure(err.code === 'ENOENT' ? 'ssh-missing' : 'failed', err.message)));
    });
    child.on('close', (code) => {
      // An upload the remote stopped reading must not hold its file open.
      const src = opts.stdin;
      if (src && typeof src !== 'string' && !Buffer.isBuffer(src)) (src as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      finish(() => resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
      }));
    });
    const stdin = opts.stdin;
    if (stdin === undefined) child.stdin?.end();
    else if (typeof stdin === 'string' || Buffer.isBuffer(stdin)) child.stdin?.end(stdin);
    else if (child.stdin) stdin.pipe(child.stdin);
    // A remote that closed early must not crash main with EPIPE.
    child.stdin?.on('error', () => undefined);
  });
}

/** Throw the classified failure for a non-zero ssh exit. */
export function assertSshOk(result: SshRunResult): SshRunResult {
  if (result.code === 0) return result;
  const kind = result.code === 255 ? classifySshFailure(result.stderr) : 'failed';
  throw new SshFailure(kind, sshErrorExcerpt(result.stderr) || `ssh exited with ${result.code}`);
}
