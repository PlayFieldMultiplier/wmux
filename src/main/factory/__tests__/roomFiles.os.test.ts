import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOM_FILE_RETAIN_MS, RoomFileStore, parseRoomFiles, roomFileMediaType, roomFileName } from '../roomFiles';
import { RoomWriter } from '../roomWriter';
import { handleRoomPost, type BotFileRoots, type RoomHandlerDeps } from '../../pipe/handlers/room.rpc';
import { ROOM_FILE_LIMITS, type RoomFile } from '../../../shared/roomFiles';
import type { BotBinding, BotProfile } from '../../../shared/bot';
import type { RoomCard } from '../../../shared/room';
import type { RpcContext } from '../../../shared/rpc';

const WS = 'ws-files-1';
const BOT_ID = 'bot-0a1b2c3d';

let dir = '';
let now = 0;
let store: RoomFileStore;
/** The allowed root (a bot's repository) and a folder outside it. */
const repo = () => path.join(dir, 'repo');
const outside = () => path.join(dir, 'elsewhere');
const storeRoot = () => path.join(dir, 'factory', 'room-files');
const write = (file: string, data: string | Buffer = 'hello\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const stored = () => (fs.existsSync(path.join(storeRoot(), WS)) ? fs.readdirSync(path.join(storeRoot(), WS)) : []);

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-room-files-')));
  fs.mkdirSync(repo(), { recursive: true });
  fs.mkdirSync(outside(), { recursive: true });
  now = Date.now();
  store = new RoomFileStore({ root: storeRoot(), now: () => now, log: () => undefined });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('room file rules', () => {
  it('types a file by its extension and keeps only its last path segment as the name', () => {
    expect(roomFileMediaType('report.md')).toBe('text/markdown');
    expect(roomFileMediaType('a.JSON')).toBe('application/json');
    expect(roomFileMediaType('pic.jpeg')).toBe('image/jpeg');
    expect(roomFileMediaType('x.svg')).toBe('image/svg+xml');
    expect(roomFileMediaType('main.ts')).toBe('text/plain');
    expect(roomFileMediaType('change.patch')).toBe('text/x-diff');
    expect(roomFileMediaType('blob.bin')).toBe('application/octet-stream');
    expect(roomFileMediaType('Makefile')).toBe('application/octet-stream');
    expect(roomFileName('/a/b/report.md')).toBe('report.md');
    expect(roomFileName('C:\\a\\b\\x\u0007y.txt')).toBe('xy.txt');
    const long = roomFileName(`/a/${'n'.repeat(300)}.md`);
    expect(long).toHaveLength(ROOM_FILE_LIMITS.NAME_MAX);
    expect(long.endsWith('.md')).toBe(true);
  });

  it('parses stored lists strictly', () => {
    const id = 'a'.repeat(32);
    const ok = { id, name: 'r.md', mediaType: 'text/markdown', bytes: 3 };
    expect(parseRoomFiles([{ ...ok, extra: 1 }])).toEqual([ok]);
    expect(parseRoomFiles([{ ...ok, id: '../x' }])).toBeUndefined();
    expect(parseRoomFiles([{ ...ok, name: 'a/b.md' }])).toBeUndefined();
    expect(parseRoomFiles([{ ...ok, mediaType: 'text/javascript+evil' }])).toBeUndefined();
    expect(parseRoomFiles([{ ...ok, bytes: 0 }])).toBeUndefined();
    expect(parseRoomFiles([ok, ok])).toHaveLength(1);
    const many = Array.from({ length: 12 }, (_, i) => ({ ...ok, id: i.toString(16).repeat(32).slice(0, 32) }));
    expect(parseRoomFiles(many)).toHaveLength(ROOM_FILE_LIMITS.PER_CARD);
  });
});

describe('RoomFileStore.copyIn', () => {
  it('copies a regular file inside an allowed root, 0600 in a 0700 folder', () => {
    const src = write(path.join(repo(), 'docs', 'report.md'), '# Report\n');
    const r = store.copyIn(WS, src, [repo()]);
    expect(r).toMatchObject({ ok: true, file: { name: 'report.md', mediaType: 'text/markdown', bytes: 9 } });
    if (!r.ok) return;
    expect(store.read(WS, r.file.id)?.toString()).toBe('# Report\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(store.file(WS, r.file.id)!).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(storeRoot(), WS)).mode & 0o777).toBe(0o700);
    }
  });

  it('refuses a file outside every root, a `..` escape, and a root that is not there', () => {
    const out = write(path.join(outside(), 'secret.txt'));
    expect(store.copyIn(WS, out, [repo()])).toMatchObject({ ok: false, reason: 'outside' });
    expect(store.copyIn(WS, path.join(repo(), '..', 'elsewhere', 'secret.txt'), [repo()])).toMatchObject({ ok: false, reason: 'outside' });
    expect(store.copyIn(WS, out, [path.join(dir, 'missing-root')])).toMatchObject({ ok: false, reason: 'outside' });
    // The root itself is not a file inside it.
    expect(store.copyIn(WS, repo(), [repo()])).toMatchObject({ ok: false, reason: 'outside' });
    expect(store.copyIn(WS, 'relative.txt', [repo()])).toMatchObject({ ok: false, reason: 'missing' });
    expect(stored()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses a link, whether it points out of the root or inside it', () => {
    const out = write(path.join(outside(), 'secret.txt'));
    fs.symlinkSync(out, path.join(repo(), 'out-link.txt'));
    expect(store.copyIn(WS, path.join(repo(), 'out-link.txt'), [repo()])).toMatchObject({ ok: false, reason: 'outside' });
    const inside = write(path.join(repo(), 'real.txt'));
    fs.symlinkSync(inside, path.join(repo(), 'in-link.txt'));
    expect(store.copyIn(WS, path.join(repo(), 'in-link.txt'), [repo()])).toMatchObject({ ok: false, reason: 'not_file' });
    // A linked folder that leads out of the root.
    fs.symlinkSync(outside(), path.join(repo(), 'linked-dir'));
    expect(store.copyIn(WS, path.join(repo(), 'linked-dir', 'secret.txt'), [repo()])).toMatchObject({ ok: false, reason: 'outside' });
    expect(stored()).toEqual([]);
  });

  it('refuses a folder, a missing file, an empty file, an oversized file and a protected file', () => {
    fs.mkdirSync(path.join(repo(), 'sub'));
    expect(store.copyIn(WS, path.join(repo(), 'sub'), [repo()])).toMatchObject({ ok: false, reason: 'not_file' });
    expect(store.copyIn(WS, path.join(repo(), 'nope.md'), [repo()])).toMatchObject({ ok: false, reason: 'missing' });
    expect(store.copyIn(WS, write(path.join(repo(), 'empty.txt'), ''), [repo()])).toMatchObject({ ok: false, reason: 'empty' });
    const big = path.join(repo(), 'big.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, ROOM_FILE_LIMITS.MAX_BYTES + 1);
    expect(store.copyIn(WS, big, [repo()])).toMatchObject({ ok: false, reason: 'size' });
    expect(store.copyIn(WS, write(path.join(repo(), '.env'), 'TOKEN=x'), [repo()])).toMatchObject({ ok: false, reason: 'protected' });
    expect(store.copyIn(WS, write(path.join(repo(), '.git', 'config'), 'x'), [repo()])).toMatchObject({ ok: false, reason: 'protected' });
    expect(stored()).toEqual([]);
  });

  it('refuses once the room holds its file count or its bytes, and evicts nothing', () => {
    const src = write(path.join(repo(), 'a.txt'));
    const wsDir = path.join(storeRoot(), WS);
    fs.mkdirSync(wsDir, { recursive: true });
    for (let i = 0; i < ROOM_FILE_LIMITS.ROOM_MAX_FILES; i++) fs.writeFileSync(path.join(wsDir, i.toString(16).padStart(32, '0')), '');
    expect(store.copyIn(WS, src, [repo()])).toMatchObject({ ok: false, reason: 'full' });
    expect(stored()).toHaveLength(ROOM_FILE_LIMITS.ROOM_MAX_FILES);
    const other = new RoomFileStore({ root: storeRoot(), now: () => now, log: () => undefined });
    const ws2 = path.join(storeRoot(), 'ws-files-2');
    fs.mkdirSync(ws2, { recursive: true });
    const huge = path.join(ws2, 'f'.repeat(32));
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, ROOM_FILE_LIMITS.ROOM_MAX_BYTES);
    expect(other.copyIn('ws-files-2', src, [repo()])).toMatchObject({ ok: false, reason: 'full' });
  });

  it('sweeps stored files older than the room keeps a card, and stray temporary files', () => {
    const keep = store.copyIn(WS, write(path.join(repo(), 'keep.txt')), [repo()]);
    const old = store.copyIn(WS, write(path.join(repo(), 'old.txt')), [repo()]);
    if (!keep.ok || !old.ok) throw new Error('copy failed');
    const wsDir = path.join(storeRoot(), WS);
    const past = (ms: number) => new Date(now - ms);
    fs.utimesSync(path.join(wsDir, old.file.id), past(ROOM_FILE_RETAIN_MS + 1000), past(ROOM_FILE_RETAIN_MS + 1000));
    const temp = path.join(wsDir, `${'c'.repeat(32)}.tmp`);
    fs.writeFileSync(temp, 'x');
    fs.utimesSync(temp, past(2 * 3600_000), past(2 * 3600_000));
    fs.writeFileSync(path.join(wsDir, 'not-ours'), 'x');
    fs.utimesSync(path.join(wsDir, 'not-ours'), past(ROOM_FILE_RETAIN_MS + 1000), past(ROOM_FILE_RETAIN_MS + 1000));
    store.sweep();
    expect(stored().sort()).toEqual([keep.file.id, 'not-ours'].sort());
  });
});

// ── room_post `files` ──────────────────────────────────────────────────────

const binding: BotBinding = { workspaceId: WS, botId: BOT_ID, role: 'lead' } as BotBinding;
const AS_BOT: RpcContext = { origin: 'local', bot: binding };
const OPERATOR: RpcContext = { origin: 'local', operator: true };

function postSetup(roots: BotFileRoots = { roots: [repo()], base: repo() }) {
  const roomsDir = path.join(dir, 'factory', 'rooms');
  const writer = new RoomWriter({ dir: roomsDir, log: () => undefined });
  const profile = { id: BOT_ID, workspaceId: WS, role: 'lead', enabled: true } as unknown as BotProfile;
  const deps: RoomHandlerDeps = {
    writer: () => writer,
    ports: () => ({ bots: { get: (id: string) => (id === BOT_ID ? profile : null), listEnabled: () => [profile] } }),
    wmuxDir: () => dir,
    files: () => store,
    fileRoots: async () => roots,
  };
  return { writer, deps, roomsDir };
}

describe('room_post files', () => {
  it('a bot attaches files by absolute or repository-relative path; the card keeps them across a reload', async () => {
    const s = postSetup();
    write(path.join(repo(), 'out', 'spec.md'), '# Spec\n');
    const diff = write(path.join(repo(), 'change.diff'), 'diff --git\n');
    const r = await handleRoomPost({ kind: 'status', title: 'Done', clientPostId: 'p-1', files: ['out/spec.md', diff] }, AS_BOT, s.deps) as { ok: true; card: RoomCard };
    expect(r.ok).toBe(true);
    expect(r.card.files?.map((f) => [f.name, f.mediaType])).toEqual([['spec.md', 'text/markdown'], ['change.diff', 'text/x-diff']]);
    expect(stored().sort()).toEqual(r.card.files!.map((f) => f.id).sort());
    expect(JSON.stringify(r.card)).not.toContain(repo());
    const reloaded = new RoomWriter({ dir: s.roomsDir, log: () => undefined });
    expect(reloaded.get(WS, r.card.id)?.files).toEqual(r.card.files);
    // A repeat of the post keeps that card's files and copies nothing.
    const again = await handleRoomPost({ kind: 'status', title: 'Done', clientPostId: 'p-1', files: ['out/spec.md'] }, AS_BOT, s.deps) as { ok: true; card: RoomCard; duplicate?: true };
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(again.card.files).toEqual(r.card.files);
    expect(stored()).toHaveLength(2);
  });

  it('one file that cannot be taken refuses the whole post, naming it, and leaves no copy', async () => {
    const s = postSetup();
    write(path.join(repo(), 'good.md'));
    const bad = write(path.join(outside(), 'x.md'));
    const r = await handleRoomPost({ kind: 'status', title: 'Done', files: ['good.md', bad] }, AS_BOT, s.deps) as { ok: false; code: string; message: string };
    expect(r).toMatchObject({ ok: false, code: 'file' });
    expect(r.message).toContain('files[1]');
    expect(r.message).toContain('not inside your repository');
    expect(stored()).toEqual([]);
    expect(s.writer.read(WS).cards).toEqual([]);
  });

  it('refuses more files than a card carries, a malformed list, and a relative path with no repository', async () => {
    const s = postSetup({ roots: [repo()] });
    const many = Array.from({ length: ROOM_FILE_LIMITS.PER_CARD + 1 }, (_, i) => write(path.join(repo(), `f${i}.txt`)));
    expect(await handleRoomPost({ kind: 'status', title: 'T', files: many }, AS_BOT, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handleRoomPost({ kind: 'status', title: 'T', files: 'a.md' }, AS_BOT, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handleRoomPost({ kind: 'status', title: 'T', files: [''] }, AS_BOT, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    const rel = await handleRoomPost({ kind: 'status', title: 'T', files: ['f0.txt'] }, AS_BOT, s.deps) as { message: string };
    expect(rel).toMatchObject({ ok: false, code: 'file' });
    expect(rel.message).toContain('absolute path');
    expect(stored()).toEqual([]);
  });

  it('the owner may not attach files, and a card written with files by anyone but a bot keeps none', async () => {
    const s = postSetup();
    write(path.join(repo(), 'a.md'));
    expect(await handleRoomPost({ workspaceId: WS, title: 'hi', files: [path.join(repo(), 'a.md')] }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    const forged: RoomFile[] = [{ id: 'd'.repeat(32), name: 'x.md', mediaType: 'text/markdown', bytes: 1 }];
    const human = s.writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: 'hi', files: forged });
    expect(human.ok && human.card.files).toBeFalsy();
    expect(stored()).toEqual([]);
  });
});
