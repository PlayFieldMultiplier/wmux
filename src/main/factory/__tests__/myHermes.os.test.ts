// My Hermes readiness against fake Hermes homes: each reason it is not
// ready, the notices, the install check, and that a check writes nothing
// (no file in the home changes and no Hermes command that writes is run).
// My Hermes is macOS and Linux only in v1: on Windows the same fixtures
// answer `unsupported-os` before anything runs, and the POSIX shapes are
// checked on macOS and Linux.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envNames, hermesExeOwnedBy, listMyHermesProfiles, myHermesReadiness, type MyHermesReadinessDeps } from '../myHermes';
import type { HermesRun } from '../hermesEngine';

const WIN = process.platform === 'win32';

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-myhermes-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A home with ~/.hermes, its install, and the installer's launcher. */
function makeHome(): { exe: string; root: string } {
  const root = path.join(home, '.hermes');
  const venvExe = path.join(root, 'hermes-agent', 'venv', 'bin', 'hermes');
  fs.mkdirSync(path.dirname(venvExe), { recursive: true });
  fs.writeFileSync(venvExe, '#!/usr/bin/env python3\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model: x\n');
  const exe = path.join(home, '.local', 'bin', 'hermes');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, `#!/usr/bin/env bash\nunset PYTHONPATH\nexec "${venvExe}" "$@"\n`, { mode: 0o755 });
  return { exe, root };
}

/** Every file under the home with its content hash (what a write would change). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

interface Answers { version?: string; check?: number; config?: Record<string, unknown> }

function rig(answers: Answers, over: Partial<MyHermesReadinessDeps> = {}) {
  const { exe } = makeHome();
  const calls: string[][] = [];
  const run: HermesRun = async (_exe, args) => {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, stdout: `Hermes Agent v${answers.version ?? '0.22.5'} (2026.10.1)\n`, stderr: '' };
    if (args[0] === 'acp' && args[1] === '--check') return { code: answers.check ?? 0, stdout: 'Hermes ACP check OK\n', stderr: '' };
    const key = args[args.length - 1];
    const cfg = answers.config ?? {};
    if (args.slice(0, 5).join(' ') === '-p default config get --json' && key in cfg) return { code: 0, stdout: `${JSON.stringify(cfg[key])}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: `Config key not set: ${key}` };
  };
  const deps: MyHermesReadinessDeps = { home, platform: process.platform, resolveExe: () => exe, run, baseEnv: { PATH: '/usr/bin' }, pidAlive: () => true, ...over };
  return { deps, calls, exe };
}

const READY_CONFIG = { model: { default: 'anthropic/claude-x' }, 'approvals.mode': 'manual' };

/** What a readiness check may run: `--version`, `acp --check`, and
 *  `-p <profile> config get --json <key>`; nothing that writes, updates,
 *  sets up or starts Hermes. */
function expectReadOnly(calls: string[][]): void {
  for (const args of calls) {
    const ok = (args.length === 1 && args[0] === '--version')
      || (args.length === 2 && args[0] === 'acp' && args[1] === '--check')
      || (args.length === 6 && args[0] === '-p' && args.slice(2, 5).join(' ') === 'config get --json');
    expect(ok, args.join(' ')).toBe(true);
  }
}

describe.runIf(WIN)('myHermesReadiness on Windows', () => {
  it('answers unsupported-os before it runs Hermes or reads the home', async () => {
    const r = rig({ config: READY_CONFIG });
    const before = snapshot(home);
    expect(await myHermesReadiness('default', r.deps)).toMatchObject({ ready: false, reason: 'unsupported-os' });
    expect(r.calls).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  });
});

describe.skipIf(WIN)('myHermesReadiness', () => {
  it('a ready profile reports its version and notices, and writes nothing', async () => {
    const r = rig({ config: { ...READY_CONFIG, 'approvals.mode': 'smart', command_allowlist: ['git *', 'ls'], mcp_servers: { github: {}, linear: {} } } });
    const before = snapshot(home);
    const ready = await myHermesReadiness('default', r.deps);
    expect(ready).toEqual({
      ready: true,
      version: '0.22.5',
      notices: [{ kind: 'approvals-smart' }, { kind: 'allowlist', count: 2 }, { kind: 'mcp-servers', names: ['github', 'linear'] }],
    });
    expect(snapshot(home)).toEqual(before);
    expectReadOnly(r.calls);
  });

  it('an old Hermes says to update and stops before reading the profile', async () => {
    const r = rig({ version: '0.19.0', config: READY_CONFIG });
    const before = snapshot(home);
    expect(await myHermesReadiness('default', r.deps)).toMatchObject({ ready: false, reason: 'outdated', version: '0.19.0', message: expect.stringContaining('`hermes update`') });
    expect(r.calls).toEqual([['--version']]);
    expect(snapshot(home)).toEqual(before);
  });

  it('no model, approvals off, and a wmux MCP server are each not ready', async () => {
    expect(await myHermesReadiness('default', rig({ config: { 'approvals.mode': 'manual' } }).deps)).toMatchObject({ ready: false, reason: 'no-model' });
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home);
    expect(await myHermesReadiness('default', rig({ config: { ...READY_CONFIG, 'approvals.mode': 'off' } }).deps)).toMatchObject({ ready: false, reason: 'approvals-off' });
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home);
    // YAML `off` read back as a boolean is off too (Hermes's own reading).
    expect(await myHermesReadiness('default', rig({ config: { ...READY_CONFIG, 'approvals.mode': false } }).deps)).toMatchObject({ reason: 'approvals-off' });
    for (const name of ['wmux', 'mcp-wmux']) {
      fs.rmSync(home, { recursive: true, force: true });
      fs.mkdirSync(home);
      const r = rig({ config: { ...READY_CONFIG, mcp_servers: { [name]: { command: 'x' }, github: {} } } });
      const before = snapshot(home);
      expect(await myHermesReadiness('default', r.deps)).toMatchObject({ ready: false, reason: 'wmux-mcp', message: expect.stringContaining('config.yaml'), notices: [{ kind: 'mcp-servers', names: ['github'] }] });
      expect(snapshot(home)).toEqual(before);
      expectReadOnly(r.calls);
    }
  });

  it('a messenger in the config or a messenger token name in .env is not ready; the value is never read out', async () => {
    const byConfig = rig({ config: { ...READY_CONFIG, platforms: { telegram: { enabled: true }, local: { enabled: true } }, 'gateway.platforms': { discord: { enabled: 'true' } } } });
    expect(await myHermesReadiness('default', byConfig.deps)).toMatchObject({ ready: false, reason: 'messengers', platforms: ['discord', 'telegram'] });
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home);
    const byEnv = rig({ config: READY_CONFIG });
    fs.writeFileSync(path.join(home, '.hermes', '.env'), '# keys\nOPENAI_API_KEY=sk-secret-value\nexport SLACK_BOT_TOKEN=xoxb-secret-value\n');
    const before = snapshot(home);
    const r = await myHermesReadiness('default', byEnv.deps);
    expect(r).toMatchObject({ ready: false, reason: 'messengers', platforms: ['slack'] });
    expect(JSON.stringify(r)).not.toMatch(/secret-value/);
    expect(snapshot(home)).toEqual(before);
    // An explicit `enabled: false` wins over a token (Hermes #41112).
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home);
    const off = rig({ config: { ...READY_CONFIG, platforms: { slack: { enabled: false } } } });
    fs.writeFileSync(path.join(home, '.hermes', '.env'), 'SLACK_BOT_TOKEN=x\n');
    expect(await myHermesReadiness('default', off.deps)).toMatchObject({ ready: true });
  });

  it('a running gateway with messaging platforms is not ready; a stale state file is ignored', async () => {
    const live = rig({ config: READY_CONFIG });
    fs.writeFileSync(path.join(home, '.hermes', 'gateway_state.json'), JSON.stringify({ pid: 4242, argv: ['hermes', 'gateway', 'run'], hermes_home: path.join(home, '.hermes'), platforms: { telegram: {} } }));
    expect(await myHermesReadiness('default', live.deps)).toMatchObject({ ready: false, reason: 'gateway-messengers', platforms: ['telegram'] });
    expect(await myHermesReadiness('default', { ...live.deps, pidAlive: () => false })).toMatchObject({ ready: true });
  });

  it('a hermes from another install, a missing profile, Windows, and a failed ACP check', async () => {
    const r = rig({ config: READY_CONFIG });
    const stray = path.join(home, 'elsewhere', 'hermes');
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, '#!/bin/sh\nexec /opt/hermes/bin/hermes "$@"\n', { mode: 0o755 });
    expect(await myHermesReadiness('default', { ...r.deps, resolveExe: () => stray })).toMatchObject({ ready: false, reason: 'foreign-install' });
    expect(r.calls).toEqual([]);
    expect(await myHermesReadiness('coder', r.deps)).toMatchObject({ ready: false, reason: 'profile-missing' });
    expect(await myHermesReadiness('../etc', r.deps)).toMatchObject({ ready: false, reason: 'profile-missing' });
    expect(await myHermesReadiness('default', { ...r.deps, platform: 'win32' })).toMatchObject({ ready: false, reason: 'unsupported-os' });
    expect(await myHermesReadiness('default', { ...r.deps, resolveExe: () => null })).toMatchObject({ ready: false, reason: 'not-installed' });
    // Not installed wins over a missing ~/.hermes.
    expect(await myHermesReadiness('default', { ...r.deps, resolveExe: () => null, isDir: () => false })).toMatchObject({ reason: 'not-installed' });
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home);
    expect(await myHermesReadiness('default', rig({ check: 1, config: READY_CONFIG }).deps)).toMatchObject({ ready: false, reason: 'acp-missing' });
  });

  it('a named profile is read with -p and its own folder', async () => {
    const r = rig({ config: READY_CONFIG });
    fs.mkdirSync(path.join(home, '.hermes', 'profiles', 'coder'), { recursive: true });
    await myHermesReadiness('coder', r.deps);
    expect(r.calls.filter((a) => a[0] === '-p').every((a) => a[1] === 'coder')).toBe(true);
  });
});

describe('My Hermes helpers', () => {
  it('lists default and the named profile folders Hermes accepts', () => {
    // No Hermes at all: `default` is still offered (its readiness says why).
    expect(listMyHermesProfiles(home)).toEqual(['default']);
    makeHome();
    for (const n of ['coder', 'Bad Name', 'default']) fs.mkdirSync(path.join(home, '.hermes', 'profiles', n), { recursive: true });
    fs.writeFileSync(path.join(home, '.hermes', 'profiles', 'file'), '');
    expect(listMyHermesProfiles(home)).toEqual(['default', 'coder']);
  });

  it('knows the installer launcher and a symlink into the install, not another hermes', () => {
    const { exe, root } = makeHome();
    expect(hermesExeOwnedBy(exe, root)).toBe(true);
    const link = path.join(home, 'link-hermes');
    fs.symlinkSync(path.join(root, 'hermes-agent', 'venv', 'bin', 'hermes'), link);
    expect(hermesExeOwnedBy(link, root)).toBe(true);
    const other = path.join(home, 'other');
    fs.writeFileSync(other, '\x7fELF binary');
    expect(hermesExeOwnedBy(other, root)).toBe(false);
  });

  it('reads .env names only', () => {
    expect(envNames('A=1\n  export B_2 = two\n# C=3\nnot a line\n=x\n')).toEqual(['A', 'B_2']);
  });
});
