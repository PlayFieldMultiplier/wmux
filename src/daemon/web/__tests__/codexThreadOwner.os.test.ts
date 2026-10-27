import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { persistCodexThreadOwner } from '../codexThreadOwner';

const tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: rename failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Force a platform for the duration of `fn`, then restore. */
function asPlatform(value: string, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

describe('persistCodexThreadOwner commit-rename retry', () => {
  it('win32: a transient EPERM on the first rename is retried and both files land', () => {
    const codeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-owner-'));
    tmpDirs.push(codeHome);
    const threadId = '0123abcd-0123-4abc-8def-0123456789ab';

    // Fail only the first rename out of a writeAtomic tmp file (`<file>.<pid>.<uuid>.tmp`).
    const real = fs.renameSync.bind(fs);
    let failed = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      if (!failed && String(from).endsWith('.tmp')) {
        failed = true;
        throw errno('EPERM');
      }
      return real(from, to);
    });

    asPlatform('win32', () => {
      persistCodexThreadOwner({ id: 'pty-1', env: {} }, { live: true, selection: { threadId, cwd: codeHome, generation: 1 } }, codeHome, {});
    });

    expect(failed).toBe(true);
    // Two files, one retried: three renames in all.
    expect(spy).toHaveBeenCalledTimes(3);
    const dir = path.join(codeHome, 'wmux-thread-owners');
    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const read = (prefix: string) =>
      JSON.parse(fs.readFileSync(path.join(dir, files.find((f) => f.startsWith(prefix)) ?? prefix), 'utf-8'));
    const thread = read('thread-');
    const owner = read('pane-');
    expect(thread.id).toBe(threadId);
    expect(owner).toEqual({ id: threadId, nonce: thread.nonce });
  });
});
