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
import { pruneCrashReports } from '../exitEvidence';

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
      `fs.appendFileSync(${JSON.stringify(path.join(root, 'report-settings.json'))}, JSON.stringify({ dir: process.report.directory, on: process.report.reportOnFatalError, excludeEnv: process.report.excludeEnv, excludeNetwork: process.report.excludeNetwork }));`,
      reportDir,
    );
    expect(r.code).toBe(0);
    expect(fs.existsSync(reportDir)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'report-settings.json'), 'utf8'))).toEqual({ dir: reportDir, on: true, excludeEnv: true, excludeNetwork: true });
    expect(r.log).toContain(`[info] [exit] a fatal error writes a diagnostic report (environment excluded) to ${reportDir}`);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** A file named the way Node names its reports, last modified `ageMs` ago. */
function writeReport(dir: string, seq: number, ageMs: number): string {
  const name = `report.20261019.120000.${4000 + seq}.0.${String(seq).padStart(3, '0')}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, '{}');
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
  return name;
}

describe('old diagnostic reports are pruned', () => {
  function freshDir(): string {
    return fs.mkdtempSync(path.join(root, 'reports-'));
  }

  it('keeps the newest ten and leaves anything not a report file alone', async () => {
    const dir = freshDir();
    const names = Array.from({ length: 15 }, (_, i) => writeReport(dir, i + 1, (i + 1) * 60_000));
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
    fs.mkdirSync(path.join(dir, 'report.20200101.000000.1.0.001.json'));
    const logs: string[] = [];

    await pruneCrashReports(dir, { log: (level, msg) => logs.push(`[${level}] ${msg}`) });

    expect(fs.readdirSync(dir).sort()).toEqual(
      [...names.slice(0, 10), 'notes.json', 'report.20200101.000000.1.0.001.json'].sort(),
    );
    expect(logs).toEqual([`[info] [exit] removed 5 old diagnostic report(s) from ${dir}`]);
  });

  it('drops a report older than two weeks even when fewer than ten remain', async () => {
    const dir = freshDir();
    const kept = [writeReport(dir, 1, DAY_MS), writeReport(dir, 2, 13 * DAY_MS)];
    writeReport(dir, 3, 20 * DAY_MS);

    await pruneCrashReports(dir, { log: () => {} });

    expect(fs.readdirSync(dir).sort()).toEqual(kept.sort());
  });

  it('does not follow a link named like a report', async (ctx) => {
    const dir = freshDir();
    const target = path.join(root, `link-target-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(target, 'keep me');
    const link = path.join(dir, 'report.20200101.000000.1.0.001.json');
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (err) {
      // Creating a symlink needs Developer Mode or elevation on Windows.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw err;
    }
    for (let i = 1; i <= 11; i++) writeReport(dir, i, i * 60_000);

    await pruneCrashReports(dir, { log: () => {} });

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
    expect(fs.readdirSync(dir)).toHaveLength(11);
  });

  it('a directory that cannot be read resolves with one warning', async () => {
    const notADir = path.join(root, `plain-file-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(notADir, '');
    const missing = path.join(root, 'no-such-dir', 'crash-reports');
    const logs: string[] = [];

    await pruneCrashReports(notADir, { log: (level, msg) => logs.push(`[${level}] ${msg}`) });
    await pruneCrashReports(missing, { log: (level, msg) => logs.push(`[${level}] ${msg}`) });

    expect(logs).toHaveLength(2);
    expect(logs[0]).toBe(`[warn] [exit] old diagnostic reports not pruned: ${notADir} is not a plain directory`);
    expect(logs[1]).toMatch(/^\[warn\] \[exit\] pruning old diagnostic reports in .* hit 1 error\(s\), first: ENOENT/);
  });

  it('the daemon prunes its report directory when the hooks are installed', async () => {
    const reportDir = freshDir();
    for (let i = 1; i <= 15; i++) writeReport(reportDir, i, i * 60_000);

    const r = await runChild('', reportDir);

    expect(r.code).toBe(0);
    expect(fs.readdirSync(reportDir)).toHaveLength(10);
    expect(r.log).toContain(`[info] [exit] removed 5 old diagnostic report(s) from ${reportDir}`);
  });
});
