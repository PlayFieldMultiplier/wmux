import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Save the real home before overriding; do not overwrite if already set.
if (!process.env.WMUX_TEST_REAL_HOME) {
  process.env.WMUX_TEST_REAL_HOME = os.homedir();
}

// mkdtempSync a directory under os.tmpdir() ('wmux-test-'), set HOME and USERPROFILE,
// and default WMUX_DATA_SUFFIX to '-vitest'.
// realpath: on macOS os.tmpdir() is under /var, a symlink to /private/var. Code that
// resolves paths (resolveBrowserExportPath) returns the /private form, so a HOME
// left in the symlinked form would never compare equal to what it computes.
//
// POSIX roots it at /tmp, not os.tmpdir(): unix socket paths live under this
// HOME (~/.wmux-vitest/session-<id>.sock) and sun_path holds 104 bytes on macOS.
// macOS's os.tmpdir() is /private/var/folders/<2>/<28>/T, which pushed
// `session-modepre-<8 hex>.sock` to 116 bytes; the kernel kept the first 103,
// cutting the unique part off, so two pipes bound at once got the same address
// (EADDRINUSE, SessionPipe.modePreamble / attachSnapshot on macos-14).
const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'wmux-test-')));
process.env.HOME = tempDir;
// USERPROFILE only exists on Windows. getWmuxHomeDir() prefers USERPROFILE over
// HOME, so defining it on POSIX would shadow a test's own HOME override (a test
// that points HOME at its fixture dir would silently read the wrong directory).
if (process.platform === 'win32') process.env.USERPROFILE = tempDir;
process.env.WMUX_DATA_SUFFIX ??= '-vitest';
// Read by assertNotLiveWmuxDataDir: without this marker a vitest run refuses the
// live data dir even when HOME was never overridden.
process.env.WMUX_TEST_ISOLATED = '1';

// Remove the temp HOME once this file's tests are done; a setup file's afterAll
// runs after the file's own. The process 'exit' handler this replaces left one
// of these dirs per test file in %TEMP% on Windows (tens of thousands), and it
// swallowed every error, so nothing said why. Here a HOME that cannot be
// removed fails the file and names what is still in it: a test left a handle
// open (a child, a watcher, a stream) in its HOME.
afterAll(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    let left: string[] = [];
    try { left = fs.readdirSync(tempDir, { recursive: true }).map(String); } catch { /* the dir itself is what failed */ }
    throw new Error(`could not remove the test HOME ${tempDir}: ${(err as Error).message}\nstill there: ${left.join(', ') || '(nothing listed)'}`);
  }
});
