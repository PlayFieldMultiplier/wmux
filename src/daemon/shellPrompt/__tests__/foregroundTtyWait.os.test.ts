// The Linux wait channel for real: an interactive bash in a pty runs its
// command in its own foreground group, as a user's shell does. `cat` waiting
// on the terminal must read as `reads`, a `sleep` as `other`.
// @wmux-lane integration — it spawns real ptys and reads /proc.
import { describe, expect, it } from 'vitest';
import * as pty from 'node-pty';
import { foregroundTtyWait } from '../foregroundTtyWait';

const linux = process.platform === 'linux';

async function waitFor<T>(read: () => T, done: (v: T) => boolean, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  let v = read();
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    v = read();
  }
  return v;
}

describe.skipIf(!linux)('foregroundTtyWait on Linux', () => {
  it('a foreground `cat` reads the terminal; a foreground `sleep` does not', async () => {
    // `; true` keeps bash as the parent (a lone `-c cat` would exec cat in its place).
    const reader = pty.spawn('bash', ['--norc', '--noprofile', '-i', '-c', 'cat; true'], { cols: 80, rows: 24, env: { ...process.env, PS1: '$ ' } });
    const sleeper = pty.spawn('bash', ['--norc', '--noprofile', '-i', '-c', 'sleep 30; true'], { cols: 80, rows: 24, env: { ...process.env, PS1: '$ ' } });
    try {
      expect(await waitFor(() => foregroundTtyWait(reader.pid), (v) => v === 'reads')).toBe('reads');
      expect(await waitFor(() => foregroundTtyWait(sleeper.pid), (v) => v === 'other')).toBe('other');
    } finally {
      reader.kill();
      sleeper.kill();
    }
  }, 20_000);
});
