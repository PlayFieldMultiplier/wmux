// The rules that keep the verify-wmux driver (scripts/control-wmux.mjs) off the
// owner's real wmux: which suffixes it may launch, which CDP port is "ours",
// and which inherited identity it must not pass to the launched instance.
// @wmux-lane unit
// packagedCliBundle takes the platform as an argument ('win32' is a string
// here); nothing in this file reads the host OS.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimOwnedBy,
  envHasSuffix,
  findClaimedPort,
  launchEnv,
  packagedCliBundle,
  parseCdpLog,
  parseConsoleLine,
  scrubEnv,
  suffixRefusal,
} from '../lib/control-wmux-lib.mjs';

describe('suffixRefusal', () => {
  it('refuses the main instance and the shared dev/portable suffixes', () => {
    expect(suffixRefusal('')).toMatch(/main wmux instance/);
    expect(suffixRefusal('-dev')).toMatch(/reserved/);
    expect(suffixRefusal('-portable')).toMatch(/reserved/);
  });

  it('accepts a private verification suffix and rejects path-unsafe ones', () => {
    expect(suffixRefusal('-verify-0bc4de')).toBeNull();
    expect(suffixRefusal('verify')).toMatch(/must look like/);
    expect(suffixRefusal('-x/../y')).toMatch(/must look like/);
  });
});

describe('CDP port discovery', () => {
  let dir;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('picks the claim whose pid is ours, never a neighbour in the range', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cdp-claims-'));
    fs.writeFileSync(path.join(dir, 'wmux-cdp-18801.lock'), '111');
    fs.writeFileSync(path.join(dir, 'wmux-cdp-18829.lock'), '222\n');
    fs.writeFileSync(path.join(dir, 'wmux-cdp-18850.lock'), '');
    expect(findClaimedPort(dir, 222)).toBe(18829);
    expect(findClaimedPort(dir, 333)).toBeNull();
    expect(claimOwnedBy(dir, 18829, 222)).toBe(true);
    expect(claimOwnedBy(dir, 18801, 222)).toBe(false);
  });

  it('reads requested / listening / disabled from the boot log', () => {
    expect(parseCdpLog('[WinMux] CDP requested on port 18829\n[WinMux] CDP listening on port 18829 (Chrome/146)')).toEqual({
      requested: 18829, listening: 18829, unverified: false, disabled: false,
    });
    expect(parseCdpLog('[WinMux] CDP disabled — browser automation will be unavailable').disabled).toBe(true);
    expect(parseCdpLog('[WinMux] CDP port 18829 is unverified; remote').unverified).toBe(true);
  });
});

describe('scrubEnv', () => {
  it('drops the parent pane identity and Claude session, then sets our suffix', () => {
    const env = scrubEnv({ PATH: '/bin', WMUX_PTY_ID: 'p', WMUX_DATA_SUFFIX: '', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }, '-verify-a');
    expect(env).toEqual({ PATH: '/bin', WMUX_DATA_SUFFIX: '-verify-a' });
  });
});

describe('launchEnv', () => {
  it('applies --env-file variables after the scrub, one spelling per name', () => {
    const { env } = launchEnv(
      { Path: 'C:\\Windows', WMUX_NO_PATH_REFRESH: '0', CLAUDECODE: '1' },
      '-verify-a',
      { PATH: 'C:\\fake;C:\\Windows', WMUX_NO_PATH_REFRESH: '1' },
    );
    expect(env).toEqual({ PATH: 'C:\\fake;C:\\Windows', WMUX_NO_PATH_REFRESH: '1', WMUX_DATA_SUFFIX: '-verify-a' });
  });

  it('never lets the file pick the suffix, and wants string values', () => {
    expect(launchEnv({}, '-verify-a', { wmux_data_suffix: '' }).refusal).toMatch(/--suffix/);
    expect(launchEnv({}, '-verify-a', { X: 1 }).refusal).toMatch(/must be a string/);
    expect(launchEnv({}, '-verify-a', ['x']).refusal).toMatch(/JSON object/);
  });
});

describe('packagedCliBundle', () => {
  it('finds the CLI bundle in each platform’s packaged layout', () => {
    expect(packagedCliBundle('/Applications/wmux.app/Contents/MacOS/wmux', 'darwin')).toBe('/Applications/wmux.app/Contents/Resources/cli-bundle/index.js');
    expect(packagedCliBundle('C:\\out\\wmux-win32-x64\\wmux.exe', 'win32')).toBe('C:\\out\\wmux-win32-x64\\resources\\cli-bundle\\index.js');
    expect(packagedCliBundle('/x/out/wmux-linux-x64/wmux', 'linux')).toBe('/x/out/wmux-linux-x64/resources/cli-bundle/index.js');
  });
});

describe('parseConsoleLine', () => {
  it('parses the Chromium console line shape', () => {
    expect(parseConsoleLine('[1:1012/072134.2:ERROR:CONSOLE:26] "boom", source: file:///a/b/main_window-x.js (26)')).toEqual({
      level: 'error', text: 'boom', source: 'main_window-x.js (26)',
    });
    expect(parseConsoleLine('[Main] not a console line')).toBeNull();
  });
});

describe('envHasSuffix', () => {
  it('matches only the exact suffix, in ps -E and /proc environ shapes', () => {
    expect(envHasSuffix('node daemon.js HOME=/x WMUX_DATA_SUFFIX=-verify-a PATH=/bin', '-verify-a')).toBe(true);
    expect(envHasSuffix('HOME=/x\0WMUX_DATA_SUFFIX=-verify-a\0', '-verify-a')).toBe(true);
    expect(envHasSuffix('WMUX_DATA_SUFFIX=-verify-ab PATH=/bin', '-verify-a')).toBe(false);
    expect(envHasSuffix('PATH=/bin', '-verify-a')).toBe(false);
  });
});
