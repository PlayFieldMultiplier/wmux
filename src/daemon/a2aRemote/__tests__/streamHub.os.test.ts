// The joined side of a pair: a joiner that pings (`stream-ping.1`) and then
// goes silent without closing its socket loses its stream within the silence
// window; one that keeps pinging keeps it; an older joiner is left alone.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { A2A_FEATURE_STREAM_PING, A2A_FEATURES_HEADER, A2A_ROUTES } from '../../../shared/a2aRemote';
import type { A2aRouteTable } from '../routes';
import { A2aStreamHub } from '../streamHub';
import { deliberateSleep } from '../../../test-utils/waitFor';

const HOST = '11111111-1111-4111-8111-111111111111';
const SILENCE_MS = 300;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function rig(): Promise<{ hub: A2aStreamHub; status: boolean[]; port: number }> {
  const status: boolean[] = [];
  const hub = new A2aStreamHub({
    outbox: { epoch: 'e', pending: () => [], ack: () => 0 },
    accept: async () => ({ ok: true, duplicate: false }),
    onStatus: (_host, up) => status.push(up),
    heartbeatMs: 50,
    silenceMs: SILENCE_MS,
    log: () => undefined,
  });
  const routes = new Map<string, Parameters<A2aRouteTable['add']>[2]>();
  hub.register({ add: (method: string, path: string, handler: Parameters<A2aRouteTable['add']>[2]) => routes.set(`${method} ${path}`, handler) } as unknown as A2aRouteTable);
  const server = http.createServer((req, res) => {
    const handler = routes.get(`${req.method} ${req.url}`);
    if (!handler) return void res.writeHead(404).end();
    void handler({ req, res, url: new URL(req.url ?? '/', 'http://x'), params: {}, peer: { hostId: HOST } } as never);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => { hub.closeAll(); server.closeAllConnections(); server.close(); });
  return { hub, status, port: (server.address() as AddressInfo).port };
}

/** Open the stream and then never read or write again: a peer that vanished without a FIN. */
function openStream(port: number, features?: string): http.ClientRequest {
  const req = http.get({ port, host: '127.0.0.1', path: A2A_ROUTES.stream, headers: features ? { [A2A_FEATURES_HEADER]: features } : {} });
  req.on('response', (res) => res.on('error', () => undefined));
  req.on('error', () => undefined);
  cleanups.push(() => req.destroy());
  return req;
}

function ping(port: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request({ port, host: '127.0.0.1', path: A2A_ROUTES.ack, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', () => resolve());
    req.end(JSON.stringify({ cursor: { epoch: 'e', seq: 0 } }));
  });
}

describe('A2aStreamHub silence deadline', () => {
  it('a pinging joiner that goes silent is reported down within the window', async () => {
    const { hub, status, port } = await rig();
    openStream(port, A2A_FEATURE_STREAM_PING);
    await deliberateSleep(100, 'real socket: the stream opens');
    expect(hub.isConnected(HOST)).toBe(true);
    await deliberateSleep(SILENCE_MS + 200, 'real timer: past the silence window with nothing from the joiner');
    expect(hub.isConnected(HOST)).toBe(false);
    expect(status).toEqual([true, false]);
  });

  it('a joiner that keeps pinging keeps its stream', async () => {
    const { hub, port } = await rig();
    openStream(port, A2A_FEATURE_STREAM_PING);
    for (let i = 0; i < 5; i++) {
      await deliberateSleep(SILENCE_MS / 2, 'real timer: half the silence window between pings');
      await ping(port);
    }
    expect(hub.isConnected(HOST)).toBe(true);
  });

  it('an older joiner (no stream-ping.1) is never cut for silence', async () => {
    const { hub, port } = await rig();
    openStream(port);
    await deliberateSleep(SILENCE_MS * 2, 'real timer: twice the silence window');
    expect(hub.isConnected(HOST)).toBe(true);
  });
});
