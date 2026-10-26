// Wiring guard for how each daemon bookkeeping file is written.
//
// The policies themselves (atomic only, in place after a failed rename, in
// place even after a failed temp write) are covered in daemonFiles.test.ts.
// Which file gets which policy is decided at the call sites, in acquireLock and
// main() (index.ts) and in the launcher, none of which can be constructed in a
// unit test, so these are source-shape assertions like completionAlarmWiring.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8').replace(/\r\n/g, '\n');

describe('daemon file write policies', () => {
  const daemon = read('daemon/index.ts');
  const launcher = read('shared/daemon/daemonLauncherCore.ts');
  const callsOn = (src: string, fn: string, target: string): string[] =>
    src.split('\n').filter((l) => l.includes(`${fn}(${target},`));

  it('the daemon fails acquireLock when it cannot write daemon.pid', () => {
    expect(daemon).toMatch(/if \(!replaceFileOrWrite\(PID_FILE, [^\n]*\)\) \{\n\s*throw new Error\(/);
  });

  it('only daemon-pipe is written in place after a failed temp write', () => {
    const pipe = callsOn(daemon, 'replaceFileOrWrite', 'pipeNameFile');
    expect(pipe).toHaveLength(1);
    expect(pipe[0]).toContain('inPlaceAfterTempFailure: true');
    for (const target of ['PID_FILE', 'BOOT_MARKER_FILE']) {
      const calls = callsOn(daemon, 'replaceFileOrWrite', target);
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain('inPlaceAfterTempFailure');
    }
  });

  it('the launcher never writes the marker or a repaired daemon.pid in place', () => {
    expect(launcher).not.toContain('replaceFileOrWrite');
    expect(callsOn(launcher, 'replaceFileAtomic', "path.join(wmuxDir, 'daemon-booting')")).toHaveLength(1);
    expect(launcher).toMatch(/if \(!replaceFileAtomic\(pidFile, String\(liveOwner\), warn\)\) \{\n\s*throw new Error\(/);
  });
});
