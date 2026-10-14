// SSH tunnels to hosts added with "Add PC over SSH" (E6/E7).
//
// A stored SSH host's origin is `wmux-ssh://<hostId>`, never an http URL. The
// one way a request reaches such a host is `createSshAwareFetch`: it resolves
// the id to that host's tunnel, waits for the tunnel to be READY, and only
// then sends the (credentialed) request through it. Plain `fetch` does not
// know the scheme and throws, so any path that forgot to route fails closed
// instead of handing the bearer to whatever owns a loopback port.
//
//   request ──▶ supervisor.ready()? ──no──▶ start ssh (unless backing off)
//                     │ yes                       │ socket appears + host key
//                     ▼                           ▼ matches what was confirmed
//          http over the forward  ◀──────── READY
//                     │
//   ssh exits ──▶ abort EVERY in-flight request, unlink the socket,
//                 back off (bounded), next request starts it again
//
// macOS/Linux forward to a unix socket in a 0700 directory: no other local
// user can connect to it, and its appearance is the readiness signal. Windows
// has no such socket in OpenSSH, so it forwards a pinned loopback TCP port —
// any local process could race for that port (documented risk).

import { app } from 'electron';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { Readable } from 'stream';
import type { SshHostBinding } from '../../shared/sshPcContract';
import { SSH_ORIGIN_SCHEME } from '../../shared/sshPcContract';
import type { RemoteHost, SshTunnelState } from '../../shared/remoteHosts';
import {
  SshFailure,
  type SpawnFn,
  type SshFailureKind,
  classifySshFailure,
  parseServerHostKey,
  parseSshG,
  resolveArgs,
  runSsh,
  sshBinary,
  sshErrorExcerpt,
  tunnelArgs,
} from './sshCommand';

const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 100;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** stderr kept from a running tunnel (`-v` keeps talking per channel). */
const STDERR_KEEP_BYTES = 16 * 1024;

/** Failures a retry cannot fix without the user: no automatic restart. */
const TERMINAL_KINDS: ReadonlySet<SshFailureKind> = new Set([
  'needs-confirmation',
  'host-key-changed',
  'ssh-missing',
  // Retrying a refused login only adds failed attempts to the host's log (and
  // can get this computer banned by fail2ban). Check SSH connection retries.
  'auth',
  'host-key-unknown',
  'web-stopped',
]);

/** The directory the unix sockets live in: owner-only, never a symlink. */
export function ensureSocketDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new SshFailure('failed', 'tunnel directory is not a directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new SshFailure('failed', 'tunnel directory is owned by another user');
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** Short, stable socket name: macOS caps a unix socket path near 104 bytes. */
export function socketPathFor(dir: string, hostId: string): string {
  const short = crypto.createHash('sha256').update(hostId).digest('hex').slice(0, 10);
  return path.join(dir, `${short}.sock`);
}

/** The local end for a host on this platform. */
export function localEndpointFor(
  dir: string,
  hostId: string,
  pinnedPort: number | undefined,
  platform: NodeJS.Platform = process.platform,
): SshHostBinding['localEndpoint'] {
  if (platform === 'win32') {
    if (!pinnedPort) throw new SshFailure('failed', 'no local port pinned for this host');
    return { port: pinnedPort };
  }
  return { socketPath: socketPathFor(dir, hostId) };
}

/** A free loopback port, picked once at add time and stored (Windows only). */
export function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

function abortError(reason: string): Error {
  const err = new Error(reason);
  err.name = 'AbortError';
  return err;
}

/**
 * `fetch` over one tunnel endpoint, built on `http.request` so a unix socket
 * needs no extra dependency. Covers what the remote clients use: method,
 * headers, a string/bytes body, `redirect: 'error'`, and an abort signal that
 * tears down the request AND a body still streaming.
 */
export function endpointFetch(
  endpoint: SshHostBinding['localEndpoint'],
  remotePort: number,
): (url: URL, init: RequestInit | undefined, signal: AbortSignal) => Promise<Response> {
  return (url, init, signal) => new Promise<Response>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError('ssh tunnel closed'));
      return;
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    // The remote server's DNS-rebinding guard accepts loopback names only.
    headers.host = `127.0.0.1:${remotePort}`;
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      reject(new TypeError('unsupported request body over ssh tunnel'));
      return;
    }
    const target = 'socketPath' in endpoint
      ? { socketPath: endpoint.socketPath }
      : { host: '127.0.0.1', port: endpoint.port };
    let response: http.IncomingMessage | null = null;
    const onAbort = (): void => {
      const err = abortError('ssh tunnel closed');
      req.destroy(err);
      response?.destroy(err);
    };
    const req = http.request({
      ...target,
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
    }, (res) => {
      response = res;
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && init?.redirect === 'error') {
        res.destroy();
        signal.removeEventListener('abort', onAbort);
        reject(new TypeError('redirect refused over ssh tunnel'));
        return;
      }
      res.once('close', () => signal.removeEventListener('abort', onAbort));
      const resHeaders = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) resHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      const noBody = status === 204 || status === 304 || init?.method === 'HEAD';
      if (noBody) res.resume();
      resolve(new Response(
        noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
        { status, headers: resHeaders },
      ));
    });
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.aborted ? abortError('ssh tunnel closed') : Object.assign(new TypeError(`fetch failed: ${err.message}`), { sshTransport: true }));
    });
    if (typeof body === 'string' || body instanceof Uint8Array) req.end(body);
    else req.end();
  });
}

export interface SshTunnelDeps {
  /** Where unix sockets live (macOS/Linux). */
  socketDir: string;
  spawnImpl?: SpawnFn;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Test seam: does the forward's local end exist yet? */
  endpointExists?: (endpoint: SshHostBinding['localEndpoint']) => Promise<boolean>;
  /** Test seam: what `ssh -G` resolves the alias to (hostname). */
  resolveHostname?: (alias: string) => Promise<string>;
  /** Restart the host's daemon and web if they went away (headless idle exit). */
  revive?: (hostId: string, binding: SshHostBinding) => Promise<void>;
}

async function defaultEndpointExists(endpoint: SshHostBinding['localEndpoint']): Promise<boolean> {
  if ('socketPath' in endpoint) {
    try {
      return fs.statSync(endpoint.socketPath).isSocket();
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: endpoint.port });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

async function defaultResolveHostname(alias: string, spawnImpl?: SpawnFn): Promise<string> {
  const res = await runSsh(resolveArgs(alias), { timeoutMs: 10_000, spawnImpl });
  if (res.code !== 0) throw new SshFailure('failed', sshErrorExcerpt(res.stderr) || 'ssh -G failed');
  return parseSshG(res.stdout).get('hostname') ?? '';
}

/** One host's tunnel. */
export class SshTunnel {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private controller = new AbortController();
  private ready = false;
  private failures = 0;
  private retryAt = 0;
  private lastFailure: { kind: SshFailureKind; message: string } | null = null;
  private stopped = false;
  /** Bumped by stop() and updateBinding(): a start from an older epoch is void. */
  private epoch = 0;

  constructor(
    readonly hostId: string,
    private binding: SshHostBinding,
    private readonly deps: SshTunnelDeps,
  ) {}

  /** Swap in a re-confirmed binding (alias, key, port). Drops the live tunnel. */
  updateBinding(binding: SshHostBinding): void {
    this.binding = binding;
    this.epoch += 1;
    this.lastFailure = null;
    this.failures = 0;
    this.retryAt = 0;
    this.teardown('binding changed');
  }

  state(): SshTunnelState {
    if (this.ready) return { state: 'ready' };
    if (this.starting) return { state: 'connecting' };
    if (this.lastFailure) {
      return {
        state: 'failed',
        kind: this.lastFailure.kind,
        message: this.lastFailure.message,
        ...(TERMINAL_KINDS.has(this.lastFailure.kind) ? {} : { retryAt: this.retryAt }),
      };
    }
    return { state: 'idle' };
  }

  /** Resolves once the forward is usable, with the signal every request must carry. */
  async ensureReady(): Promise<AbortSignal> {
    if (this.stopped) throw new SshFailure('failed', 'ssh tunnel stopped');
    if (this.ready) return this.controller.signal;
    if (!this.starting) {
      const now = (this.deps.now ?? Date.now)();
      if (this.lastFailure && (TERMINAL_KINDS.has(this.lastFailure.kind) || now < this.retryAt)) {
        throw new SshFailure(this.lastFailure.kind, this.lastFailure.message);
      }
      this.starting = this.start().finally(() => { this.starting = null; });
    }
    await this.starting;
    if (!this.ready) throw this.lastError();
    return this.controller.signal;
  }

  /**
   * The tunnel is up but the server behind it stopped answering (its daemon
   * exited): drop the tunnel so the next request reopens it, which revives
   * the server first.
   */
  transportFailed(signal: AbortSignal): void {
    if (!this.ready || signal !== this.controller.signal) return;
    this.fail('unreachable', 'the wmux server on that computer stopped answering');
    this.teardown('wmux server stopped answering');
  }

  /** A request got an HTTP answer through this tunnel: the backoff starts over. */
  answered(signal: AbortSignal): void {
    if (this.ready && signal === this.controller.signal) this.failures = 0;
  }

  /** The local end requests go to (derived, never read back from disk). */
  get endpoint(): SshHostBinding['localEndpoint'] {
    return this.binding.localEndpoint;
  }

  /** Stop for good (host removed, app quitting). */
  stop(): void {
    this.stopped = true;
    this.epoch += 1;
    this.teardown('ssh tunnel stopped');
  }

  private async start(): Promise<void> {
    const epoch = this.epoch;
    const binding = this.binding;
    const spawnImpl = this.deps.spawnImpl ?? spawn;
    // stop() or a re-confirmed binding while this start awaited: it must not
    // spawn, and must never turn READY on the old binding.
    const superseded = (): boolean => this.stopped || epoch !== this.epoch;
    const gone = (): SshFailure => new SshFailure('failed', 'ssh tunnel stopped');
    // The alias must still point where the user confirmed it did.
    let hostname: string;
    try {
      hostname = await (this.deps.resolveHostname ?? ((a) => defaultResolveHostname(a, this.deps.spawnImpl)))(binding.alias);
    } catch (err) {
      if (superseded()) throw gone();
      this.fail(err instanceof SshFailure ? err.kind : 'failed', err instanceof Error ? err.message : String(err));
      throw this.lastError();
    }
    if (superseded()) throw gone();
    if (hostname !== binding.resolvedHost) {
      this.fail('needs-confirmation', `${binding.alias} now resolves to ${hostname}, not ${binding.resolvedHost}`);
      throw this.lastError();
    }

    if (this.deps.revive) {
      try {
        await this.deps.revive(this.hostId, binding);
      } catch (err) {
        if (superseded()) throw gone();
        const kind: SshFailureKind = err instanceof SshFailure
          ? err.kind
          : (err as { refusal?: unknown }).refusal === 'web-stopped' ? 'web-stopped' : 'unreachable';
        this.fail(kind, err instanceof Error ? err.message : String(err));
        throw this.lastError();
      }
      if (superseded()) throw gone();
    }

    const endpoint = binding.localEndpoint;
    const exists = this.deps.endpointExists ?? defaultEndpointExists;
    if ('socketPath' in endpoint) {
      ensureSocketDir(path.dirname(endpoint.socketPath));
      // A stale socket from a dead tunnel would read as "ready".
      try { fs.unlinkSync(endpoint.socketPath); } catch { /* none */ }
    } else if (await exists(endpoint)) {
      // Something else already answers on the pinned port: never hand it a bearer.
      if (superseded()) throw gone();
      this.fail('forward-conflict', `local port ${endpoint.port} is already in use`);
      throw this.lastError();
    }
    if (superseded()) throw gone();

    let child: ChildProcess;
    try {
      child = spawnImpl(sshBinary(this.deps.platform), tunnelArgs(binding.alias, endpoint, binding.remotePort), {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.fail('ssh-missing', err instanceof Error ? err.message : String(err));
      throw this.lastError();
    }
    this.child = child;
    this.controller = new AbortController();
    this.lastFailure = null;
    let stderr = '';
    let exited = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    // ssh's own word that THIS forward is bound (debug1, printed after auth).
    const listeningLine = 'socketPath' in endpoint
      ? `Local forwarding listening on path ${endpoint.socketPath}`
      : `Local forwarding listening on 127.0.0.1 port ${endpoint.port}.`;
    let listening = false;
    let hostKey: string | null = null;
    child.stderr?.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-STDERR_KEEP_BYTES);
      if (!listening && stderr.includes(listeningLine)) {
        listening = true;
        // The LAST key shown before the forward came up is the destination's;
        // a ProxyJump hop prints its own key first.
        hostKey = parseServerHostKey(stderr);
      }
    });
    const onGone = (): void => {
      if (exited) return;
      exited = true;
      // Our own teardown already cleared `this.child` and recorded why.
      if (this.child !== child) return;
      this.child = null;
      if (spawnError) this.fail(spawnError.code === 'ENOENT' ? 'ssh-missing' : 'failed', spawnError.message);
      else this.fail(classifySshFailure(stderr), sshErrorExcerpt(stderr) || 'ssh tunnel closed');
      this.teardown('ssh tunnel closed');
    };
    child.once('error', (err: NodeJS.ErrnoException) => {
      spawnError = err;
      onGone();
    });
    child.once('exit', onGone);

    const deadline = (this.deps.now ?? Date.now)() + READY_TIMEOUT_MS;
    for (;;) {
      if (superseded()) {
        if (this.child === child) this.teardown('ssh tunnel stopped');
        else if (child.exitCode === null) child.kill();
        throw gone();
      }
      if (exited || this.child !== child) throw this.lastError();
      // Readiness needs ALL of: ssh says this forward is listening, the key it
      // was shown is the one the user confirmed, and the endpoint answers.
      if (listening) {
        if (hostKey !== binding.hostKeyFingerprint) {
          this.fail('needs-confirmation', `the host key of ${binding.alias} changed to ${hostKey ?? 'an unknown key'}`);
          this.teardown('host key changed');
          throw this.lastError();
        }
        if (await exists(endpoint)) break;
      }
      if ((this.deps.now ?? Date.now)() > deadline) {
        this.fail('unreachable', 'ssh tunnel did not come up');
        this.teardown('ssh tunnel did not come up');
        throw this.lastError();
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    if (superseded() || this.child !== child) {
      if (this.child === child) this.teardown('ssh tunnel stopped');
      throw gone();
    }
    // Why a READY tunnel later dies is in what ssh says from here on, not in
    // its connection chatter.
    stderr = '';
    this.ready = true;
    this.lastFailure = null;
  }

  private lastError(): SshFailure {
    return new SshFailure(this.lastFailure?.kind ?? 'failed', this.lastFailure?.message ?? 'ssh tunnel closed');
  }

  private fail(kind: SshFailureKind, message: string): void {
    this.failures += 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.failures - 1, 16));
    this.retryAt = (this.deps.now ?? Date.now)() + delay;
    this.lastFailure = { kind, message };
  }

  /** Every request that went through this tunnel ends here, mechanically. */
  private teardown(reason: string): void {
    this.ready = false;
    this.controller.abort(abortError(reason));
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
    const endpoint = this.binding.localEndpoint;
    if ('socketPath' in endpoint) {
      try { fs.unlinkSync(endpoint.socketPath); } catch { /* already gone */ }
    }
  }
}

/** Every SSH host's tunnel, keyed by host id. */
export class SshTunnelRegistry {
  private readonly tunnels = new Map<string, SshTunnel>();
  private readonly bindings = new Map<string, string>();
  /** Bindings of hosts being added: their tunnel runs before the record exists. */
  private readonly pending = new Map<string, SshHostBinding>();

  constructor(private readonly deps: SshTunnelDeps) {}

  get socketDir(): string {
    return this.deps.socketDir;
  }

  /** The tunnel for a binding; rebuilt when the binding changed under it. */
  /** A stored socket path is never trusted: it is re-derived from the id
   *  before anything is chmod'ed, unlinked or connected to. */
  private derive(hostId: string, stored: SshHostBinding): SshHostBinding {
    return 'socketPath' in stored.localEndpoint
      ? { ...stored, localEndpoint: { socketPath: socketPathFor(this.deps.socketDir, hostId) } }
      : stored;
  }

  tunnelFor(hostId: string, stored: SshHostBinding): SshTunnel {
    const binding = this.derive(hostId, stored);
    const key = JSON.stringify(binding);
    let tunnel = this.tunnels.get(hostId);
    if (!tunnel) {
      tunnel = new SshTunnel(hostId, binding, this.deps);
      this.tunnels.set(hostId, tunnel);
    } else if (this.bindings.get(hostId) !== key) {
      tunnel.updateBinding(binding);
    }
    this.bindings.set(hostId, key);
    return tunnel;
  }

  /** A re-confirmed host: drop any refusal and start clean on the next request. */
  reset(hostId: string, binding: SshHostBinding): void {
    this.tunnelFor(hostId, binding).updateBinding(this.derive(hostId, binding));
  }

  setPending(hostId: string, binding: SshHostBinding): void {
    this.pending.set(hostId, binding);
  }

  clearPending(hostId: string): void {
    this.pending.delete(hostId);
  }

  pendingBinding(hostId: string): SshHostBinding | undefined {
    return this.pending.get(hostId);
  }

  state(hostId: string): SshTunnelState {
    return this.tunnels.get(hostId)?.state() ?? { state: 'idle' };
  }

  stop(hostId: string): void {
    this.tunnels.get(hostId)?.stop();
    this.tunnels.delete(hostId);
    this.bindings.delete(hostId);
    this.pending.delete(hostId);
  }

  stopAll(): void {
    for (const id of [...this.tunnels.keys()]) this.stop(id);
  }
}

/** The host id in a `wmux-ssh://<id>/…` URL, or null for any other URL. */
export function sshHostIdOf(url: string): string | null {
  if (!url.startsWith(`${SSH_ORIGIN_SCHEME}//`)) return null;
  try {
    const u = new URL(url);
    return u.protocol === SSH_ORIGIN_SCHEME && u.hostname ? u.hostname : null;
  } catch {
    return null;
  }
}

/**
 * `fetch` that also speaks `wmux-ssh://<hostId>`. Any other URL goes to
 * `base` unchanged. An SSH URL is sent only through a READY tunnel, and the
 * request is aborted the moment that tunnel goes away.
 */
export function createSshAwareFetch(
  base: typeof fetch,
  registry: SshTunnelRegistry,
  lookup: (hostId: string) => Pick<RemoteHost, 'ssh'> | null,
): typeof fetch {
  const routed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const hostId = sshHostIdOf(raw);
    if (hostId === null) return base(input, init);
    const binding = lookup(hostId)?.ssh ?? registry.pendingBinding(hostId);
    if (!binding) throw new TypeError('fetch failed: unknown ssh host');
    const tunnel = registry.tunnelFor(hostId, binding);
    const tunnelSignal = await tunnel.ensureReady();
    const signal = init?.signal ? AbortSignal.any([init.signal, tunnelSignal]) : tunnelSignal;
    try {
      const res = await endpointFetch(tunnel.endpoint, binding.remotePort)(new URL(raw), init, signal);
      tunnel.answered(tunnelSignal);
      return res;
    } catch (err) {
      // Not ours to judge when the caller or the tunnel aborted; a refused or
      // reset connection through a live tunnel means the server is gone.
      if (!signal.aborted && (err as { sshTransport?: boolean }).sshTransport) tunnel.transportFailed(tunnelSignal);
      throw err;
    }
  };
  return routed as typeof fetch;
}

let shared: SshTunnelRegistry | null = null;

/** The app's one registry. Tunnels are torn down when the app quits. */
export function getSshTunnelRegistry(socketDir: string, revive?: SshTunnelDeps['revive']): SshTunnelRegistry {
  if (shared) return shared;
  const registry = new SshTunnelRegistry({ socketDir, revive });
  shared = registry;
  app?.once?.('will-quit', () => registry.stopAll());
  return registry;
}
