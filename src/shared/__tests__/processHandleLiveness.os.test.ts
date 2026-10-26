import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readSourceText, blockAt } from '../../test-utils/sourceText';

const native = vi.hoisted(() => ({ state: 'running' as 'exited' | 'running' | 'unknown', reads: 0 }));
vi.mock('../../main/pty/winSnapshotNative', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../main/pty/winSnapshotNative')>()),
  readProcessExitState: () => {
    native.reads++;
    return native.state;
  },
}));

import { handleLiveness } from '../processHandleLiveness';

// #2774: the launcher and the daemon's lock ask the process handle before
// tasklist, which can still list a terminated process while its last
// handles close.
describe('handleLiveness', () => {
  it.runIf(process.platform === 'win32')('maps the handle: exited is dead, running is alive, unreadable leaves it to tasklist', () => {
    native.state = 'exited';
    expect(handleLiveness(4242)).toBe('dead');
    native.state = 'running';
    expect(handleLiveness(4242)).toBe('alive');
    native.state = 'unknown';
    expect(handleLiveness(4242)).toBe('unknown');
  });

  it.skipIf(process.platform === 'win32')('is unknown off Windows without asking for a handle', () => {
    native.reads = 0;
    native.state = 'exited';
    expect(handleLiveness(4242)).toBe('unknown');
    expect(native.reads).toBe(0);
  });

  it('the daemon\'s lock check asks it before tasklist', () => {
    const src = readSourceText(path.join(__dirname, '..', '..', 'daemon', 'index.ts'));
    const body = blockAt(src, src.indexOf('async function processLiveness('));
    const handle = body.indexOf('handleLiveness(pid)');
    expect(handle).toBeGreaterThan(-1);
    expect(handle).toBeLessThan(body.indexOf('tasklist.exe'));
  });
});

describe.runIf(process.platform === 'win32')('readProcessExitState — a real child', () => {
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    }
    child = null;
  });

  it('reads a running process as running, and a terminated one a handle still holds as exited', async () => {
    const real = await vi.importActual<typeof import('../../main/pty/winSnapshotNative')>('../../main/pty/winSnapshotNative');
    const api = real.tryProcessHandleApi();
    expect(api).not.toBeNull();
    if (!api) return;
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid as number;
    expect(real.readProcessExitState(pid)).toBe('running');
    // Hold the process object, as a slow-closing handle does after a kill.
    const held = api.open(pid);
    expect('handle' in held).toBe(true);
    if (!('handle' in held)) return;
    try {
      const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
      expect(real.readProcessExitState(pid)).toBe('exited');
    } finally {
      api.close(held.handle);
    }
    expect(real.readProcessExitState(0)).toBe('unknown');
  });
});
