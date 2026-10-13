// A bot's picture: the stored-avatar check, the picker (crop, scale, encode,
// refusals), the store's create / setAvatar / read paths, the avatar IPC's
// main-window guard, and Add bot with a name and a picture.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { BOT_AVATAR_PX } from '../../../shared/bot';
import {
  BOT_AVATAR_MAX_BYTES,
  BOT_AVATAR_SOURCE_MAX_BYTES,
  avatarFromImage,
  parseBotAvatar,
  pickBotAvatar,
  type AvatarImage,
  type BotAvatarPickerDeps,
} from '../botAvatar';
import { BotStore, botsFilePath } from '../botStore';
import { createBotFromFolder } from '../botCreate';
import { factoryBotPickAvatarHandler, factoryBotSetAvatarHandler } from '../../ipc/handlers/factory.handler';
import { makePng, pngDataUrl } from './testPng';

let dir = '';
let store: BotStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-botstore-'));
  store = new BotStore(botsFilePath(dir));
});
afterEach(async () => {
  await store.flush().catch(() => undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseBotAvatar', () => {
  it('accepts a square PNG up to BOT_AVATAR_PX', () => {
    const url = pngDataUrl(BOT_AVATAR_PX, BOT_AVATAR_PX);
    expect(parseBotAvatar(url)).toBe(url);
    expect(parseBotAvatar(pngDataUrl(1, 1))).not.toBeNull();
  });

  it('refuses a wider, a non-square and an oversized PNG', () => {
    expect(parseBotAvatar(pngDataUrl(BOT_AVATAR_PX + 1, BOT_AVATAR_PX + 1))).toBeNull();
    expect(parseBotAvatar(pngDataUrl(64, 32))).toBeNull();
    expect(parseBotAvatar(pngDataUrl(16, 16, BOT_AVATAR_MAX_BYTES))).toBeNull();
  });

  it('refuses another prefix, bytes that are not a PNG, and non-canonical base64', () => {
    const b64 = makePng(16, 16).toString('base64');
    expect(parseBotAvatar(`data:image/jpeg;base64,${b64}`)).toBeNull();
    expect(parseBotAvatar(`DATA:image/png;base64,${b64}`)).toBeNull();
    expect(parseBotAvatar(`data:image/png;base64,${Buffer.from('GIF89a'.padEnd(64, 'x')).toString('base64')}`)).toBeNull();
    expect(parseBotAvatar(`data:image/png;base64,${b64.slice(0, -4)}`)).toBeNull(); // cut: no IEND
    expect(parseBotAvatar(`data:image/png;base64,${b64}\n`)).toBeNull();
    expect(parseBotAvatar('data:image/png;base64,')).toBeNull();
    expect(parseBotAvatar(42)).toBeNull();
  });

  it('refuses a PNG whose chunks are not whole: a bad CRC, no IDAT, bytes after IEND', () => {
    const png = makePng(16, 16);
    const url = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
    const badCrc = Buffer.from(png);
    badCrc[29] ^= 0xff; // IHDR's CRC
    expect(parseBotAvatar(url(badCrc))).toBeNull();
    // Signature + IHDR + IEND only.
    const noIdat = Buffer.concat([png.subarray(0, 33), png.subarray(png.length - 12)]);
    expect(parseBotAvatar(url(noIdat))).toBeNull();
    expect(parseBotAvatar(url(Buffer.concat([png, Buffer.from([0, 0, 0, 0])])))).toBeNull();
    expect(parseBotAvatar(url(png))).not.toBeNull();
    expect(parseBotAvatar(null)).toBeNull();
  });
});

/** A fake NativeImage that records the crop and the resize. */
function fakeImage(width: number, height: number, png: Buffer = makePng(Math.min(width, height, BOT_AVATAR_PX), Math.min(width, height, BOT_AVATAR_PX))) {
  const calls: string[] = [];
  const make = (w: number, h: number): AvatarImage => ({
    isEmpty: () => w === 0,
    getSize: () => ({ width: w, height: h }),
    crop: (r) => {
      calls.push(`crop ${r.x},${r.y} ${r.width}x${r.height}`);
      return make(r.width, r.height);
    },
    resize: (o) => {
      calls.push(`resize ${o.width}x${o.height}`);
      return make(o.width, o.height);
    },
    toPNG: () => png,
  });
  return { image: make(width, height), calls };
}

describe('avatarFromImage / pickBotAvatar', () => {
  it('crops the centre square and scales it to BOT_AVATAR_PX', () => {
    const { image, calls } = fakeImage(400, 300);
    const r = avatarFromImage(image);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['crop 50,0 300x300', `resize ${BOT_AVATAR_PX}x${BOT_AVATAR_PX}`]);
  });

  it('keeps a small square as it is', () => {
    const { image, calls } = fakeImage(48, 48);
    expect(avatarFromImage(image).ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it('answers unreadable for an empty image and too_large for an encode over the cap', () => {
    expect(avatarFromImage(fakeImage(0, 0).image)).toEqual({ ok: false, code: 'unreadable' });
    expect(avatarFromImage(fakeImage(64, 64, makePng(64, 64, BOT_AVATAR_MAX_BYTES)).image)).toEqual({ ok: false, code: 'too_large' });
  });

  function deps(over: Partial<BotAvatarPickerDeps> = {}): BotAvatarPickerDeps {
    return {
      chooseFile: vi.fn(async () => ['/pics/me.jpg']),
      fileSize: vi.fn(() => 1000),
      loadImage: vi.fn(() => fakeImage(200, 200).image),
      ...over,
    };
  }

  it('returns a preview for a picked file', async () => {
    const r = await pickBotAvatar(deps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(parseBotAvatar(r.avatar)).toBe(r.avatar);
  });

  it('cancelled when the dialog picks nothing', async () => {
    const d = deps({ chooseFile: vi.fn(async () => null) });
    expect(await pickBotAvatar(d)).toEqual({ ok: false, code: 'cancelled' });
    expect(await pickBotAvatar(deps({ chooseFile: vi.fn(async () => []) }))).toEqual({ ok: false, code: 'cancelled' });
    expect(d.loadImage).not.toHaveBeenCalled();
  });

  it('too_large before decoding a huge file; unreadable when the file or the decode fails', async () => {
    const big = deps({ fileSize: vi.fn(() => BOT_AVATAR_SOURCE_MAX_BYTES + 1) });
    expect(await pickBotAvatar(big)).toEqual({ ok: false, code: 'too_large' });
    expect(big.loadImage).not.toHaveBeenCalled();
    expect(await pickBotAvatar(deps({ fileSize: vi.fn(() => { throw new Error('ENOENT'); }) }))).toEqual({ ok: false, code: 'unreadable' });
    expect(await pickBotAvatar(deps({ loadImage: vi.fn(() => { throw new Error('bad'); }) }))).toEqual({ ok: false, code: 'unreadable' });
  });
});

describe('BotStore: avatar and name', () => {
  const avatar = pngDataUrl(32, 32);

  it('create keeps a valid picture and refuses a bad one', () => {
    const r = store.create({ workspaceId: 'ws-1', role: 'triage', avatar });
    expect(r).toMatchObject({ ok: true, bot: { avatar } });
    expect(store.create({ workspaceId: 'ws-1', role: 'lead', avatar: 'data:image/png;base64,AAAA' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.list()).toHaveLength(1);
  });

  it('setAvatar saves, persists and clears with null; refuses a bad picture and an unknown bot', async () => {
    const bot = store.create({ workspaceId: 'ws-1', role: 'triage' });
    if (!bot.ok) throw new Error('create failed');
    expect(store.setAvatar(bot.bot.id, avatar)).toMatchObject({ ok: true, bot: { avatar } });
    expect(store.setAvatar(bot.bot.id, pngDataUrl(200, 200))).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.setAvatar(bot.bot.id, 'https://example.com/a.png')).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.setAvatar('bot-ffffffff', avatar)).toMatchObject({ ok: false, code: 'not_found' });
    await store.flush();
    const reread = new BotStore(botsFilePath(dir));
    reread.load();
    expect(reread.get(bot.bot.id)?.avatar).toBe(avatar);
    const cleared = store.setAvatar(bot.bot.id, null);
    expect(cleared.ok && cleared.bot.avatar).toBeUndefined();
    expect(store.get(bot.bot.id)).not.toHaveProperty('avatar');
  });

  it('update never sets a picture (the pipe\'s bot.update path)', () => {
    const bot = store.create({ workspaceId: 'ws-1', role: 'triage' });
    if (!bot.ok) throw new Error('create failed');
    expect(store.update(bot.bot.id, { avatar })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.get(bot.bot.id)?.avatar).toBeUndefined();
  });

  it('a picture that fails the check on read is dropped and the bot kept', async () => {
    const bot = store.create({ workspaceId: 'ws-1', role: 'triage', avatar });
    if (!bot.ok) throw new Error('create failed');
    await store.flush();
    const file = botsFilePath(dir);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.bots[0].avatar = 'data:image/svg+xml;base64,PHN2Zz4=';
    fs.writeFileSync(file, JSON.stringify(raw));
    const reread = new BotStore(file);
    reread.load();
    expect(reread.get(bot.bot.id)).toMatchObject({ id: bot.bot.id, name: 'Triage' });
    expect(reread.get(bot.bot.id)).not.toHaveProperty('avatar');
  });

  it('a name is trimmed, at most 64 characters and has no control characters', () => {
    expect(store.create({ workspaceId: 'ws-1', role: 'triage', name: '  검증봇 ' })).toMatchObject({ ok: true, bot: { name: '검증봇' } });
    expect(store.create({ workspaceId: 'ws-1', role: 'lead', name: 'a\nb' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.create({ workspaceId: 'ws-1', role: 'lead', name: 'x'.repeat(65) })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.create({ workspaceId: 'ws-1', role: 'lead', name: '   ' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    const lead = store.create({ workspaceId: 'ws-1', role: 'lead', name: 'x'.repeat(64) });
    expect(lead.ok).toBe(true);
    if (lead.ok) expect(store.update(lead.bot.id, { name: 'Lead Two' })).toMatchObject({ ok: false, code: 'invalid_argument' });
  });
});

describe('createBotFromFolder: name and picture', () => {
  const repoDeps = {
    git: vi.fn(async (args: string[]) => ({ stdout: args[0] === 'rev-parse' ? '/src/app\n' : 'git@github.com:acme/app.git\n', stderr: '', code: 0 })),
    realpath: (p: string) => p,
  };

  it('creates a named bot with the picked picture; a bad picture creates nothing', async () => {
    const avatar = pngDataUrl(128, 128);
    const req = (ws: string, extra: Record<string, unknown>) => ({ workspaceId: ws, role: 'lead', repoFolder: '/src/app', ...extra });
    expect(await createBotFromFolder(store, req('ws-1', { name: 'Ada Lovelace', avatar }), repoDeps))
      .toMatchObject({ ok: true, bot: { name: 'Ada Lovelace', avatar } });
    expect(await createBotFromFolder(store, req('ws-2', { avatar: 'data:image/png;base64,iVBORw0KGgo=' }), repoDeps))
      .toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await createBotFromFolder(store, req('ws-3', {}), repoDeps)).toMatchObject({ ok: true, bot: { name: 'Lead' } });
    expect(store.list().filter((b) => b.avatar)).toHaveLength(1);
  });
});

describe('avatar IPC (main window only)', () => {
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;
  const main = { sender: webContents, senderFrame: mainFrame };

  it('pick: refused for any other sender without opening the dialog', async () => {
    const chooseFile = vi.fn(async () => ['/pics/me.png']);
    const d: BotAvatarPickerDeps = { chooseFile, fileSize: () => 10, loadImage: () => fakeImage(64, 64).image };
    const handler = factoryBotPickAvatarHandler(() => win, d);
    expect(await handler({ sender: {}, senderFrame: mainFrame })).toEqual({ ok: false, code: 'operator_only' });
    expect(await handler({ sender: webContents, senderFrame: { id: 'sub' } })).toEqual({ ok: false, code: 'operator_only' });
    expect(await factoryBotPickAvatarHandler(() => null, d)(main)).toEqual({ ok: false, code: 'operator_only' });
    expect(chooseFile).not.toHaveBeenCalled();
    expect(await handler(main)).toMatchObject({ ok: true });
  });

  it('set: refused for any other sender; saves, clears and refuses bad input for the main window', async () => {
    const bot = store.create({ workspaceId: 'ws-1', role: 'triage' });
    if (!bot.ok) throw new Error('create failed');
    const avatar = pngDataUrl(64, 64);
    const handler = factoryBotSetAvatarHandler(() => win, () => store);
    expect(await handler({ sender: {}, senderFrame: mainFrame }, { botId: bot.bot.id, avatar })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(store.get(bot.bot.id)?.avatar).toBeUndefined();
    expect(await handler(main, { botId: bot.bot.id, avatar })).toMatchObject({ ok: true, bot: { avatar } });
    expect(await handler(main, { botId: bot.bot.id, avatar: 'not a picture' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await handler(main, { botId: bot.bot.id })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await handler(main, { botId: '../x', avatar })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await handler(main, { botId: 'bot-ffffffff', avatar })).toMatchObject({ ok: false, code: 'not_found' });
    expect(store.get(bot.bot.id)?.avatar).toBe(avatar);
    expect(await handler(main, { botId: bot.bot.id, avatar: null })).toMatchObject({ ok: true });
    expect(store.get(bot.bot.id)?.avatar).toBeUndefined();
    expect(await factoryBotSetAvatarHandler(() => win, () => null)(main, { botId: bot.bot.id, avatar })).toMatchObject({ ok: false, code: 'not_started' });
  });
});
