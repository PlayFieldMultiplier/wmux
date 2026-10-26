import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFileExclusive, releaseDaemonFiles, replaceFileAtomic, replaceFileOrWrite, unlinkIfContent } from '../daemonFiles';

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
  /** Run `fn` as if on `platform`: the rename retry is Windows-only. */
  const asPlatform = (platform: NodeJS.Platform, fn: () => void): void => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try { fn(); } finally { Object.defineProperty(process, 'platform', { value: original, configurable: true }); }
  };

  it('creates a file only once and leaves no temp file behind', () => {
    const warn = vi.fn();
    expect(createFileExclusive(file('daemon.pid'), '11', warn)).toBe(true);
    expect(createFileExclusive(file('daemon.pid'), '22', warn)).toBe(false);
    expect(read('daemon.pid')).toBe('11');
    expect(replaceFileAtomic(file('daemon.pid'), '33', warn)).toBe(true);
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
  it('retries a rename refused while the file is held, on Windows only', () => {
    fs.writeFileSync(file('daemon-pipe'), 'old-pipe');
    const warn = vi.fn();
    asPlatform('win32', () => {
      fsHooks.renameFailures = 2;
      expect(replaceFileOrWrite(file('daemon-pipe'), 'new-pipe', warn)).toBe(true);
    });
    expect(fsHooks.renameFailures).toBe(0);
    expect(fsHooks.writes).not.toContain(file('daemon-pipe'));
    expect(read('daemon-pipe')).toBe('new-pipe');
    expect(warn).not.toHaveBeenCalled();
    // Elsewhere EPERM is permanent: one try, then the caller's policy.
    asPlatform('linux', () => {
      fsHooks.renameFailures = 2;
      expect(replaceFileAtomic(file('daemon-pipe'), 'newer-pipe', warn)).toBe(false);
    });
    expect(fsHooks.renameFailures).toBe(1);
    expect(read('daemon-pipe')).toBe('new-pipe');
    expect(fs.readdirSync(dir)).toEqual(['daemon-pipe']);
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

  // The launcher's marker and its live-owner pid repair: never readable empty.
  it('replaceFileAtomic never writes in place', () => {
    fs.writeFileSync(file('daemon-booting'), '1');
    const warn = vi.fn();
    asPlatform('win32', () => {
      fsHooks.renameFailures = Infinity;
      expect(replaceFileAtomic(file('daemon-booting'), '2', warn)).toBe(false);
    });
    fsHooks.renameFailures = 0;
    fsHooks.tempWriteError = 'ENOSPC';
    expect(replaceFileAtomic(file('daemon-booting'), '3', warn)).toBe(false);
    expect(fsHooks.writes).not.toContain(file('daemon-booting'));
    expect(read('daemon-booting')).toBe('1');
    expect(fs.readdirSync(dir)).toEqual(['daemon-booting']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('EPERM');
    expect(warn.mock.calls[1][0]).toContain('ENOSPC');
  });

  // The daemon's own files: stale or missing content is worse than a moment
  // of an empty file, so any failure falls back to the plain write.
  it('replaceFileOrWrite writes in place after a temp-file failure', () => {
    fs.writeFileSync(file('daemon-pipe'), 'stale-pipe');
    fsHooks.tempWriteError = 'EMFILE';
    const warn = vi.fn();
    expect(replaceFileOrWrite(file('daemon-pipe'), 'new-pipe', warn)).toBe(true);
    expect(read('daemon-pipe')).toBe('new-pipe');
    expect(fs.readdirSync(dir)).toEqual(['daemon-pipe']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('EMFILE');
  });

  // The launcher already wrote the spawned daemon's pid: nothing to rewrite.
  it('replaceFileOrWrite keeps a file that already holds the content', () => {
    fs.writeFileSync(file('daemon.pid'), '500');
    fsHooks.tempWriteError = 'ENOSPC';
    fsHooks.writes = [];
    const warn = vi.fn();
    expect(replaceFileOrWrite(file('daemon.pid'), '500', warn)).toBe(true);
    fsHooks.tempWriteError = null;
    fsHooks.renameFailures = 1;
    expect(replaceFileOrWrite(file('daemon.pid'), '500', warn)).toBe(true);
    expect(fsHooks.writes).not.toContain(file('daemon.pid'));
    expect(read('daemon.pid')).toBe('500');
    expect(fs.readdirSync(dir)).toEqual(['daemon.pid']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('ENOSPC');
    expect(warn.mock.calls[1][0]).toContain('EPERM');
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
    // Without hard links the plain write meets EEXIST in any concurrent start:
    // not worth a warning.
    fsHooks.linkError = 'EPERM';
    expect(createFileExclusive(file('daemon.pid'), '77', warn)).toBe(false);
    expect(read('daemon.pid')).toBe('55');
    expect(warn).toHaveBeenCalledTimes(1);
    // Any other failure of the plain write is reported with both codes.
    fsHooks.tempWriteError = 'EIO';
    expect(createFileExclusive(path.join(dir, 'missing', 'daemon.pid'), '88', warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toMatch(/EIO.*ENOENT/);
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
