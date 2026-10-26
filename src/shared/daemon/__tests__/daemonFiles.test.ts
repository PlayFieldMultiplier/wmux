import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFileExclusive, releaseDaemonFiles, replaceFileAtomic, unlinkIfContent } from '../daemonFiles';

describe('daemonFiles', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfiles-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
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
