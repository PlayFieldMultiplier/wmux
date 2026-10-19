import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// #2388: a pane whose shell start time the spawn's read left empty (`ps`
// timed out) could never have its tree killed: the read was never taken
// again, so every later tree kill was refused. The tree kill reads it once
// more, while the pane's PTY child has not exited.
const spawned: FakePty[] = [];
class FakePty extends EventEmitter {
  pid = 0;
  readonly _socket = new EventEmitter();
  readonly kill = vi.fn();
  onData() { return { dispose: () => { /* noop */ } }; }
  onExit(listener: (e: { exitCode: number }) => void) {
    this.on('exit', listener);
    return { dispose: () => { this.off('exit', listener); } };
  }
  write(): void { /* noop */ }
  resize(): void { /* noop */ }
  connect(pid: number): void { this.pid = pid; this._socket.emit('ready_datapipe'); }
}

vi.mock('node-pty', () => {
  const spawn = () => { const p = new FakePty(); spawned.push(p); return p; };
  return { default: { spawn }, spawn };
});

/** What the next start-time reads answer (null: the read failed). */
const startReads: Array<string | null> = [];
const readPids: number[] = [];
let readGate: Promise<void> | null = null;
vi.mock('../phantomExit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../phantomExit')>()),
  // The spawn's native read (Windows) found nothing either.
  getProcessCreatedAtFt: () => null,
  getProcessStartTime: async (pid: number) => {
    readPids.push(pid);
    const value = startReads.length > 0 ? startReads.shift() ?? null : null;
    if (readGate) await readGate;
    return value;
  },
}));

import { DaemonSessionManager } from '../DaemonSessionManager';
import { captureTreePosix, matchesRecordedStart, recordedStartOf, treeKillRefusal, type PosixProcRow } from '../automation/verifiedTreeKill';

const flush = () => new Promise<void>((r) => setImmediate(r));
// The form a read takes on this platform (Windows: a FILETIME).
const START = process.platform === 'win32' ? '134296036801234567' : 'Mon Oct 19 10:00:00 2026';

describe('recordShellIdentity (#2388)', () => {
  let manager: DaemonSessionManager;

  beforeEach(async () => {
    spawned.length = 0;
    startReads.length = 0;
    readPids.length = 0;
    readGate = null;
    manager = new DaemonSessionManager();
    const pending = manager.createSessionAsync({ id: 's', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    spawned[0].connect(4242);
    await pending;
    await flush();
    readPids.length = 0;
  });

  afterEach(() => manager.disposeAll());

  it('reads a start time the spawn left empty, and the tree kill then confirms and kills the tree', async () => {
    const meta = manager.getSession('s')!.meta;
    expect(treeKillRefusal(meta)).not.toBeNull();
    startReads.push(START);
    expect(await manager.recordShellIdentity('s')).toBe(true);
    expect(readPids).toEqual([4242]);
    expect(recordedStartOf(meta)).toBe(START);
    expect(treeKillRefusal(meta)).toBeNull();
    // The capture now confirms the pid leads to the shell.
    const rows: PosixProcRow[] = [{ pid: 1, ppid: 0, stat: 'S', start: 'x' }, { pid: 4242, ppid: 1, stat: 'S', start: START }, { pid: 4243, ppid: 4242, stat: 'S', start: 'y' }];
    const tree = await captureTreePosix(4242, {
      listProcesses: async () => rows.map((r) => ({ ...r })),
      signal: (pid, sig) => {
        if (sig !== 'SIGKILL' || pid < 0) return;
        const r = rows.find((x) => x.pid === pid);
        if (r) r.stat = 'Z';
      },
    }, { sleep: async () => undefined, rootIsOurs: (start) => matchesRecordedStart(recordedStartOf(meta), start) });
    expect(await tree!.kill({ timeoutMs: 0 })).toEqual({ ok: true, killed: [4242, 4243] });
  });

  it('a read that fails records nothing, and the session is left as it was', async () => {
    startReads.push(null);
    expect(await manager.recordShellIdentity('s')).toBe(false);
    const managed = manager.getSession('s')!;
    expect(managed.meta.state === 'attached' || managed.meta.state === 'detached').toBe(true);
    expect(recordedStartOf(managed.meta)).toBeUndefined();
    expect(treeKillRefusal(managed.meta)).not.toBeNull();
    expect(spawned[0].kill).not.toHaveBeenCalled();
  });

  it('never reads the identity of a pane whose shell exited', async () => {
    spawned[0].emit('exit', { exitCode: 0 });
    await flush();
    startReads.push(START);
    expect(await manager.recordShellIdentity('s')).toBe(false);
    expect(readPids).toEqual([]);
    expect(recordedStartOf(manager.getSession('s')!.meta)).toBeUndefined();
  });

  it('records nothing when the shell exits while its start time is read', async () => {
    let open: () => void = () => undefined;
    readGate = new Promise<void>((r) => { open = r; });
    startReads.push(START);
    const reading = manager.recordShellIdentity('s');
    await flush();
    spawned[0].emit('exit', { exitCode: 0 });
    open();
    expect(await reading).toBe(false);
    expect(recordedStartOf(manager.getSession('s')!.meta)).toBeUndefined();
  });

  it('the daemon reads it before it decides to refuse a tree kill', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/daemon/index.ts'), 'utf8');
    const start = src.indexOf('const destroySessionNow = async');
    const reprobe = src.indexOf('await sessionManager.recordShellIdentity(p.id)', start);
    expect(reprobe).toBeGreaterThan(start);
    expect(reprobe).toBeLessThan(src.indexOf('treeKillRefusal(meta)', start));
  });
});
