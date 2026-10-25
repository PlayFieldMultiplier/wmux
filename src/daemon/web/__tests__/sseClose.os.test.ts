// A long-lived SSE stream ends with its response, never its request: a
// request whose (empty) body was read closes while the response streams on,
// and a response that closed before its listener was added never says so.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { onSseClose } from '../sseHeartbeat';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('onSseClose', () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    await new Promise((r) => (server ? server.close(r) : r(null)));
    server = null;
  });

  const listen = async (handler: http.RequestListener): Promise<number> => {
    const s = http.createServer(handler);
    server = s;
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as AddressInfo).port;
  };

  it('a held stream whose request was read stays open until the client leaves', async () => {
    const events: string[] = [];
    const port = await listen((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ok\n\n');
      req.on('close', () => events.push('request closed'));
      onSseClose(res, () => events.push('released'));
    });
    const client = http.get({ port, path: '/api/events' }, (r) => r.resume());
    await tick(300);
    expect(events).toEqual(['request closed']);
    client.destroy();
    await tick(200);
    expect(events).toEqual(['request closed', 'released']);
  });

  it('a client gone before the listener was added is released at once', async () => {
    const released: boolean[] = [];
    const port = await listen(async (_req, res) => {
      await tick(200);
      onSseClose(res, () => released.push(true));
    });
    const client = http.get({ port, path: '/api/events' });
    client.on('error', () => { /* destroyed on purpose */ });
    await tick(50);
    client.destroy();
    await tick(400);
    expect(released).toEqual([true]);
  });
});
