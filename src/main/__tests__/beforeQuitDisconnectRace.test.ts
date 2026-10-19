import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariants for the before-quit daemon lifecycle.
//
// wmux follows tmux-style persistence: a normal Quit DETACHES from the daemon
// (every live PTY session keeps running, and the next launch reattaches), and
// ONLY an explicit tray "Shut down wmux (close all sessions)" tears the daemon
// down. This test locks the structural guarantees of both paths in
// src/main/index.ts so a refactor can't silently regress persistence:
//
//   1. The default path must NOT race daemon.shutdown — it only disconnects,
//      leaving the daemon (and every live PTY) alive. Sending daemon.shutdown
//      on every Quit is the exact regression that broke persistence
//      ("Quit killed my sessions" — the original embarrassment).
//   2. The full-teardown path (gated on `fullShutdownRequested`) races
//      daemon.shutdown and, on timeout, pid-kills the daemon so a wedged
//      daemon can't survive an explicit teardown the user asked for.
//   3. Both paths capture `daemonClient` into a local `clientAtQuit` BEFORE
//      any await, because the module-level daemon lifecycle
//      (DaemonRespawnController.onUninstall) can null `daemonClient` from
//      under us; a post-await deref of the module-level var would throw and
//      stall app.quit() (observed in 2026-05-16 dogfood on a 48-PTY daemon).

describe('before-quit daemon lifecycle — source invariants (tmux persistence)', () => {
  const indexPath = path.join(__dirname, '..', 'index.ts');
  const indexSrc = fs.readFileSync(indexPath, 'utf-8');
  const beforeQuitBlock = indexSrc.slice(
    indexSrc.indexOf("app.on('before-quit'"),
    // The session-end handler follows before-quit; a missing end marker would
    // make indexOf return -1 and the slice silently run to end of file.
    indexSrc.indexOf('async function onWindowsSessionEnd('),
  );

  it('slices a bounded before-quit block', () => {
    const start = indexSrc.indexOf("app.on('before-quit'");
    const end = indexSrc.indexOf('async function onWindowsSessionEnd(');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it('captures daemonClient into clientAtQuit before any await/race', () => {
    expect(indexSrc).toMatch(/const\s+clientAtQuit\s*=\s*daemonClient\s*;/);
    const capturePos = indexSrc.indexOf('const clientAtQuit = daemonClient');
    const racePos = indexSrc.indexOf('raceDaemonShutdown(clientAtQuit');
    expect(capturePos).toBeGreaterThan(0);
    expect(racePos).toBeGreaterThan(capturePos);
  });

  it('default Quit DETACHES — daemon.shutdown race is gated behind fullShutdownRequested', () => {
    // Persistence regression lock: the race must be reachable ONLY inside the
    // explicit full-teardown branch. If daemon.shutdown ran on every Quit, the
    // daemon would die and live sessions would be lost — the bug this whole
    // change set fixes.
    expect(beforeQuitBlock).toMatch(/if\s*\(\s*fullShutdownRequested\s*\)/);
    const flagPos = beforeQuitBlock.indexOf('fullShutdownRequested');
    const racePos = beforeQuitBlock.indexOf('raceDaemonShutdown(clientAtQuit');
    expect(flagPos).toBeGreaterThan(0);
    // The flag check must precede the race in source order (race lives inside
    // the `if (fullShutdownRequested)` block).
    expect(racePos).toBeGreaterThan(flagPos);
  });

  it('full-teardown races shutdown using the local capture (not module-level daemonClient)', () => {
    expect(beforeQuitBlock).toMatch(/raceDaemonShutdown\(\s*clientAtQuit\s*,/);
    // Never race against the module-level variable inside before-quit — it can
    // be nulled mid-await by the disconnected handler.
    expect(beforeQuitBlock).not.toMatch(/raceDaemonShutdown\(\s*daemonClient\s*,/);
  });

  it('post-teardown disconnect targets the local capture inside a try/catch', () => {
    expect(beforeQuitBlock).toMatch(
      /try\s*\{[\s\S]*?await\s+clientAtQuit\.disconnect\(\)\s*;[\s\S]*?\}\s*catch/,
    );
  });

  it('full-teardown has a pid-kill backstop when daemon.shutdown times out', () => {
    // A wedged daemon must not survive an explicit "Shut down completely":
    // when the graceful RPC misses its budget, fall back to a verified kill.
    expect(beforeQuitBlock).toMatch(/killDaemonByPidFile\(\)/);
  });

  it('keeps the full-shutdown budget strictly below the daemon-side hard timeout (10s)', () => {
    // The daemon's own force-exit guard in src/daemon/index.ts is 10 s. The
    // main-side budget must stay under it so the race is meaningful (expiring
    // after the daemon already force-exited would just be slower for nothing).
    const match = /const\s+FULL_SHUTDOWN_TIMEOUT_MS\s*=\s*(\d+)(?:_(\d+))?\s*;/.exec(indexSrc);
    expect(match).not.toBeNull();
    const budget = Number((match![1] + (match![2] ?? '')).replace(/_/g, ''));
    expect(budget).toBeGreaterThanOrEqual(4_000);
    expect(budget).toBeLessThan(10_000);
  });

  it('explicit full shutdown pid-kills a live daemon even when no client is connected', () => {
    // Codex P2: the connected-client full-shutdown branch is nested under
    // `clientAtQuit?.isConnected`. When main has dropped to local-only mode
    // (daemon disconnect / respawn-exhausted) but daemon.pid still points at a
    // live daemon, an explicit "Shut down wmux (close all sessions)" must still
    // tear that daemon down. Lock the pid-kill into the local-mode branch.
    const localBranch = beforeQuitBlock.slice(beforeQuitBlock.indexOf('ptyManager.disposeAll()'));
    expect(localBranch.length).toBeGreaterThan(0);
    expect(localBranch).toMatch(/if\s*\(\s*fullShutdownRequested\s*\)/);
    expect(localBranch).toMatch(/killDaemonByPidFile\(\)/);
  });

  it('a full shutdown watches the daemon exit from before the race until before the quit', () => {
    // dispose() closes the exit watch; a full shutdown takes it first and
    // reports on it, so a daemon that dies natively during teardown still gets
    // its exit code logged. The daemon exits after its ack, so the quit waits
    // (bounded) for the line.
    const startPos = beforeQuitBlock.indexOf('if (fullShutdownRequested) startStopExitReport();');
    const disposePos = beforeQuitBlock.indexOf('daemonRespawnController?.dispose()');
    const racePos = beforeQuitBlock.indexOf('raceDaemonShutdown(clientAtQuit');
    const waitPos = beforeQuitBlock.search(/await Promise\.race\(\[\s*stopExitReport,/);
    const quitPos = beforeQuitBlock.indexOf('app.quit();');
    expect(startPos).toBeGreaterThan(0);
    expect(disposePos).toBeGreaterThan(startPos);
    expect(racePos).toBeGreaterThan(disposePos);
    expect(waitPos).toBeGreaterThan(racePos);
    expect(quitPos).toBeGreaterThan(waitPos);
    expect(beforeQuitBlock).toMatch(/setTimeout\(resolve, STOP_EXIT_REPORT_WAIT_MS\)/);
  });

  it('"Quit and Stop Sessions" takes the exit watch before it disposes the controller', () => {
    // The menu stops the daemon before before-quit runs, and disposes the
    // respawn controller first; the watch must be reported on before then.
    const prepare = indexSrc.slice(indexSrc.indexOf('prepareStop: () => {'));
    const startPos = prepare.indexOf('startStopExitReport();');
    const disposePos = prepare.indexOf('daemonRespawnController?.dispose();');
    expect(startPos).toBeGreaterThan(0);
    expect(disposePos).toBeGreaterThan(startPos);
    // The report is taken from the controller and kept for before-quit.
    expect(indexSrc).toMatch(/function startStopExitReport\(\): void \{\s*if \(stopExitReport\) return;\s*const watch = daemonRespawnController\?\.takeExitWatch\(\) \?\? null;\s*if \(watch\) stopExitReport = watch\.report\('full shutdown'\)/);
  });
});
