// The version of the install `hermes` runs, read from its files: every
// install shape wmux meets, and no process at all.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every way to start a process, counted: reading the version starts none.
const procCalls = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const counted = <F extends (...a: never[]) => unknown>(name: string, fn: F): F => ((...a: Parameters<F>) => {
    procCalls.push(name);
    return fn(...a);
  }) as F;
  return {
    ...real,
    default: real,
    execFile: counted('execFile', real.execFile),
    execFileSync: counted('execFileSync', real.execFileSync),
    spawn: counted('spawn', real.spawn),
    spawnSync: counted('spawnSync', real.spawnSync),
    exec: counted('exec', real.exec),
    execSync: counted('execSync', real.execSync),
  };
});

import { hermesInstallVersion, parseInstallVersion } from '../hermesInstall';

const WIN = process.platform === 'win32';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-install-'));
  procCalls.length = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (p: string, text: string, mode = 0o644): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, { mode });
  return p;
};
const versionModule = (v: string): string => `"""Hermes CLI."""\n\n__version__ = "${v}"\n__release_date__ = "2026.10.1"\n`;

describe('hermesInstallVersion', () => {
  it.skipIf(WIN)('the installer\'s launcher: the checkout its venv runs', () => {
    const venvExe = write(path.join(dir, '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'), '#!/usr/bin/env python3\n', 0o755);
    write(path.join(dir, '.hermes', 'hermes-agent', 'hermes_cli', '__init__.py'), versionModule('0.22.5'));
    const launcher = write(path.join(dir, '.local', 'bin', 'hermes'), `#!/usr/bin/env bash\nexec "${venvExe}" "$@"\n`, 0o755);
    expect(hermesInstallVersion(launcher)).toBe('0.22.5');
    expect(procCalls).toEqual([]);
  });

  it.skipIf(WIN)('a pip, pipx or uv venv: its site-packages, through a symlink too', () => {
    const venv = path.join(dir, 'pipx', 'venvs', 'hermes-agent');
    const exe = write(path.join(venv, 'bin', 'hermes'), '#!/usr/bin/env python3\n', 0o755);
    write(path.join(venv, 'lib', 'python3.11', 'site-packages', 'hermes_cli', '__init__.py'), versionModule('0.23.1'));
    const link = path.join(dir, 'bin', 'hermes');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(exe, link);
    expect(hermesInstallVersion(link)).toBe('0.23.1');
    expect(procCalls).toEqual([]);
  });

  it('a Windows venv layout (Scripts, Lib\\site-packages)', () => {
    const venv = path.join(dir, 'hermes-agent', 'venv');
    const exe = write(path.join(venv, 'Scripts', 'hermes.exe'), 'MZ');
    write(path.join(venv, 'Lib', 'site-packages', 'hermes_cli', '__init__.py'), versionModule('0.22.6'));
    expect(hermesInstallVersion(exe)).toBe('0.22.6');
    expect(procCalls).toEqual([]);
  });

  it('null when no version module is found or none parses; nothing runs', () => {
    const venv = path.join(dir, 'venv');
    const exe = write(path.join(venv, 'bin', 'hermes'), '#!/usr/bin/env python3\n', 0o755);
    expect(hermesInstallVersion(exe)).toBeNull();
    write(path.join(dir, 'hermes_cli', '__init__.py'), 'VERSION = "dev"\n');
    expect(hermesInstallVersion(exe)).toBeNull();
    expect(hermesInstallVersion(path.join(dir, 'missing', 'hermes'))).toBeNull();
    expect(procCalls).toEqual([]);
  });

  it('parses a version module', () => {
    expect(parseInstallVersion(versionModule('0.19.0'))).toBe('0.19.0');
    expect(parseInstallVersion('__version__ = \'1.2.3-rc.1\'\n')).toBe('1.2.3-rc.1');
    expect(parseInstallVersion('x = 1\n')).toBeNull();
  });
});
