// #2469 follow-up: main resyncs pane state only after the daemon ACCEPTED its
// event resubscribe. The daemon refuses a subscribe while the socket is still
// backed up, and the app retries; a change made between the refusal and the
// accepted retry reaches no subscriber as an event, so only a state read taken
// after the accepted retry can carry it.
//
// Real DaemonClient over a real pipe, against a minimal daemon that refuses
// the first resubscribe attempts and changes its sessions while refusing.
import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: () => undefined,
  getLastBroadcastAgentStatus: () => undefined,
  hasOutstandingRunningClaim: () => false,
}));

import { DaemonClient } from '../../DaemonClient';
import { resyncAfterResubscribe, serialResync, type DaemonSessionRow } from '../resubscribeResync';

const TOKEN = 'test-token-resync-handshake';

function pipeName(suffix: string): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-rstest-${suffix}-${id}`;
  return path.join(os.tmpdir(), `wmux-rstest-${suffix}-${id}.sock`);
}

interface Session { id: string; state: 'attached' | 'dead'; cwd: string; exitCode?: number; exitSignal?: number | null }

/** A daemon that keeps sessions, pushes events only to subscribers, and refuses `refusals` subscribes once resubscribing. */
function fakeDaemon(name: string, opts: {
  sessions: Session[];
  /** Subscribe answers after the first (connect-time) one: false = refused. */
  answers: boolean[];
  /** Runs on each refusal: the change that lands in the gap. */
  onRefuse?: (push: (frame: object) => void) => void;
  /** Runs before the listSessions reply is written. */
  beforeList?: (push: (frame: object) => void) => void;
}) {
  const log: string[] = [];
  const subscribers = new Set<net.Socket>();
  const sockets = new Set<net.Socket>();
  let first = true;
  const push = (frame: object) => {
    for (const s of subscribers) s.write(JSON.stringify(frame) + '\n');
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const req = JSON.parse(line) as { id: string; method: string; token: string };
        const reply = (result: unknown) => socket.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
        if (req.token !== TOKEN) continue;
        if (req.method === 'daemon.client.identify') { reply({ ok: true }); continue; }
        if (req.method === 'daemon.events.subscribe') {
          const ok = first ? true : (opts.answers.shift() ?? true);
          first = false;
          log.push(ok ? 'subscribe:ok' : 'subscribe:refused');
          if (ok) subscribers.add(socket);
          else opts.onRefuse?.(push);
          reply({ ok });
          continue;
        }
        if (req.method === 'daemon.listSessions') {
          log.push('listSessions');
          opts.beforeList?.(push);
          reply(opts.sessions.map((s) => ({ ...s })));
          continue;
        }
        socket.write(JSON.stringify({ id: req.id, ok: false, error: `Unknown method: ${req.method}` }) + '\n');
      }
    });
    socket.on('close', () => { sockets.delete(socket); subscribers.delete(socket); });
  });
  return {
    log,
    /** The daemon drops main's subscription under backpressure but keeps the socket. */
    drop: () => subscribers.clear(),
    start: () => new Promise<void>((resolve) => server.listen(name, resolve)),
    stop: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

/** main's side, composed as src/main/index.ts does it. */
function mainSide(client: DaemonClient, tracked: Map<string, string>) {
  const died: string[] = [];
  client.on('session:died', (p: { sessionId: string }) => { died.push(p.sessionId); tracked.delete(p.sessionId); });
  client.on('session:cwd', (p: { sessionId: string; cwd: string }) => { tracked.set(p.sessionId, p.cwd); });
  const resync = serialResync((c: DaemonClient) => resyncAfterResubscribe({
    listSessions: async () => (await c.rpc('daemon.listSessions', {})) as DaemonSessionRow[],
    trackedCwd: (id) => tracked.get(id),
    readState: async () => null,
    emitDied: (id, exitCode, signal) => { c.emit('session:died', { sessionId: id, exitCode, ...(signal !== undefined ? { signal } : {}) }); },
    emitCwd: (id, cwd) => { c.emit('session:cwd', { sessionId: id, cwd }); },
    onLiveEvent: (listener) => {
      const onCwd = (p: { sessionId: string }) => listener('cwd', p.sessionId);
      const onDied = (p: { sessionId: string }) => listener('lifecycle', p.sessionId);
      c.on('session:cwd', onCwd);
      c.on('session:died', onDied);
      return () => { c.off('session:cwd', onCwd); c.off('session:died', onDied); };
    },
    emitTitle: () => undefined,
    hookRouter: null,
    win: null,
  }));
  // DaemonRespawnController: resync only on an accepted resubscribe.
  const resubscribe = async () => {
    const ok = await client.resubscribeEvents();
    if (ok) await resync(client);
    return ok;
  };
  return { died, resubscribe };
}

let daemon: ReturnType<typeof fakeDaemon> | null = null;
let client: DaemonClient | null = null;
afterEach(async () => {
  await client?.disconnect().catch(() => undefined);
  await daemon?.stop();
  client = null;
  daemon = null;
});

describe('resync after an accepted resubscribe (#2469)', () => {
  it('keeps a death and a cwd change made between a refused subscribe and the accepted retry', async () => {
    const name = pipeName('gap');
    const sessions: Session[] = [
      { id: 's1', state: 'attached', cwd: '/a' },
      { id: 's2', state: 'attached', cwd: '/x' },
    ];
    let refusals = 0;
    // Refused twice (the subscribe and its post-identify retry), accepted
    // after the client's 250 ms backoff. The change lands inside that backoff.
    daemon = fakeDaemon(name, {
      sessions,
      answers: [false, false, true],
      onRefuse: (push) => {
        refusals += 1;
        if (refusals !== 2) return;
        setTimeout(() => {
          // Pushed to no one: main is not subscribed.
          sessions[0] = { id: 's1', state: 'dead', cwd: '/a', exitCode: 2, exitSignal: null };
          sessions[1] = { id: 's2', state: 'attached', cwd: '/y' };
          push({ type: 'session.died', sessionId: 's1', data: { exitCode: 2 } });
          push({ type: 'cwd.changed', sessionId: 's2', data: '/y' });
        }, 50);
      },
    });
    await daemon.start();
    client = new DaemonClient(name, TOKEN);
    expect(await client.connect()).toBe(true);
    await vi.waitFor(() => expect(daemon?.log).toEqual(['subscribe:ok']), { timeout: 10_000 });

    const tracked = new Map([['s1', '/a'], ['s2', '/x']]);
    const main = mainSide(client, tracked);
    daemon.drop();
    expect(await main.resubscribe()).toBe(true);

    expect(main.died).toEqual(['s1']);
    expect(tracked.get('s2')).toBe('/y');
    // The read came after the accepted retry, never between refusal and retry.
    expect(daemon.log).toEqual(['subscribe:ok', 'subscribe:refused', 'subscribe:refused', 'subscribe:ok', 'listSessions']);
  });

  it('ends a session once when its death is both pushed live after the accepted subscribe and listed dead', async () => {
    const name = pipeName('dup');
    const sessions: Session[] = [{ id: 's1', state: 'attached', cwd: '/a' }];
    daemon = fakeDaemon(name, {
      sessions,
      answers: [false, false, true],
      beforeList: (push) => {
        sessions[0] = { id: 's1', state: 'dead', cwd: '/a', exitCode: 0, exitSignal: 9 };
        push({ type: 'session.died', sessionId: 's1', data: { exitCode: 0, signal: 9 } });
      },
    });
    await daemon.start();
    client = new DaemonClient(name, TOKEN);
    expect(await client.connect()).toBe(true);
    await vi.waitFor(() => expect(daemon?.log).toEqual(['subscribe:ok']), { timeout: 10_000 });

    const tracked = new Map([['s1', '/a']]);
    const main = mainSide(client, tracked);
    daemon.drop();
    // Two accepted resubscribes in a row (two drops): still one death.
    const [a, b] = await Promise.all([main.resubscribe(), main.resubscribe()]);
    expect(a || b).toBe(true);
    expect(main.died).toEqual(['s1']);
  });

  it('does not resync when every attempt is refused', async () => {
    const name = pipeName('refused');
    daemon = fakeDaemon(name, { sessions: [], answers: Array(20).fill(false) });
    await daemon.start();
    client = new DaemonClient(name, TOKEN);
    expect(await client.connect()).toBe(true);
    await vi.waitFor(() => expect(daemon?.log).toEqual(['subscribe:ok']), { timeout: 10_000 });
    const main = mainSide(client, new Map());
    daemon.drop();
    expect(await main.resubscribe()).toBe(false);
    expect(daemon.log).not.toContain('listSessions');
  }, 15_000);
});
