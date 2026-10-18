/**
 * The exit hooks in a real Node process: what lands in the log when the
 * process really exits, and proof that installing them changes no outcome
 * (a fatal exception still kills it, a handled one still does not).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';

let root: string;
let bundle: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-exit-evidence-'));
  bundle = path.join(root, 'exitEvidence.cjs');
  buildSync({
    entryPoints: [path.join(__dirname, '..', 'exitEvidence.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
  });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Run `body` after the hooks are installed with a log that appends to a file. */
function runChild(body: string, reportDir?: string): Promise<{ code: number | null; log: string }> {
  const logFile = path.join(root, `log-${Math.random().toString(36).slice(2)}.txt`);
  const script =
    `const fs = require('fs');` +
    `const m = require(${JSON.stringify(bundle)});` +
    `m.installExitEvidence(process, {` +
    `  log: (level, msg) => fs.appendFileSync(${JSON.stringify(logFile)}, '[' + level + '] ' + msg + '\\n'),` +
    (reportDir ? `  reportDir: ${JSON.stringify(reportDir)},` : '') +
    `});` +
    body;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => {
      let log = '';
      try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* nothing written */ }
      resolve({ code, log });
    });
  });
}

describe('daemon exit evidence in a real process', () => {
  it('process.exit(code) logs the code, the reason and the function that called it', async () => {
    const r = await runChild(
      `function stopTheDaemonForTest() { m.noteExitReason('test stop'); process.exit(7); }` +
      `setTimeout(stopTheDaemonForTest, 10);`,
    );
    expect(r.code).toBe(7);
    expect(r.log).toMatch(/\[warn\] \[exit\] daemon pid=\d+ exiting code=7 reason=test stop uptime=\d+s caller=.*stopTheDaemonForTest/);
  });

  it('an exception with no handler still kills the process, and says so first', async () => {
    const r = await runChild(`setTimeout(() => { throw new Error('kaboom'); }, 10);`);
    expect(r.code).toBe(1);
    expect(r.log).toMatch(/\[error\] \[exit\] fatal uncaughtException with no handler — the process exits: Error: kaboom at /);
    expect(r.log).toMatch(/\[warn\] \[exit\] daemon pid=\d+ exiting code=1 reason=fatal uncaughtException/);
  });

  it('an unhandled rejection with no handler still kills the process, and says so first', async () => {
    const r = await runChild(`Promise.reject(new Error('rejected for test'));`);
    expect(r.code).toBe(1);
    expect(r.log).toContain('[exit] fatal unhandledRejection with no handler — the process exits: Error: rejected for test');
  });

  it('an exception a handler takes still leaves the process running', async () => {
    const r = await runChild(
      `process.on('uncaughtException', () => {});` +
      `setTimeout(() => { throw new Error('survivable'); }, 10);` +
      `setTimeout(() => process.exit(0), 200);`,
    );
    expect(r.code).toBe(0);
    expect(r.log).not.toContain('fatal');
    expect(r.log).toMatch(/exiting code=0 reason=none noted/);
  });

  it('turns on fatal-error reports into the given directory and logs where', async () => {
    const reportDir = path.join(root, 'crash-reports');
    const r = await runChild(
      `fs.appendFileSync(${JSON.stringify(path.join(root, 'report-settings.json'))}, JSON.stringify({ dir: process.report.directory, on: process.report.reportOnFatalError }));`,
      reportDir,
    );
    expect(r.code).toBe(0);
    expect(fs.existsSync(reportDir)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'report-settings.json'), 'utf8'))).toEqual({ dir: reportDir, on: true });
    expect(r.log).toContain(`[info] [exit] a fatal error writes a diagnostic report to ${reportDir}`);
  });
});
