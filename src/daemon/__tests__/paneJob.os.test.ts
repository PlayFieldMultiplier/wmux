// #2398 — the real kill-on-close job on Windows. A stand-in daemon (a child
// node process) joins its pane job and then dies without a clean shutdown:
// everything it started, and everything those started, must die with it. With
// the clean exit's disarm first, it must survive, as a program started from a
// pane survives a normal quit. The per-pane fallback (a daemon that could not
// join) is driven too, and must never take a pid the stand-in did not spawn.
// The test kills only the processes it started, by pid and creation time.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadJobNative } from '../paneJob';

const isWindows = process.platform === 'win32';

// The stand-in runs plain node, so it loads paneJob.ts bundled to CommonJS,
// koffi resolved from the repo's node_modules.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pane-job-'));
const compiled = path.join(tmp, 'paneJob.js');
buildSync({
  entryPoints: [path.join(__dirname, '..', 'paneJob.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['koffi'],
  outfile: compiled,
  logLevel: 'silent',
});
const koffiEntry = require.resolve('koffi');
const nodeModules = koffiEntry.slice(0, koffiEntry.lastIndexOf(`node_modules${path.sep}`) + 'node_modules'.length);

interface Kernel32 {
  OpenProcess(access: number, inherit: number, pid: number): bigint;
  GetProcessTimes(handle: bigint, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer): number;
  GetExitCodeProcess(handle: bigint, code: Buffer): number;
  TerminateProcess(handle: bigint, code: number): number;
  GetHandleInformation(handle: bigint, flags: Buffer): number;
  CloseHandle(handle: bigint): number;
}

const k: Kernel32 | null = (() => {
  if (!isWindows) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi') as { load(name: string): { func(name: string, result: string, args: string[]): unknown } };
  const kernel32 = koffi.load('kernel32.dll');
  return {
    OpenProcess: kernel32.func('OpenProcess', 'int64', ['uint32', 'int', 'uint32']),
    GetProcessTimes: kernel32.func('GetProcessTimes', 'int', ['int64', 'void *', 'void *', 'void *', 'void *']),
    GetExitCodeProcess: kernel32.func('GetExitCodeProcess', 'int', ['int64', 'void *']),
    TerminateProcess: kernel32.func('TerminateProcess', 'int', ['int64', 'uint32']),
    GetHandleInformation: kernel32.func('GetHandleInformation', 'int', ['int64', 'void *']),
    CloseHandle: kernel32.func('CloseHandle', 'int', ['int64']),
  } as Kernel32;
})();

/** PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION. */
const PROBE_ACCESS = 0x0001 | 0x1000;
const STILL_ACTIVE = 259;

/** Runs `use` on a handle to `pid`, or returns null when it cannot be opened (gone). */
function withProcess<T>(pid: number, use: (handle: bigint) => T): T | null {
  const handle = BigInt(k!.OpenProcess(PROBE_ACCESS, 0, pid));
  if (handle === 0n) return null;
  try {
    return use(handle);
  } finally {
    k!.CloseHandle(handle);
  }
}

function createdAt(handle: bigint): bigint {
  const creation = Buffer.alloc(8);
  k!.GetProcessTimes(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8));
  return creation.readBigUInt64LE(0);
}

function running(handle: bigint): boolean {
  const code = Buffer.alloc(4);
  return k!.GetExitCodeProcess(handle, code) !== 0 && code.readUInt32LE(0) === STILL_ACTIVE;
}

/** Every process this test started, with the creation time it had when the test learned its pid. */
const started: Array<{ pid: number; createdAt: bigint }> = [];

function track(pid: number): void {
  const created = withProcess(pid, (h) => (running(h) ? createdAt(h) : null));
  if (created !== null) started.push({ pid, createdAt: created });
}

/** True while `pid` still names the process this test started under it. */
function alive(pid: number): boolean {
  const mine = started.find((p) => p.pid === pid);
  return withProcess(pid, (h) => running(h) && (!mine || createdAt(h) === mine.createdAt)) ?? false;
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

function startPing(): number {
  const child = spawn('ping', ['-n', '300', '127.0.0.1'], { stdio: 'ignore', detached: true });
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error('ping did not start');
  track(pid);
  return pid;
}

interface StandInOptions {
  /** Join the job first, the daemon's startup path. Off: the per-pane fallback. */
  enter?: boolean;
  /** Disarm before exiting, as a clean exit does. */
  disarm?: boolean;
  /** Contain this pid instead of one the stand-in spawns. */
  stranger?: number;
  /** Spawn a shell through node-pty's ConPTY instead of a plain child. */
  pty?: boolean;
  /**
   * Spawn a child that starts a grandchild at once, and contain the child only
   * after the grandchild exists: the moment between node-pty's CreateProcess
   * and the daemon's contain().
   */
  grandchild?: boolean;
  /** Stay alive after containing, to be killed by the test. */
  stay?: boolean;
  /** The Rust pane backend's move: a child of the joined daemon put in a job of its own. */
  nested?: boolean;
}

/**
 * Runs a stand-in daemon. Resolves with the pids it reports (the process it
 * contained, and a grandchild when asked for one) and a kill() for a stand-in
 * told to stay; otherwise once it has exited.
 */
function runStandIn(opts: StandInOptions = {}): Promise<{ pids: number[]; kill(): Promise<void> }> {
  const expectContained = opts.stranger ? 0 : 1;
  const script = `(async () => {
    const { createPaneJob } = require(${JSON.stringify(compiled)});
    const { spawn } = require('node:child_process');
    const job = createPaneJob({ log: (level, m) => console.error(level, m) });
    if (${opts.enter ? 'true' : 'false'}) {
      job.enter();
      if (job.stats().mode !== 'inherit') { console.error('mode ' + job.stats().mode); process.exit(3); }
    }
    const mark = job.spawnMark();
    let pid = ${opts.stranger ?? 0};
    const report = [];
    if (${opts.pty ? 'true' : 'false'}) {
      // A pane shell as the daemon spawns it. node-pty 1.2.0-beta reports
      // the pid once the ConPTY output pipe connects.
      const shell = require('node-pty').spawn('cmd.exe', [], { useConpty: true, cols: 80, rows: 24 });
      const deadline = Date.now() + 10000;
      while (!shell.pid && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      pid = shell.pid;
    } else if (${opts.grandchild ? 'true' : 'false'}) {
      // The child starts its own child and reports it; only then is it contained.
      const child = spawn(process.execPath, ['-e',
        "const c = require('node:child_process').spawn('ping', ['-n', '300', '127.0.0.1'], { stdio: 'ignore', detached: true });" +
        "c.unref(); process.stdout.write(String(c.pid)); setTimeout(() => {}, 300000);"],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      pid = child.pid;
      const grandchild = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d)))));
      report.push(grandchild);
    } else if (!pid) {
      const child = spawn('ping', ['-n', '300', '127.0.0.1'], { stdio: 'ignore', detached: true });
      child.unref();
      pid = child.pid;
    }
    if (${opts.nested ? 'true' : 'false'}) {
      const koffi = require('koffi');
      const k = koffi.load('kernel32.dll');
      const create = k.func('CreateJobObjectW', 'int64', ['void *', 'void *']);
      const limits = k.func('SetInformationJobObject', 'int', ['int64', 'int', 'void *', 'uint32']);
      const open = k.func('OpenProcess', 'int64', ['uint32', 'int', 'uint32']);
      const assign = k.func('AssignProcessToJobObject', 'int', ['int64', 'int64']);
      const inner = BigInt(create(null, null));
      const info = Buffer.alloc(144);
      info.writeUInt32LE(0x2000, 16);
      if (!limits(inner, 9, info, 144) || !assign(inner, BigInt(open(0x0100 | 0x0001, 0, pid)))) process.exit(4);
    }
    process.stdout.write([pid, ...report].join(' ') + '\\n');
    job.contain(pid, mark);
    const { contained, failed } = job.stats();
    if (contained !== ${expectContained} || failed !== ${opts.stranger ? 1 : 0}) {
      console.error('contained ' + contained + ', failed ' + failed);
      process.exit(2);
    }
    ${opts.disarm ? 'job.disarm();' : ''}
    // No clean shutdown: the process ends and its job handle closes with it.
    if (${opts.stay ? 'true' : 'false'}) { process.stdout.write('ready\\n'); setTimeout(() => {}, 300000); }
    else process.exit(0);
  })();`;
  return new Promise((resolve, reject) => {
    const standIn = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_PATH: nodeModules },
    });
    if (standIn.pid) track(standIn.pid);
    let out = '';
    let err = '';
    let settled = false;
    const pids = (): number[] => out.split('\n')[0].trim().split(' ').map(Number).filter((n) => n > 0);
    const exited = new Promise<void>((done) => standIn.on('exit', () => done()));
    const kill = async (): Promise<void> => {
      // A force kill, as Task Manager or a crash ends the daemon.
      withProcess(standIn.pid!, (h) => k!.TerminateProcess(h, 1));
      await exited;
    };
    standIn.stdout.on('data', (d) => {
      out += d;
      if (opts.stay && !settled && out.includes('ready\n')) {
        settled = true;
        pids().forEach(track);
        resolve({ pids: pids(), kill });
      }
    });
    standIn.stderr.on('data', (d) => { err += d; });
    standIn.on('exit', (code) => {
      if (settled) return;
      settled = true;
      pids().forEach(track);
      if (code !== 0 || pids().length === 0) reject(new Error(`stand-in exited ${code}: ${err}`));
      else resolve({ pids: pids(), kill });
    });
  });
}

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

afterEach(() => {
  for (const { pid, createdAt: created } of started.splice(0)) {
    withProcess(pid, (h) => {
      if (running(h) && createdAt(h) === created) k!.TerminateProcess(h, 1);
    });
  }
});

describe.runIf(isWindows)('pane job on Windows', () => {
  it('makes a job handle no child can inherit', () => {
    // An inherited handle would hold the job open after the daemon died, and
    // kill-on-close would never fire. CreateJobObjectW(NULL, NULL) is not
    // inheritable; HANDLE_FLAG_INHERIT is bit 0.
    const native = loadJobNative(() => undefined)!;
    const made = native.createJob();
    if ('error' in made) throw new Error(`createJob error ${made.error}`);
    try {
      const flags = Buffer.alloc(4);
      expect(k!.GetHandleInformation(made.job, flags)).not.toBe(0);
      expect(flags.readUInt32LE(0) & 0x1).toBe(0);
    } finally {
      native.close(made.job);
    }
  });

  it('ends a grandchild started before any contain when the joined daemon is killed', async () => {
    // The child starts the grandchild before contain() runs. Assigned after
    // the spawn, the child would be in the job and the grandchild not.
    const standIn = await runStandIn({ enter: true, grandchild: true, stay: true });
    const [child, grandchild] = standIn.pids;
    expect(alive(grandchild)).toBe(true);
    await standIn.kill();
    expect(await waitGone(child, 5000)).toBe(true);
    expect(await waitGone(grandchild, 5000)).toBe(true);
  }, 30_000);

  it('keeps that grandchild when the joined daemon disarmed for a clean exit', async () => {
    const standIn = await runStandIn({ enter: true, grandchild: true, disarm: true, stay: true });
    const [, grandchild] = standIn.pids;
    await standIn.kill();
    expect(await waitGone(grandchild, 1500)).toBe(false);
  }, 30_000);

  it('lets a pane backend put a shell of the joined daemon in a job of its own', async () => {
    // The Rust core assigns each pane to its own kill-on-close job (nesting,
    // Windows 8+): a refusal there would fail every Rust pane's spawn.
    const { pids: [pid] } = await runStandIn({ enter: true, nested: true });
    expect(await waitGone(pid, 5000)).toBe(true);
  }, 30_000);

  it('contains a shell spawned through ConPTY when the daemon is in the job', async () => {
    const { pids: [pid] } = await runStandIn({ enter: true, pty: true });
    expect(await waitGone(pid, 5000)).toBe(true);
  }, 30_000);

  describe('per pane, when the daemon could not join', () => {
    it('ends a contained process when the daemon dies without a clean shutdown', async () => {
      const { pids: [pid] } = await runStandIn();
      expect(await waitGone(pid, 5000)).toBe(true);
    }, 30_000);

    it('keeps a contained process when the job was disarmed for a clean exit', async () => {
      const { pids: [pid] } = await runStandIn({ disarm: true });
      expect(await waitGone(pid, 1500)).toBe(false);
    }, 30_000);

    it('contains a shell spawned through ConPTY: its parent is the daemon, not conhost', async () => {
      const { pids: [pid] } = await runStandIn({ pty: true });
      expect(await waitGone(pid, 5000)).toBe(true);
    }, 30_000);

    it('never takes a pid the daemon did not spawn, so it outlives the daemon', async () => {
      // What a reused pid looks like: a live process of the same user, not a
      // child of the daemon. Opening it by pid alone would succeed.
      const stranger = startPing();
      await runStandIn({ stranger });
      expect(await waitGone(stranger, 1500)).toBe(false);
    }, 30_000);

    it('leaves a grandchild started before contain outside the job', async () => {
      // Why the daemon joins the job instead: assigned after the spawn, the
      // child is contained and its grandchild is not.
      const standIn = await runStandIn({ grandchild: true, stay: true });
      const [child, grandchild] = standIn.pids;
      await standIn.kill();
      expect(await waitGone(child, 5000)).toBe(true);
      expect(await waitGone(grandchild, 1500)).toBe(false);
    }, 30_000);
  });
});
