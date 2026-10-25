import { describe, it, expect, afterAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { sendRoomFile } from '../rooms';

/**
 * sendRoomFile against a real socket: a phone that leaves mid-download and
 * one that stops reading. Either way the stream ends before the handle is
 * closed, and the server keeps answering.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-room-file-send-'));
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const SIZE = 8 * 1024 * 1024;
const file = path.join(tmp, 'video.bin');
fs.writeFileSync(file, crypto.randomBytes(SIZE));

let server: http.Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise((r) => server?.close(r));
  server = undefined;
});

/** A server whose every request streams `file`; `sent` holds each sendRoomFile run and the stream it read. */
async function serve(opts: { stallMs?: number } = {}) {
  const sent: Array<{ done: Promise<void>; handle: fs.promises.FileHandle; stream: () => fs.ReadStream | undefined }> = [];
  server = http.createServer((_req, res) => {
    void fs.promises.open(file).then((handle) => {
      let stream: fs.ReadStream | undefined;
      const create = handle.createReadStream.bind(handle);
      handle.createReadStream = (o) => (stream = create(o));
      sent.push({ done: sendRoomFile(res, { status: 200, handle, size: SIZE, name: 'video.mp4', contentType: 'video/mp4' }, {}, opts), handle, stream: () => stream });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { sent, url };
}

describe('sendRoomFile', () => {
  it('a download the phone leaves: the stream closes before the handle, a late read error is heard, and the next download is whole', async () => {
    const { sent, url } = await serve();
    const req = http.get(url);
    const [res] = await once(req, 'response') as [http.IncomingMessage];
    // Its own nosniff, whatever headers the server passes in (none here).
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await once(res, 'data');
    req.destroy();
    await sent[0].done;
    const stream = sent[0].stream();
    expect(stream?.closed).toBe(true);
    await expect(sent[0].handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    // A read that was in flight and fails late finds a listener.
    expect(() => stream?.emit('error', Object.assign(new Error('read'), { code: 'EBADF' }))).not.toThrow();
    const whole = await fetch(url);
    expect((await whole.arrayBuffer()).byteLength).toBe(SIZE);
  });

  it('cuts a download the phone stopped reading once its socket has been quiet for the stall time', async () => {
    const { sent, url } = await serve({ stallMs: 300 });
    const req = http.get(url);
    const [res] = await once(req, 'response') as [http.IncomingMessage];
    res.pause();
    await sent[0].done;
    req.destroy();
    // Cut short: far less than the file was read before the socket went quiet.
    expect(sent[0].stream()?.bytesRead).toBeLessThan(SIZE);
    expect(sent[0].stream()?.closed).toBe(true);
    await expect(sent[0].handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });
});
