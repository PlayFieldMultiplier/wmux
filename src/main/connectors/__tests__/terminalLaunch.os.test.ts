import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { createTerminalLaunch } from '../terminalLaunch';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true }); });
it.skipIf(process.platform === 'win32')('keeps the bearer out of copied text and process arguments and consumes the private launcher', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-launch's ")); dirs.push(dir);
  const token = 'x'.repeat(43);
  for (const agent of ['claude', 'codex']) {
    const executable = path.join(dir, agent); const output = path.join(dir, 'result.json');
    fs.writeFileSync(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.OUTPUT, JSON.stringify({ args: process.argv.slice(2), token: process.env.WMUX_CONNECTOR_12345678_TOKEN }));`, { mode: 0o700 });
    const launch = createTerminalLaunch(dir, agent, 'con-12345678', 'http://127.0.0.1:1234/mcp', token);
    expect(launch.command).not.toContain(token);
    const session = fs.readdirSync(dir).find((name) => name.startsWith('session-'))!;
    expect(fs.statSync(path.join(dir, session)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, session, 'launch')).mode & 0o777).toBe(0o700);
    const run = spawnSync('/bin/sh', ['-c', launch.command], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OUTPUT: output }, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(result.token).toBe(token); expect(JSON.stringify(result.args)).not.toContain(token);
    if (agent === 'claude') {
      const config = result.args[1];
      expect(fs.statSync(config).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(config, 'utf8')).toContain('${WMUX_CONNECTOR_12345678_TOKEN}');
      expect(fs.readFileSync(config, 'utf8')).not.toContain(token);
    }
    expect(spawnSync('/bin/sh', ['-c', launch.command]).status).not.toBe(0);
    launch.close();
  }
});
