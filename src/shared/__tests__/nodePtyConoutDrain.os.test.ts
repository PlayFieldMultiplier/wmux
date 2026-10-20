// #2398 — real ptys through node-pty's shared conout drain worker
// (patches/node-pty+1.2.0-beta.15.patch): several ptys printing at once each
// get all of their own output, in order, and none of anyone else's, including
// one whose reader is paused for a while (its drain must hold back while the
// others keep flowing). Windows only: the drain worker is the ConPTY path.

import { describe, expect, it } from 'vitest';
import * as pty from 'node-pty';

const COUNT = 6;
const LINES = 400;

function linesOf(output: string, index: number): { numbers: number[]; foreign: number } {
  const numbers: number[] = [];
  let foreign = 0;
  for (const match of output.matchAll(/P(\d+)x(\d+)y/g)) {
    if (Number(match[1]) === index) numbers.push(Number(match[2]));
    else foreign++;
  }
  return { numbers, foreign };
}

describe.runIf(process.platform === 'win32')('node-pty shared conout drain on ConPTY', () => {
  it('delivers every pty\'s output complete and in order, with one reader paused', async () => {
    const outputs = Array.from({ length: COUNT }, () => '');
    await Promise.all(outputs.map((_, index) => new Promise<void>((resolve) => {
      const p = pty.spawn('cmd.exe', ['/d', '/c', `for /L %i in (1,1,${LINES}) do @echo P${index}x%iy`], {
        cols: 120,
        rows: 30,
        useConptyDll: true,
      });
      p.onData((data) => { outputs[index] += data; });
      if (index === 0) {
        p.pause();
        setTimeout(() => p.resume(), 500);
      }
      // node-pty flushes the drain for a second after the exit.
      p.onExit(() => setTimeout(resolve, 1500));
    })));

    outputs.forEach((output, index) => {
      const { numbers, foreign } = linesOf(output, index);
      expect(foreign, `pty ${index} got another pty's output`).toBe(0);
      expect(numbers, `pty ${index}`).toEqual(Array.from({ length: LINES }, (_, i) => i + 1));
    });
  }, 60_000);
});
