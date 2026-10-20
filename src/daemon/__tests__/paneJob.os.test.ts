// #2398 — the real kill-on-close job on Windows. A stand-in daemon (a child
// node process) puts a long-running grandchild in its pane job and then dies
// without a clean shutdown: the grandchild must die with it. With the clean
// exit's disarm first, it must survive, as a program started from a pane
// survives a normal quit. The grandchild is the only process killed here, by
// the pid this test started it with.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const started: number[] = [];

// The stand-in runs plain node, so it loads paneJob.ts compiled to CommonJS,
// with koffi resolved from the repo's node_modules.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pane-job-'));
const compiled = path.join(tmp, 'paneJob.js');
fs.writeFileSync(compiled, transformSync(fs.readFileSync(path.join(__dirname, '..', 'paneJob.ts'), 'utf8'), {
  loader: 'ts',
  format: 'cjs',
}).code);
const koffiEntry = require.resolve('koffi');
const nodeModules = koffiEntry.slice(0, koffiEntry.lastIndexOf(`node_modules${path.sep}`) + 'node_modules'.length);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs a stand-in daemon; resolves with the grandchild pid it contained. */
function runStandIn(disarm: boolean): Promise<number> {
  const script = `
    const { createPaneJob } = require(${JSON.stringify(compiled)});
    const { spawn } = require('node:child_process');
    const job = createPaneJob({ log: (level, m) => console.error(level, m) });
    const child = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', detached: true });
    child.unref();
    job.contain(child.pid);
    if (job.stats().contained !== 1) { console.error('not contained'); process.exit(2); }
    process.stdout.write(String(child.pid));
    ${disarm ? 'job.disarm();' : ''}
    // No clean shutdown: the process ends and its job handle closes with it.
    process.exit(0);
  `;
  return new Promise((resolve, reject) => {
    const standIn = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_PATH: nodeModules },
    });
    let out = '';
    let err = '';
    standIn.stdout.on('data', (d) => { out += d; });
    standIn.stderr.on('data', (d) => { err += d; });
    standIn.on('exit', (code) => {
      const pid = Number(out.trim());
      if (pid) started.push(pid);
      if (code !== 0 || !pid) reject(new Error(`stand-in exited ${code}: ${err}`));
      else resolve(pid);
    });
  });
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

afterEach(() => {
  for (const pid of started.splice(0)) {
    if (alive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
  }
});

describe.runIf(process.platform === 'win32')('pane job on Windows', () => {
  it('ends a contained process when the daemon dies without a clean shutdown', async () => {
    const pid = await runStandIn(false);
    expect(await waitGone(pid, 5000)).toBe(true);
  }, 30_000);

  it('keeps a contained process when the job was disarmed for a clean exit', async () => {
    const pid = await runStandIn(true);
    expect(await waitGone(pid, 1500)).toBe(false);
  }, 30_000);
});
