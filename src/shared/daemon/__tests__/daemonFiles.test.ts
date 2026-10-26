import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFileExclusive, releaseDaemonFiles, replaceFileAtomic, replaceFileOrWrite, unlinkIfContent } from '../daemonFiles';

// daemonFiles reaches fs through a namespace import, which vi.spyOn cannot
// patch: wrap the calls it makes instead. The test's own `fs` is the real one.
const fsHooks = vi.hoisted(() => ({
  linkError: null as string | null,
  renameError: null as string | null,
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
    renameSync: (...args: Parameters<typeof actual.renameSync>) =>
      fsHooks.renameError ? fail(fsHooks.renameError) : actual.renameSync(...args),
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      fsHooks.writes.push(String(args[0]));
      return actual.writeFileSync(...args);
    },
  };
});

describe('daemonFiles', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfiles-')); });
  afterEach(() => {
    Object.assign(fsHooks, { linkError: null, renameError: null, writes: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = (name: string): string => path.join(dir, name);
  const read = (name: string): string | null => {
    try { return fs.readFileSync(file(name), 'utf8'); } catch { return null; }
  };

  it('creates a file only once and leaves no temp file behind', () => {
    expect(createFileExclusive(file('daemon.pid'), '11')).toBe(true);
    expect(createFileExclusive(file('daemon.pid'), '22')).toBe(false);
    expect(read('daemon.pid')).toBe('11');
    expect(replaceFileAtomic(file('daemon.pid'), '33')).toBe(true);
    expect(read('daemon.pid')).toBe('33');
    expect(fs.readdirSync(dir)).toEqual(['daemon.pid']);
  });

  // daemon-pipe, daemon.pid and daemon-booting are replaced while other
  // processes read them: the target itself is never opened for writing.
  it('replaceFileOrWrite renames into place and never writes the target directly', () => {
    fs.writeFileSync(file('daemon-pipe'), 'old-pipe');
    const warn = vi.fn();
    replaceFileOrWrite(file('daemon-pipe'), 'new-pipe', warn);
    expect(fsHooks.writes.length).toBeGreaterThan(0);
    expect(fsHooks.writes).not.toContain(file('daemon-pipe'));
    expect(read('daemon-pipe')).toBe('new-pipe');
    expect(fs.readdirSync(dir)).toEqual(['daemon-pipe']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('replaceFileOrWrite reports a failed rename before writing in place', () => {
    fsHooks.renameError = 'EPERM';
    const warn = vi.fn();
    replaceFileOrWrite(file('daemon.pid'), '44', warn);
    expect(read('daemon.pid')).toBe('44');
    expect(fs.readdirSync(dir)).toEqual(['daemon.pid']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('EPERM');
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
