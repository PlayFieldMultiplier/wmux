import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * #2774: a start that runs while the recorded daemon is still exiting saw it
 * alive, then failed to read its image (no longer listed), and took branch
 * (c), "alive but unverifiable": the CLI refused and the app asked the user.
 * An exited process is a dead daemon; only a process that is still running
 * and cannot be read is case (c).
 *
 * The probes are faked for FAKE_PID, so the exit can be placed at any step.
 * Liveness is read the way each platform reads it: the process handle on
 * Windows (tasklist when the handle cannot be read), `process.kill(pid, 0)`
 * elsewhere. The image lookup is tasklist / /proc comm / ps comm=, the
 * command-line lookup CIM / /proc cmdline / ps command=.
 */
const FAKE_PID = 424242;

const probes = vi.hoisted(() => ({
  /** The process has finished exiting: liveness reads dead and the lookups no longer find it. */
  exited: false,
  /** Liveness reads (FAKE_PID only) before the process exits; -1 never. */
  exitAfterReads: -1,
  reads: 0,
  /** Whether the native handle read works (Windows). */
  handleApi: true,
  /** Image the lookup returns while running; null = the probe is blocked. */
  image: 'node.exe' as string | null,
  imageReads: 0,
  /** Command line the lookup returns while running; null = the probe is blocked. */
  argv: null as string | null,
  /** The process finishes exiting during the next image / command-line lookup. */
  exitDuring: null as 'image' | 'argv' | null,
  /** tasklist still lists the process after its handle is signaled. */
  listedAfterExit: false,
}));

/** One liveness read of FAKE_PID: whether it has exited by now. */
function livenessRead(): boolean {
  if (probes.exitAfterReads >= 0 && probes.reads >= probes.exitAfterReads) probes.exited = true;
  probes.reads++;
  return probes.exited;
}

// As in production, the handle is read on Windows only.
vi.mock('../../../main/pty/winSnapshotNative', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../main/pty/winSnapshotNative')>()),
  readProcessExitState: (pid: number) => {
    if (process.platform !== 'win32' || !probes.handleApi) return 'unknown';
    if (pid !== FAKE_PID) return 'exited';
    return livenessRead() ? 'exited' : 'running';
  },
}));

/** The image lookup's answer; null when the process is gone, throws when blocked. */
function readImage(): string | null {
  probes.imageReads++;
  if (probes.exitDuring === 'image') {
    probes.exitDuring = null;
    probes.exited = true;
  }
  if (probes.exited && !probes.listedAfterExit) return null;
  if (probes.image === null) throw new Error('Process image lookup unavailable');
  return probes.image;
}

function readArgv(): string | null {
  if (probes.exitDuring === 'argv') {
    probes.exitDuring = null;
    probes.exited = true;
  }
  if (probes.exited) return null;
  if (probes.argv === null) throw new Error('Process command-line lookup unavailable');
  return probes.argv;
}

const notFound = (): never => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFileSync = vi.fn((command: string, args: string[], ...rest: unknown[]) => {
    const forFake = Array.isArray(args)
      && (args.includes(`PID eq ${FAKE_PID}`) || args.includes(String(FAKE_PID)) || args.some((a) => a.includes(`ProcessId=${FAKE_PID}`)));
    if (!forFake) return Reflect.apply(actual.execFileSync, actual, [command, args, ...rest]);
    if (command.endsWith('tasklist.exe')) {
      const image = readImage();
      return image === null ? 'INFO: No tasks are running which match the specified criteria.\r\n' : `"${image}","${FAKE_PID}","Console","1","1 K"\r\n`;
    }
    if (args.includes('comm=')) return readImage() ?? notFound();
    return readArgv() ?? '';
  });
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const readFileSync = vi.fn((file: unknown, ...args: unknown[]) => {
    if (file === `/proc/${FAKE_PID}/comm`) return readImage() ?? notFound();
    if (file === `/proc/${FAKE_PID}/cmdline`) return readArgv() ?? notFound();
    return Reflect.apply(actual.readFileSync, actual, [file, ...args]);
  });
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

import { checkProcessLiveness, ensureDaemon, type DaemonLauncherDeps } from '../daemonLauncherCore';

// The command line each platform's probe returns: NUL-separated /proc cmdline
// on Linux, the quoted CIM string on Windows, the `ps -o command=` line on macOS.
function argvLine(script: string): string {
  if (process.platform === 'linux') return `${process.execPath}\0${script}\0`;
  if (process.platform === 'win32') return `"${process.execPath}" ${script}`;
  return `${process.execPath} ${script}`;
}

describe('ensureDaemon — a recorded daemon that exits during the start (#2774)', () => {
  let wmuxDir: string;
  let pidFile: string;
  let prevSuffix: string | undefined;
  let logs: string[];
  let askUser: ReturnType<typeof vi.fn<DaemonLauncherDeps['askUserToRecoverFromStalePid']>>;

  beforeEach(() => {
    Object.assign(probes, {
      exited: false, exitAfterReads: -1, reads: 0, handleApi: true,
      image: 'node.exe', imageReads: 0, argv: null, exitDuring: null, listedAfterExit: false,
    });
    const suffix = `-exited-pid-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    prevSuffix = process.env.WMUX_DATA_SUFFIX;
    process.env.WMUX_DATA_SUFFIX = suffix;
    wmuxDir = path.join(os.homedir(), `.wmux${suffix}`);
    fs.mkdirSync(wmuxDir, { recursive: true });
    pidFile = path.join(wmuxDir, 'daemon.pid');
    fs.writeFileSync(pidFile, String(FAKE_PID));
    logs = [];
    askUser = vi.fn<DaemonLauncherDeps['askUserToRecoverFromStalePid']>(async () => false);
    // POSIX liveness is `kill(pid, 0)`. Nothing real is signalled.
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (pid !== FAKE_PID) return realKill(pid, signal);
      if (livenessRead()) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = prevSuffix;
    fs.rmSync(wmuxDir, { recursive: true, force: true });
  });

  function deps(): DaemonLauncherDeps {
    return {
      // Missing on disk: reaching the spawn fails with "Daemon script not
      // found", which proves the stale cleanup ran instead of a refusal.
      resolveDaemonScriptCandidates: () => [path.join(wmuxDir, 'missing', 'index.js')],
      resolveSpawnedByVersion: () => '9.9.9-test',
      askUserToRecoverFromStalePid: askUser,
      isElectronHost: () => false,
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' ')),
    };
  }

  async function startError(): Promise<string> {
    try {
      await ensureDaemon(deps());
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return '';
  }

  const exitedLine = (): string | undefined => logs.find((line) => line.includes('names a process that has exited'));

  function expectCleanedUp(err: string): void {
    expect(err).toMatch(/Daemon script not found/);
    expect(askUser).not.toHaveBeenCalled();
    expect(exitedLine()).toBeDefined();
    expect(fs.existsSync(pidFile)).toBe(false);
  }

  it('cleans up and spawns when the daemon exits after the liveness check, without reading its image', async () => {
    probes.exitAfterReads = 1;
    expectCleanedUp(await startError());
    expect(probes.imageReads).toBe(0);
  });

  it('cleans up and spawns when the daemon exits during the image lookup', async () => {
    probes.exitDuring = 'image';
    expectCleanedUp(await startError());
  });

  it('cleans up and spawns when the daemon exits during the command-line lookup', async () => {
    probes.image = path.basename(process.execPath);
    probes.exitDuring = 'argv';
    expectCleanedUp(await startError());
  });

  // Reads: the liveness check, the one before the identity checks, the one
  // after the null lookup; the next one, before the dialog, sees it gone.
  it('cleans up instead of asking when a daemon whose image lookup is blocked exits before the dialog', async () => {
    probes.image = null;
    probes.exitAfterReads = 3;
    expectCleanedUp(await startError());
  });

  it('cleans up instead of asking when a daemon whose command-line lookup is blocked exits before the dialog', async () => {
    probes.image = path.basename(process.execPath);
    probes.exitAfterReads = 3;
    expectCleanedUp(await startError());
  });

  it('cleans up instead of asking when a daemon whose command line does not match exits before the dialog', async () => {
    probes.image = path.basename(process.execPath);
    probes.argv = argvLine('/test/someone-elses-app/index.js');
    probes.exitAfterReads = 2;
    expectCleanedUp(await startError());
  });

  it('still asks, then refuses, when a running process blocks the image lookup', async () => {
    probes.image = null;
    expect(await startError()).toMatch(/alive but image lookup failed; refusing/);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(askUser.mock.calls[0][0].reason).toMatch(/image lookup for PID 424242 failed/);
    expect(exitedLine()).toBeUndefined();
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it('still asks, then refuses, when the handle cannot be read and the image lookup is blocked', async () => {
    probes.handleApi = false;
    probes.image = null;
    expect(await startError()).toMatch(/image lookup failed; refusing/);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it('judges a reused pid by the existing identity checks while it runs', async () => {
    probes.image = 'some-other-app.exe';
    probes.argv = argvLine('/test/someone-elses-app/index.js');
    expect(await startError()).toMatch(/command line does not identify the wmux daemon script; refusing/);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(askUser.mock.calls[0][0].reason).toMatch(/does not identify the wmux daemon script/);
    expect(exitedLine()).toBeUndefined();
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('reads liveness from the handle before tasklist on Windows', () => {
    // tasklist still lists it, but its handle is signaled.
    probes.exited = true;
    probes.listedAfterExit = true;
    expect(checkProcessLiveness(FAKE_PID)).toBe('dead');
    expect(probes.imageReads).toBe(0);
    // An unreadable handle leaves the answer to tasklist.
    probes.handleApi = false;
    expect(checkProcessLiveness(FAKE_PID)).toBe('alive');
  });
});
