import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

/**
 * POSIX concurrent-start races. Two starters (app ensureDaemon, respawn,
 * `wmux daemon start`) used to overlap: the second one's stale-file cleanup
 * deleted the first daemon's live daemon.lock/daemon.pid, its own daemon took
 * the lock and rebound the socket, and the first daemon kept its sessions with
 * nobody able to reach it. The readiness ping also accepted an answer from any
 * daemon and reported the spawned (exiting) pid as the live one.
 *
 * The fake daemon below does what the real one does at boot, in order: take
 * daemon.lock with O_EXCL (refuse a live owner), write daemon.pid and the
 * daemon-booting marker, unlink and rebind the socket, write the daemon-pipe
 * hint, drop the marker, answer daemon.ping with pid. FAKE_WMUX_BOOT_MS is the
 * time before it takes the lock (the real daemon's bundle load).
 */
const FAKE_DAEMON = `
const fs = require('fs'), net = require('net'), path = require('path');
const dir = process.env.FAKE_WMUX_DIR, sock = process.env.FAKE_WMUX_SOCK;
const lock = path.join(dir, 'daemon.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function take() {
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = parseInt(fs.readFileSync(lock, 'utf8'), 10);
    if (owner > 0 && alive(owner)) return false;
    fs.unlinkSync(lock);
    return take();
  }
}
setTimeout(() => {
  if (!take()) process.exit(1);
  fs.writeFileSync(path.join(dir, 'daemon.pid'), String(process.pid));
  fs.writeFileSync(path.join(dir, 'daemon-booting'), String(process.pid));
  try { if (fs.lstatSync(sock).isSocket()) fs.unlinkSync(sock); } catch {}
  net.createServer((s) => {
    s.on('data', (d) => {
      const id = JSON.parse(String(d).split('\\n')[0]).id;
      s.write(JSON.stringify({ id, ok: true, result: { status: 'ok', pid: process.pid } }) + '\\n');
    });
  }).listen(sock, () => {
    fs.writeFileSync(path.join(dir, 'daemon-pipe'), sock);
    fs.unlinkSync(path.join(dir, 'daemon-booting'));
  });
}, Number(process.env.FAKE_WMUX_BOOT_MS || 150));
`;

import {
  claimSpawnedDaemonFiles,
  ensureDaemon,
  killDaemonByPidFileOutcome,
  liveDaemonFileOwner,
  type DaemonLauncherDeps,
} from '../daemonLauncherCore';
import { getDaemonAuthTokenPath, getDaemonSocketPath } from '../../constants';

const noop = (): void => undefined;
const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid as number;

describe.skipIf(process.platform === 'win32')('daemonLauncherCore — concurrent start (POSIX)', () => {
  let wmuxDir: string;
  let prevSuffix: string | undefined;
  let scriptPath: string;
  let sock: string;
  const launched: number[] = [];
  const servers: net.Server[] = [];

  beforeEach(() => {
    prevSuffix = process.env.WMUX_DATA_SUFFIX;
    // Short suffix: the socket path must fit sun_path (104 bytes on macOS).
    process.env.WMUX_DATA_SUFFIX = `-cs${Math.floor(Math.random() * 1e6)}`;
    wmuxDir = path.join(os.homedir(), `.wmux${process.env.WMUX_DATA_SUFFIX}`);
    fs.mkdirSync(wmuxDir, { recursive: true });
    sock = getDaemonSocketPath();
    scriptPath = path.join(wmuxDir, 'fake-daemon.js');
    fs.writeFileSync(scriptPath, FAKE_DAEMON);
    fs.writeFileSync(getDaemonAuthTokenPath(), 'test-token', { mode: 0o600 });
    process.env.FAKE_WMUX_DIR = wmuxDir;
    process.env.FAKE_WMUX_SOCK = sock;
  });

  afterEach(async () => {
    for (const pid of launched.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    delete process.env.FAKE_WMUX_DIR;
    delete process.env.FAKE_WMUX_SOCK;
    delete process.env.FAKE_WMUX_BOOT_MS;
    if (prevSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = prevSuffix;
    fs.rmSync(wmuxDir, { recursive: true, force: true });
  });

  function deps(): DaemonLauncherDeps {
    return {
      resolveDaemonScriptCandidates: () => [scriptPath],
      resolveSpawnedByVersion: () => '9.9.9-test',
      askUserToRecoverFromStalePid: async () => false,
      isElectronHost: () => false,
      launchViaLaunchdOnDarwin: false,
      log: noop,
      warn: noop,
    };
  }

  const livePidFile = (): number => parseInt(fs.readFileSync(path.join(wmuxDir, 'daemon.pid'), 'utf8'), 10);

  it('two concurrent starters end with one daemon, and both report its pid', async () => {
    const [a, b] = await Promise.all([ensureDaemon(deps()), ensureDaemon(deps())]);
    for (const r of [a, b]) if (r.pid) launched.push(r.pid);
    expect(a.pid).toBe(b.pid);
    expect([a.spawned, b.spawned].sort()).toEqual([false, true]);
    expect(isAlive(a.pid as number)).toBe(true);
    expect(livePidFile()).toBe(a.pid);
    expect(fs.readFileSync(path.join(wmuxDir, 'daemon.lock'), 'utf8')).toBe(String(a.pid));
  }, 30_000);

  it('never deletes the lock files of a running daemon whose pid file was lost', async () => {
    const owner = spawn(process.execPath, [scriptPath], { detached: true, stdio: 'ignore', env: process.env });
    launched.push(owner.pid as number);
    await vi.waitFor(() => expect(fs.existsSync(path.join(wmuxDir, 'daemon-pipe'))).toBe(true), { timeout: 5_000 });
    fs.unlinkSync(path.join(wmuxDir, 'daemon.pid'));

    const info = await ensureDaemon(deps());
    if (info.pid && info.pid !== owner.pid) launched.push(info.pid);
    expect(info).toMatchObject({ pid: owner.pid, spawned: false });
    expect(fs.readFileSync(path.join(wmuxDir, 'daemon.lock'), 'utf8')).toBe(String(owner.pid));
    expect(fs.existsSync(path.join(wmuxDir, 'daemon-pipe'))).toBe(true);
    // Restored, so a later wedge of this daemon goes through the verified path.
    expect(livePidFile()).toBe(owner.pid);
  }, 30_000);

  it('still cleans truly stale files and starts a fresh daemon', async () => {
    const dead = deadPid();
    for (const name of ['daemon.lock', 'daemon.pid']) fs.writeFileSync(path.join(wmuxDir, name), String(dead));
    fs.writeFileSync(path.join(wmuxDir, 'daemon-booting'), String(dead));
    fs.writeFileSync(path.join(wmuxDir, 'daemon-pipe'), path.join(wmuxDir, 'gone.sock'));

    const info = await ensureDaemon(deps());
    if (info.pid) launched.push(info.pid);
    expect(info.spawned).toBe(true);
    expect(info.pid).not.toBe(dead);
    expect(livePidFile()).toBe(info.pid);
    expect(fs.existsSync(path.join(wmuxDir, 'daemon-booting'))).toBe(false);
  }, 30_000);

  // The window before a booting daemon writes its own files (Windows measured
  // 0.4-1.6 s): the launcher records it right after spawn.
  it('records a spawned daemon in daemon.pid and daemon-booting before it takes the lock', async () => {
    process.env.FAKE_WMUX_BOOT_MS = '1500';
    const pending = ensureDaemon(deps());
    let booting = 0;
    await vi.waitFor(() => {
      booting = livePidFile();
      expect(booting).toBeGreaterThan(0);
    }, { timeout: 5_000 });
    launched.push(booting);
    expect(fs.existsSync(path.join(wmuxDir, 'daemon.lock'))).toBe(false);
    expect(fs.readFileSync(path.join(wmuxDir, 'daemon-booting'), 'utf8')).toBe(String(booting));

    const info = await pending;
    expect(info).toMatchObject({ pid: booting, spawned: true });
    // The daemon's own acquireLock accepted the files naming it and kept them.
    expect(livePidFile()).toBe(booting);
    expect(fs.readFileSync(path.join(wmuxDir, 'daemon.lock'), 'utf8')).toBe(String(booting));
    expect(fs.existsSync(path.join(wmuxDir, 'daemon-booting'))).toBe(false);
  }, 30_000);

  // What a second Windows starter (no launcher lock) meets inside that window.
  it('a second starter waits for a booting daemon that has not taken the lock, and spawns nothing', async () => {
    const owner = spawn(process.execPath, [scriptPath], {
      detached: true, stdio: 'ignore', env: { ...process.env, FAKE_WMUX_BOOT_MS: '1500' },
    });
    launched.push(owner.pid as number);
    expect(claimSpawnedDaemonFiles(wmuxDir, owner.pid as number)).toBe(true);

    const info = await ensureDaemon(deps());
    if (info.pid && info.pid !== owner.pid) launched.push(info.pid);
    expect(info).toMatchObject({ pid: owner.pid, spawned: false });
    expect(isAlive(owner.pid as number)).toBe(true);
    expect(fs.readFileSync(path.join(wmuxDir, 'daemon.lock'), 'utf8')).toBe(String(owner.pid));
    expect(livePidFile()).toBe(owner.pid);
  }, 30_000);

  it('full shutdown finds and kills a daemon that is still booting', async () => {
    process.env.FAKE_WMUX_BOOT_MS = '3000';
    const pending = ensureDaemon(deps());
    const settled = pending.then(() => 'ready', (err: Error) => err.message);
    let booting = 0;
    await vi.waitFor(() => {
      booting = livePidFile();
      expect(booting).toBeGreaterThan(0);
    }, { timeout: 5_000 });
    launched.push(booting);
    expect(fs.existsSync(path.join(wmuxDir, 'daemon.lock'))).toBe(false);

    expect(killDaemonByPidFileOutcome([scriptPath])).toBe('killed');
    expect(await settled).toMatch(/exited during startup/);
    await vi.waitFor(() => expect(isAlive(booting)).toBe(false), { timeout: 5_000 });
  }, 30_000);

  it('files naming a reused pid of an unrelated process are neither killed nor waited on', async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    launched.push(unrelated.pid as number);
    expect(claimSpawnedDaemonFiles(wmuxDir, unrelated.pid as number)).toBe(true);

    expect(killDaemonByPidFileOutcome([scriptPath])).toBe('not-daemon');
    await expect(ensureDaemon(deps())).rejects.toThrow(/does not identify the wmux daemon script/);
    expect(isAlive(unrelated.pid as number)).toBe(true);
  }, 30_000);

  it('reports the daemon that answered readiness, not a spawned pid that lost', async () => {
    // Another live daemon (pid 999) owns the socket; the spawned process never
    // answers and only points the pipe hint at that socket.
    const server = net.createServer((s) => {
      s.on('data', (d) => {
        const id = JSON.parse(String(d).split('\n')[0]).id;
        s.write(JSON.stringify({ id, ok: true, result: { status: 'ok', pid: 999 } }) + '\n');
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, () => r()));
    fs.writeFileSync(
      scriptPath,
      `require('fs').writeFileSync(${JSON.stringify(path.join(wmuxDir, 'loser.pid'))}, String(process.pid));\n` +
        `require('fs').writeFileSync(${JSON.stringify(path.join(wmuxDir, 'daemon-pipe'))}, ${JSON.stringify(sock)});\n` +
        'setTimeout(() => {}, 30000);\n',
    );
    const info = await ensureDaemon(deps());
    try { launched.push(parseInt(fs.readFileSync(path.join(wmuxDir, 'loser.pid'), 'utf8'), 10)); } catch { /* not started */ }
    expect(info).toMatchObject({ pid: 999, spawned: false });
    expect(livePidFile()).toBe(999);
  }, 30_000);
});

describe('claimSpawnedDaemonFiles', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csdf-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes both files for a fresh spawn, and never replaces a pid file written after the cleanup', () => {
    expect(claimSpawnedDaemonFiles(dir, 4242)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8')).toBe('4242');
    expect(fs.readFileSync(path.join(dir, 'daemon-booting'), 'utf8')).toBe('4242');

    fs.unlinkSync(path.join(dir, 'daemon-booting'));
    expect(claimSpawnedDaemonFiles(dir, 5353)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8')).toBe('4242');
    // No marker for a daemon whose pid file was not ours: it may be past boot.
    expect(fs.existsSync(path.join(dir, 'daemon-booting'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('liveDaemonFileOwner', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldfo-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('names a live owner other than the judged pid or ourselves, never a dead one', () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(dir, 'daemon.lock'), String(child.pid));
      expect(liveDaemonFileOwner(dir, null)).toBe(child.pid);
      expect(liveDaemonFileOwner(dir, child.pid as number)).toBeNull();
      fs.writeFileSync(path.join(dir, 'daemon.lock'), String(process.pid));
      expect(liveDaemonFileOwner(dir, null)).toBeNull();
      fs.writeFileSync(path.join(dir, 'daemon.lock'), String(deadPid()));
      fs.writeFileSync(path.join(dir, 'daemon.pid'), 'garbage');
      expect(liveDaemonFileOwner(dir, null)).toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  });
});
