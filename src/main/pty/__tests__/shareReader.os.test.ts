// #2407 — the git watcher's reader processes: share reads run in a child that
// a missed deadline kills, so a hung read never holds this process's fs pool.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { ChildProbeReader, InProcessProbeReader, SHARE_READER_SOURCE } from '../shareReader';
import { defaultReaders } from '../gitContextWatch';

/** Answers like the real reader, except that a path named `hang` never answers. */
const HANGING_SOURCE = SHARE_READER_SOURCE.replace(
  'answer(req.op, req.path).then(',
  "if (req.path.endsWith('hang')) continue;\n    answer(req.op, req.path).then(",
);

const readers: ChildProbeReader[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function reader(deadlineMs = 10_000, source = SHARE_READER_SOURCE): ChildProbeReader {
  const r = new ChildProbeReader(deadlineMs, source);
  readers.push(r);
  return r;
}

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-share-reader-'));
  dirs.push(dir);
  return dir;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function gone(pid: number, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

describe('the git watcher\'s default readers', () => {
  it('reads a distro\'s share in a reader process, any other path in this process', () => {
    const share = defaultReaders('ubuntu');
    const host = defaultReaders('');
    try {
      expect(share).toBeInstanceOf(ChildProbeReader);
      expect(host).toBeInstanceOf(InProcessProbeReader);
    } finally {
      share.close();
      host.close();
    }
  });
});

describe('ChildProbeReader', () => {
  it('answers stat, read and realpath the way the watcher\'s walk expects', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    const r = reader();
    expect(await r.read({ op: 'stat', path: dir })).toBe('dir');
    expect(await r.read({ op: 'stat', path: path.join(dir, 'HEAD') })).toBe('file');
    expect(await r.read({ op: 'stat', path: path.join(dir, 'nope') })).toBe('missing');
    expect(await r.read({ op: 'stat', path: path.join(dir, 'HEAD', 'x') })).toBe('missing'); // ENOTDIR
    expect(await r.read({ op: 'read', path: path.join(dir, 'HEAD') })).toBe('ref: refs/heads/main\n');
    expect(await r.read({ op: 'read', path: path.join(dir, 'nope') })).toBeNull();
    expect(await r.read({ op: 'realpath', path: dir })).toBe(fs.realpathSync.native(dir));
    expect(r.starts).toBe(1); // one process for every read
    expect(r.outstanding).toBe(0);
  }, 20_000);

  it('kills a reader whose read misses the deadline and starts a new one on the next read', async () => {
    const r = reader(500, HANGING_SOURCE);
    const dir = tmp();
    expect(await r.read({ op: 'stat', path: dir })).toBe('dir');
    const first = r.pid!;
    await expect(r.read({ op: 'stat', path: path.join(dir, 'hang') })).rejects.toThrow(/no answer within 500 ms/);
    expect(r.kills).toBe(1);
    expect(r.pid).toBeUndefined();
    expect(await gone(first)).toBe(true);
    expect(await r.read({ op: 'stat', path: dir })).toBe('dir');
    expect(r.starts).toBe(2);
    expect(r.pid).not.toBe(first);
  }, 20_000);

  it('a cancelled read waiting in the queue leaves it and never reaches the process', async () => {
    const r = reader(500, HANGING_SOURCE);
    const dir = tmp();
    const hung = r.read({ op: 'stat', path: path.join(dir, 'hang') });
    const cancel = new AbortController();
    const queued = r.read({ op: 'stat', path: path.join(dir, 'also-hang') }, cancel.signal);
    expect(r.outstanding).toBe(2);
    cancel.abort();
    await expect(queued).rejects.toThrow(/cancelled/);
    expect(r.outstanding).toBe(1);
    await expect(hung).rejects.toThrow(/no answer within 500 ms/);
    expect(r.kills).toBe(1);
    // Handed over, the cancelled read would have hung the new process too,
    // and this read would have waited out a second deadline behind it.
    expect(await r.read({ op: 'stat', path: dir })).toBe('dir');
    expect(r.kills).toBe(1);
    expect(r.starts).toBe(2);
  }, 20_000);

  it('reads one at a time: the next waits on the one being read, even a cancelled one', async () => {
    const r = reader(500, HANGING_SOURCE);
    const dir = tmp();
    const cancel = new AbortController();
    const hung = r.read({ op: 'stat', path: path.join(dir, 'hang') }, cancel.signal);
    const next = r.read({ op: 'stat', path: dir });
    cancel.abort();
    await expect(hung).rejects.toThrow(/cancelled/); // settles at once
    expect(r.outstanding).toBe(1);
    // The process is still inside the cancelled read: its deadline frees it.
    expect(await next).toBe('dir');
    expect(r.kills).toBe(1);
    expect(r.starts).toBe(2);
  }, 20_000);

  it('a cancelled read that the process answers keeps the process', async () => {
    const r = reader();
    const dir = tmp();
    const cancel = new AbortController();
    const first = r.read({ op: 'stat', path: dir }, cancel.signal);
    const second = r.read({ op: 'stat', path: path.join(dir, 'nope') });
    cancel.abort();
    await expect(first).rejects.toThrow(/cancelled/);
    expect(await second).toBe('missing');
    expect(r.kills).toBe(0);
    expect(r.starts).toBe(1);
  }, 20_000);

  it('while reads hang in one reader, another reader and this process\'s own fs calls go on', async () => {
    const dir = tmp();
    const wedged = reader(10_000, HANGING_SOURCE);
    // More hung reads than libuv has fs threads (4): none of them is ours.
    const hung = Array.from({ length: 6 }, () => wedged.read({ op: 'stat', path: path.join(dir, 'hang') }).catch(() => 'failed'));
    const healthy = reader();
    const started = Date.now();
    expect(await healthy.read({ op: 'stat', path: dir })).toBe('dir');
    const stats = await Promise.all(Array.from({ length: 8 }, () => fs.promises.stat(dir)));
    expect(stats.every((s) => s.isDirectory())).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(wedged.outstanding).toBe(6);
    wedged.close();
    expect(await Promise.all(hung)).toEqual(Array(6).fill('failed'));
  }, 20_000);

  it('close() rejects what is outstanding and leaves no process', async () => {
    const r = reader(10_000, HANGING_SOURCE);
    const dir = tmp();
    expect(await r.read({ op: 'stat', path: dir })).toBe('dir');
    const pid = r.pid!;
    const hung = r.read({ op: 'stat', path: path.join(dir, 'hang') });
    r.close();
    await expect(hung).rejects.toThrow(/closed/);
    expect(await gone(pid)).toBe(true);
    await expect(r.read({ op: 'stat', path: dir })).rejects.toThrow(/closed/);
  }, 20_000);

  it('the reader script runs under Electron\'s node too (the daemon\'s and main\'s runtime)', async () => {
    let electron: string;
    try { electron = createRequire(__filename)('electron') as unknown as string; } catch { return; }
    if (typeof electron !== 'string' || !fs.existsSync(electron)) return;
    const dir = tmp();
    const child = spawn(electron, ['-e', SHARE_READER_SOURCE], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        let out = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { out += chunk; if (out.includes('\n')) resolve(out.trim()); });
        child.on('error', reject);
        child.stdin.write(`${JSON.stringify({ id: 1, op: 'stat', path: dir })}\n`);
      });
      expect(JSON.parse(reply)).toEqual({ id: 1, answer: 'dir' });
    } finally {
      child.kill();
    }
  }, 30_000);
});
