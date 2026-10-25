import { describe, it, expect, afterEach, beforeEach, afterAll, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';

vi.mock('electron', () => ({ nativeImage: {} }));

import { WebTerminalServer, type WebDeviceResolver } from '../../../daemon/web/WebTerminalServer';
import type { DaemonSessionManager } from '../../../daemon/DaemonSessionManager';
import { DesktopPhoneBridge } from '../../../daemon/phone/DesktopPhoneBridge';
import { RoomWriter } from '../../factory/roomWriter';
import { handlePhoneRoomCommand, type PhoneFactoryPorts } from '../PhoneFactory';
import type { RoomFile } from '../../../shared/roomFiles';

/**
 * Files on bot cards, read from the phone: the real server's
 * `GET /api/rooms/:ws/files/:id`, the real desktop bridge, and main's real
 * room command answering from a real RoomWriter; the stored copies sit in a
 * room-files folder laid out as RoomFileStore writes it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-files-'));
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => { process.env.HOME = tmp; process.env.USERPROFILE = tmp; });
afterAll(() => {
  process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const BOT = { kind: 'bot' as const, workspaceId: 'ws-1', botId: 'bot-1111bbbb' };

describe('GET /api/rooms/:workspaceId/files/:fileId', () => {
  let server: WebTerminalServer | undefined;
  let writer: RoomWriter;
  let dir: string;
  let filesDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmp, 'case-'));
    filesDir = path.join(dir, 'room-files');
    let clock = Date.now();
    writer = new RoomWriter({ dir: path.join(dir, 'rooms'), log: () => undefined, now: () => ++clock });
  });
  afterEach(async () => {
    if (server?.isRunning) await server.stop();
    server = undefined;
  });

  /** A stored copy (as RoomFileStore keeps it) and its description. */
  function store(workspaceId: string, name: string, mediaType: string, bytes: Buffer): RoomFile {
    const id = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(path.join(filesDir, workspaceId), { recursive: true });
    fs.writeFileSync(path.join(filesDir, workspaceId, id), bytes);
    return { id, name, mediaType, bytes: bytes.length };
  }

  async function start(opts: { allowTranscript?: boolean; announce?: string[] } = {}) {
    const ports = { rooms: () => writer } as unknown as PhoneFactoryPorts;
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      queueMicrotask(() => bridge.complete(clientId, { requestId: data.requestId, ok: true, result: handlePhoneRoomCommand(data.command, data.payload, ports) }));
      return true;
    }, 2000);
    bridge.register('main', opts.announce ?? ['workspaces.roomFile']);
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        return deviceId === 'd1' && secret === 's1' ? { ok: true, deviceId, allowInput: false } : { ok: false, reason: 'unknown' };
      },
      list: () => [],
      hasExplicitInputGrant: () => false,
    };
    const sessionManager = Object.assign(new EventEmitter(), { getSession: () => undefined, listLiveSessions: () => [] }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager, devices, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir(), roomFilesDir: filesDir,
    });
    await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, allowTranscript: opts.allowTranscript ?? true });
    const base = `http://127.0.0.1:${server.status().port}`;
    const auth = { Authorization: 'Bearer d1.s1' };
    return {
      config: async () => (await (await fetch(`${base}/api/config`, { headers: auth })).json()) as Record<string, unknown>,
      file: (ws: string, id: string) => fetch(`${base}/api/rooms/${ws}/files/${id}`, { headers: auth }),
      /** A download whose headers arrived and whose body is no longer read. */
      held: async (ws: string, id: string) => {
        const req = http.get(`${base}/api/rooms/${ws}/files/${id}`, { headers: auth });
        const [res] = await once(req, 'response') as [http.IncomingMessage];
        res.pause();
        return { status: res.statusCode, drop: () => { req.destroy(); } };
      },
    };
  }

  it('streams a bot card\'s file with main\'s type, inert and uncached, and /api/config says it answers', async () => {
    // Larger than one stream chunk, so the bytes really are piped.
    const video = Buffer.concat([Buffer.from('\0\0\0\x18ftypmp42'), crypto.randomBytes(2 * 1024 * 1024)]);
    const f = store('ws-1', 'card news (final).mp4', 'video/mp4', video);
    expect(writer.post({ workspaceId: 'ws-1', kind: 'report', actor: BOT, title: 'Card news', files: [f] })).toMatchObject({ ok: true });
    const s = await start();
    expect(await s.config()).toMatchObject({ roomFiles: true });
    const res = await s.file('ws-1', f.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe(String(video.length));
    expect(res.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''card%20news%20%28final%29.mp4");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await res.arrayBuffer()).equals(video)).toBe(true);
  });

  it('sends a type the phone may not show in place as a download: octet-stream, attachment', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const f = store('ws-1', 'logo.svg', 'image/svg+xml', svg);
    writer.post({ workspaceId: 'ws-1', kind: 'report', actor: BOT, title: 'Logo', files: [f] });
    const s = await start();
    const res = await s.file('ws-1', f.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''logo.svg");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(svg)).toBe(true);
  });

  it('lets one caller hold four downloads at once; a fifth is 429 until one ends', async () => {
    const f = store('ws-1', 'big.mp4', 'video/mp4', crypto.randomBytes(8 * 1024 * 1024));
    writer.post({ workspaceId: 'ws-1', kind: 'report', actor: BOT, title: 'Video', files: [f] });
    const s = await start();
    const open = [];
    for (let i = 0; i < 4; i++) open.push(await s.held('ws-1', f.id));
    expect(open.map((d) => d.status)).toEqual([200, 200, 200, 200]);
    const fifth = await s.file('ws-1', f.id);
    expect(fifth.status).toBe(429);
    expect(await fifth.json()).toEqual({ error: 'too-many-downloads' });
    open.pop()?.drop();
    await vi.waitFor(async () => {
      const again = await s.held('ws-1', f.id);
      again.drop();
      expect(again.status).toBe(200);
    }, { timeout: 10_000 });
    for (const d of open) d.drop();
  });

  it('treats a bot card written in a guest\'s turn as the cards feed does: listed there, and served', async () => {
    const f = store('ws-1', 'reply.txt', 'text/plain', Buffer.from('hi'));
    expect(writer.post({ workspaceId: 'ws-1', kind: 'report', actor: BOT, title: 'For the guest', files: [f], origin: 'guest' })).toMatchObject({ ok: true });
    const ports = {
      rooms: () => writer, bots: () => [], roomFileExists: () => true, roomReadable: () => true,
    } as unknown as PhoneFactoryPorts;
    const page = handlePhoneRoomCommand('workspaces.roomCards', { workspaceId: 'ws-1', limit: 50 }, ports) as { cards: Array<{ title: string; files?: unknown }> };
    expect(page.cards.find((c) => c.title === 'For the guest')?.files).toEqual([f]);
    const s = await start();
    expect((await s.file('ws-1', f.id)).status).toBe(200);
  });

  it('is the same 404 for a file no bot card of that room lists, another room, a changed copy or a link', async () => {
    const listed = store('ws-1', 'a.png', 'image/png', crypto.randomBytes(64));
    const unlisted = store('ws-1', 'b.png', 'image/png', crypto.randomBytes(64));
    const owners = store('ws-1', 'c.png', 'image/png', crypto.randomBytes(64));
    const resized = store('ws-1', 'd.png', 'image/png', crypto.randomBytes(64));
    const linked = store('ws-1', 'e.png', 'image/png', crypto.randomBytes(64));
    fs.writeFileSync(path.join(filesDir, 'ws-1', resized.id), crypto.randomBytes(65));
    const outside = path.join(dir, 'outside.png');
    fs.writeFileSync(outside, crypto.randomBytes(64));
    fs.rmSync(path.join(filesDir, 'ws-1', linked.id));
    fs.symlinkSync(outside, path.join(filesDir, 'ws-1', linked.id));
    writer.post({ workspaceId: 'ws-1', kind: 'report', actor: BOT, title: 'Pictures', files: [listed, resized, linked] });
    writer.post({ workspaceId: 'ws-1', kind: 'human', actor: { kind: 'human' }, title: 'Mine', files: [owners] });
    const s = await start();
    expect((await s.file('ws-1', listed.id)).status).toBe(200);
    for (const [ws, id] of [['ws-1', unlisted.id], ['ws-1', owners.id], ['ws-2', listed.id], ['ws-1', resized.id], ['ws-1', linked.id], ['ws-1', '..%2F..%2Fsecret']]) {
      const res = await s.file(ws, id);
      expect(res.status, `${ws}/${id}`).toBe(404);
      expect(await res.json()).toEqual({ error: 'file-not-found' });
    }
  });

  it('needs the transcript grant and a desktop that serves files', async () => {
    const f = store('ws-1', 'a.txt', 'text/plain', Buffer.from('hello'));
    writer.post({ workspaceId: 'ws-1', kind: 'report', actor: BOT, title: 'Notes', files: [f] });
    let s = await start({ allowTranscript: false });
    expect(await s.config()).not.toHaveProperty('roomFiles');
    expect((await s.file('ws-1', f.id)).status).toBe(403);
    await server?.stop();
    s = await start({ announce: ['workspaces.roomAttachment'] });
    expect(await s.config()).not.toHaveProperty('roomFiles');
    expect((await s.file('ws-1', f.id)).status).toBe(503);
  });
});

describe('the cards the phone reads', () => {
  it('carry a bot card\'s files on the newest page and on a forward read alike: the one path cards reach the phone', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'cards-'));
    const writer = new RoomWriter({ dir: path.join(dir, 'rooms'), log: () => undefined });
    const file = { id: 'd'.repeat(32), name: 'banner.png', mediaType: 'image/png', bytes: 9 };
    writer.post({ workspaceId: 'ws-1', kind: 'status', actor: BOT, title: 'Working on it' });
    writer.post({ workspaceId: 'ws-1', kind: 'report', actor: BOT, title: 'Banner', files: [file] });
    const ports = {
      rooms: () => writer, bots: () => [{ id: BOT.botId, workspaceId: 'ws-1', role: 'lead', name: 'Lead' }],
      roomFileExists: () => true, roomReadable: () => true,
    } as unknown as PhoneFactoryPorts;
    const newest = handlePhoneRoomCommand('workspaces.roomCards', { workspaceId: 'ws-1', limit: 50 }, ports) as { cards: Array<{ title: string; files?: unknown }> };
    const forward = handlePhoneRoomCommand('workspaces.roomCards', { workspaceId: 'ws-1', sinceSeq: 1, limit: 50 }, ports) as { cards: Array<{ title: string; files?: unknown }> };
    expect(newest.cards.find((c) => c.title === 'Banner')?.files).toEqual([file]);
    expect(forward.cards.map((c) => [c.title, c.files])).toEqual([['Banner', [file]]]);
  });
});

describe('workspaces.roomFile', () => {
  it('names a file only from a bot\'s card, the card the desktop opens it from', () => {
    const file = { id: 'a'.repeat(32), name: 'a.png', mediaType: 'image/png', bytes: 3 };
    const cards = [
      { kind: 'human', actor: { kind: 'human' }, files: [file] },
      { kind: 'report', actor: BOT, files: [{ ...file, id: 'b'.repeat(32) }] },
    ];
    const rooms = { find: (_ws: string, match: (c: unknown) => boolean) => cards.find(match) ?? null };
    const ports = { rooms: () => rooms } as unknown as PhoneFactoryPorts;
    expect(handlePhoneRoomCommand('workspaces.roomFile', { workspaceId: 'ws-1', fileId: 'a'.repeat(32) }, ports)).toEqual({ notFound: true });
    expect(handlePhoneRoomCommand('workspaces.roomFile', { workspaceId: 'ws-1', fileId: 'b'.repeat(32) }, ports)).toEqual({ file: { name: 'a.png', mediaType: 'image/png', bytes: 3 } });
    expect(handlePhoneRoomCommand('workspaces.roomFile', { workspaceId: 'ws-1', fileId: '../x' }, ports)).toEqual({ invalid: true });
  });
});
