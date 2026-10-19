import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, fn); }),
    removeHandler: vi.fn((channel: string) => { ipcHandlers.delete(channel); }),
  },
  dialog: {},
  nativeImage: {},
}));

import { IPC } from '../../../../shared/constants';
import { RoomWriter } from '../../../factory/roomWriter';
import { RoomFileStore } from '../../../factory/roomFiles';
import { registerRoomIpcHandlers } from '../room.handler';
import type { RoomCard } from '../../../../shared/room';
import type { RoomFile, RoomFileReadResult, RoomFileSaveResult } from '../../../../shared/roomFiles';

/**
 * A bot's files on its cards, as the Bots page reads them: only a file a
 * kept bot card of that room lists is served; text comes back as text,
 * anything else as a data URL; a save copies the stored file where the
 * owner picked.
 */

const WS = 'ws-file-ipc-1';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);

let dir = '';
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-room-files-ipc-')));
  ipcHandlers.clear();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
  const store = new RoomFileStore({ root: path.join(dir, 'factory', 'room-files'), log: () => undefined });
  const src = path.join(dir, 'repo');
  fs.mkdirSync(src, { recursive: true });
  let savePick: string | null = null;
  const mainFrame = { name: 'main' };
  const webContents = { id: 1, mainFrame };
  registerRoomIpcHandlers(() => ({ isDestroyed: () => false, webContents }) as never, {
    writer: () => writer, wmuxDir: () => dir, files: () => store, pickSavePath: async () => savePick,
  });
  const call = (channel: string, raw?: unknown, sender: unknown = webContents) =>
    (ipcHandlers.get(channel) as (e: unknown, raw: unknown) => Promise<unknown>)({ sender, senderFrame: mainFrame }, raw);
  /** A bot card in `ws` carrying the given files (copied into the store). */
  const botCard = (ws: string, files: Array<[string, string | Buffer]>): RoomCard => {
    const records: RoomFile[] = files.map(([name, data]) => {
      fs.writeFileSync(path.join(src, name), data);
      const r = store.copyIn(ws, path.join(src, name), [src]);
      if (!r.ok) throw new Error(r.message);
      return r.file;
    });
    const posted = writer.post({ workspaceId: ws, kind: 'status', actor: { kind: 'bot', workspaceId: ws, botId: 'bot-0a1b2c3d' }, title: 'files', files: records });
    if (!posted.ok) throw new Error('post failed');
    return posted.card;
  };
  return { writer, store, call, botCard, setSavePick: (p: string | null) => { savePick = p; } };
}

describe('ROOM_FILE_READ', () => {
  it('returns a text file as text and an image as a data URL', async () => {
    const s = setup();
    const card = s.botCard(WS, [['report.md', '# Report\n'], ['shot.png', PNG]]);
    const [md, png] = card.files!;
    const text = await s.call(IPC.ROOM_FILE_READ, { workspaceId: WS, fileId: md.id }) as RoomFileReadResult;
    expect(text).toEqual({ ok: true, file: md, text: '# Report\n' });
    const image = await s.call(IPC.ROOM_FILE_READ, { workspaceId: WS, fileId: png.id }) as RoomFileReadResult;
    expect(image).toEqual({ ok: true, file: png, dataUrl: `data:image/png;base64,${PNG.toString('base64')}` });
  });

  it('refuses an unknown id, another room\'s file, a stored file no card names, and another window', async () => {
    const s = setup();
    const card = s.botCard(WS, [['a.txt', 'a']]);
    const id = card.files![0].id;
    expect(await s.call(IPC.ROOM_FILE_READ, { workspaceId: WS, fileId: 'e'.repeat(32) })).toMatchObject({ ok: false });
    expect(await s.call(IPC.ROOM_FILE_READ, { workspaceId: WS, fileId: '../a' })).toMatchObject({ ok: false });
    expect(await s.call(IPC.ROOM_FILE_READ, { workspaceId: 'ws-file-ipc-2', fileId: id })).toMatchObject({ ok: false });
    // In the store, on no card.
    fs.writeFileSync(path.join(dir, 'repo', 'loose.txt'), 'x');
    const loose = s.store.copyIn(WS, path.join(dir, 'repo', 'loose.txt'), [path.join(dir, 'repo')]);
    if (!loose.ok) throw new Error('copy failed');
    expect(await s.call(IPC.ROOM_FILE_READ, { workspaceId: WS, fileId: loose.file.id })).toMatchObject({ ok: false });
    expect(await s.call(IPC.ROOM_FILE_READ, { workspaceId: WS, fileId: id }, { id: 2 })).toMatchObject({ ok: false, code: 'operator_only' });
    // A card's file whose copy is gone reads as gone.
    s.store.remove(WS, [id]);
    expect(await s.call(IPC.ROOM_FILE_READ, { workspaceId: WS, fileId: id })).toMatchObject({ ok: false, error: 'the file is no longer stored' });
  });
});

describe('ROOM_FILE_SAVE', () => {
  it('copies the stored file where the owner picked; a cancel saves nothing', async () => {
    const s = setup();
    const card = s.botCard(WS, [['notes.txt', 'keep me']]);
    const id = card.files![0].id;
    s.setSavePick(null);
    expect(await s.call(IPC.ROOM_FILE_SAVE, { workspaceId: WS, fileId: id })).toEqual({ ok: false, canceled: true });
    const target = path.join(dir, 'saved', 'notes.txt');
    fs.mkdirSync(path.dirname(target));
    s.setSavePick(target);
    const r = await s.call(IPC.ROOM_FILE_SAVE, { workspaceId: WS, fileId: id }) as RoomFileSaveResult;
    expect(r).toEqual({ ok: true, savedTo: target });
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
    expect(await s.call(IPC.ROOM_FILE_SAVE, { workspaceId: 'ws-file-ipc-2', fileId: id })).toMatchObject({ ok: false });
  });
});
