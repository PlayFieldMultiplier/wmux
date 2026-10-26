import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFileExclusive, releaseDaemonFiles, replaceFileOrWrite, unlinkIfContent } from '../daemonFiles';

// daemonFiles reaches fs through a namespace import, which vi.spyOn cannot
// patch: wrap the calls it makes instead. The test's own `fs` is the real one.
const fsHooks = vi.hoisted(() => ({
  linkError: null as string | null,
  /** renameSync fails with renameError this many more times. */
  renameFailures: 0,
  renameError: 'EPERM',
  tempWriteError: null as string | null,
  writes: [] as string[],
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  return {
    ...actual,
    default: actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) =>
      fsHooks.linkError ? fail(fsHooks.linkError) : actual.linkSync(...args),
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fsHooks.renameFailures > 0) {
        fsHooks.renameFailures--;
        fail(fsHooks.renameError);
      }
      return actual.renameSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      fsHooks.writes.push(String(args[0]));
      if (fsHooks.tempWriteError && String(args[0]).endsWith('.tmp')) fail(fsHooks.tempWriteError);
      return actual.writeFileSync(...args);
    },
  };
});

describe('daemonFiles', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfiles-')); });
  afterEach(() => {
    Object.assign(fsHooks, { linkError: null, renameFailures: 0, renameError: 'EPERM', tempWriteError: null, writes: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = (name: string): string => path.join(dir, name);
  const read = (name: string): string | null => {
    try { return fs.readFileSync(file(name), 'utf8'); } catch { return null; }
  };

  it('creates a file only once and leaves no temp file behind', () => {
    const warn = vi.fn();
    expect(createFileExclusive(file('daemon.pid'), '11', warn)).toBe(true);
    expect(createFileExclusive(file('daemon.pid'), '22', warn)).toBe(false);
    expect(read('daemon.pid')).toBe('11');
    expect(replaceFileOrWrite(file('daemon.pid'), '33', warn)).toBe(true);
    expect(read('daemon.pid')).toBe('33');
    expect(fs.readdirSync(dir)).toEqual(['daemon.pid']);
    expect(warn).not.toHaveBeenCalled();
  });

  // daemon-pipe, daemon.pid and daemon-booting are replaced while other
  // processes read them: the target itself is never opened for writing.
  it('replaceFileOrWrite renames into place and never writes the target directly', () => {
    fs.writeFileSync(file('daemon-pipe'), 'old-pipe');
    const warn = vi.fn();
    expect(replaceFileOrWrite(file('daemon-pipe'), 'new-pipe', warn)).toBe(true);
    expect(fsHooks.writes.length).toBeGreaterThan(0);
    expect(fsHooks.writes).not.toContain(file('daemon-pipe'));
    expect(read('daemon-pipe')).toBe('new-pipe');
    expect(fs.readdirSync(dir)).toEqual(['daemon-pipe']);
    expect(warn).not.toHaveBeenCalled();
  });

  // On Windows an antivirus scan or a reader's handle refuses the rename for a
  // moment; that must not push the write onto the truncating path.
  it('replaceFileOrWrite retries a rename refused while the file is held', () => {
    fs.writeFileSync(file('daemon-pipe'), 'old-pipe');
    fsHooks.renameFailures = 2;
    const warn = vi.fn();
    expect(replaceFileOrWrite(file('daemon-pipe'), 'new-pipe', warn)).toBe(true);
    expect(fsHooks.renameFailures).toBe(0);
    expect(fsHooks.writes).not.toContain(file('daemon-pipe'));
    expect(read('daemon-pipe')).toBe('new-pipe');
    expect(fs.readdirSync(dir)).toEqual(['daemon-pipe']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('replaceFileOrWrite reports a rename that keeps failing and writes in place', () => {
    fsHooks.renameFailures = Infinity;
    const warn = vi.fn();
    expect(replaceFileOrWrite(file('daemon.pid'), '44', warn)).toBe(true);
    expect(read('daemon.pid')).toBe('44');
    expect(fs.readdirSync(dir)).toEqual(['daemon.pid']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('EPERM');
  });

  // A disk that cannot take the temp file would fail the in-place write too,
  // after truncating a valid file.
  it('replaceFileOrWrite leaves the file untouched when the temp file cannot be written', () => {
    fs.writeFileSync(file('daemon-pipe'), 'old-pipe');
    fsHooks.tempWriteError = 'ENOSPC';
    const warn = vi.fn();
    expect(replaceFileOrWrite(file('daemon-pipe'), 'new-pipe', warn)).toBe(false);
    expect(fsHooks.writes).not.toContain(file('daemon-pipe'));
    expect(read('daemon-pipe')).toBe('old-pipe');
    expect(fs.readdirSync(dir)).toEqual(['daemon-pipe']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('ENOSPC');
  });

  it('createFileExclusive reports a hard-link error other than EEXIST and still creates the file', () => {
    fsHooks.linkError = 'ENOSYS';
    const warn = vi.fn();
    expect(createFileExclusive(file('daemon.pid'), '55', warn)).toBe(true);
    expect(read('daemon.pid')).toBe('55');
    expect(fs.readdirSync(dir)).toEqual(['daemon.pid']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('ENOSYS');
    // EEXIST is the ordinary "already there" answer, not a fallback.
    fsHooks.linkError = 'EEXIST';
    expect(createFileExclusive(file('daemon.pid'), '66', warn)).toBe(false);
    expect(read('daemon.pid')).toBe('55');
    expect(warn).toHaveBeenCalledTimes(1);
    // A fallback that finds the file already there says so with both codes.
    fsHooks.linkError = 'EPERM';
    expect(createFileExclusive(file('daemon.pid'), '77', warn)).toBe(false);
    expect(read('daemon.pid')).toBe('55');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toMatch(/EPERM.*EEXIST/);
  });

  it('a throwing warn sink changes nothing', () => {
    const warn = (): never => { throw new Error('sink down'); };
    fsHooks.linkError = 'ENOSYS';
    expect(createFileExclusive(file('daemon.pid'), '88', warn)).toBe(true);
    expect(read('daemon.pid')).toBe('88');
    fsHooks.renameFailures = Infinity;
    expect(replaceFileOrWrite(file('daemon.pid'), '99', warn)).toBe(true);
    expect(read('daemon.pid')).toBe('99');
    expect(fs.readdirSync(dir)).toEqual(['daemon.pid']);
  });

  it('unlinks a file only while it holds the given content', () => {
    fs.writeFileSync(file('daemon.pid'), '11\n');
    expect(unlinkIfContent(file('daemon.pid'), '22')).toBe(false);
    expect(read('daemon.pid')).toBe('11\n');
    expect(unlinkIfContent(file('daemon.pid'), '11')).toBe(true);
    expect(read('daemon.pid')).toBeNull();
    expect(unlinkIfContent(file('daemon.pid'), '11')).toBe(false);
  });

  // releaseLock(): a daemon that yields to another live daemon must not delete
  // that daemon's files on its way out.
  it('releaseDaemonFiles removes only what this daemon wrote', () => {
    for (const name of ['daemon.pid', 'daemon.lock', 'daemon-booting']) fs.writeFileSync(file(name), '200');
    fs.writeFileSync(file('daemon-pipe'), 'pipe-of-200');

    releaseDaemonFiles(dir, 100, null);
    expect(fs.readdirSync(dir).sort()).toEqual(['daemon-booting', 'daemon-pipe', 'daemon.lock', 'daemon.pid']);
    releaseDaemonFiles(dir, 100, 'pipe-of-100');
    expect(read('daemon-pipe')).toBe('pipe-of-200');

    releaseDaemonFiles(dir, 200, 'pipe-of-200');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
