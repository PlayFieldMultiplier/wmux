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
  parseLstart,
  parseProcessStart,
  processStartQuery,
  sameProcess,
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

  it('refuses WMUX_MCP_REGISTER_EXTERNAL in any spelling: it writes the real agent configs', () => {
    expect(launchEnv({}, '-verify-a', { WMUX_MCP_REGISTER_EXTERNAL: '1' }).refusal).toMatch(/WMUX_MCP_REGISTER_EXTERNAL/);
    expect(launchEnv({}, '-verify-a', { wmux_mcp_register_external: '0' }).refusal).toMatch(/WMUX_MCP_REGISTER_EXTERNAL/);
    // Inherited, it never reaches the instance either: the scrub drops WMUX_*.
    expect(launchEnv({ WMUX_MCP_REGISTER_EXTERNAL: '1' }, '-verify-a', {}).env).toEqual({ WMUX_DATA_SUFFIX: '-verify-a' });
  });
});

describe('process identity (pid + creation time)', () => {
  it('reads one CIM row the way a whole-table listing does', () => {
    expect(processStartQuery(1234, 'win32').args.at(-1)).toContain('ProcessId=1234');
    expect(parseProcessStart('{"ProcessId":1234,"CreationDate":"\\/Date(1784777530054)\\/"}', 1234, 'win32')).toBe(1784777530054);
    // Another pid's row, no row (process gone), or garbage: unknown.
    expect(parseProcessStart('{"ProcessId":99,"CreationDate":"\\/Date(1)\\/"}', 1234, 'win32')).toBeNull();
    expect(parseProcessStart('', 1234, 'win32')).toBeNull();
    expect(parseProcessStart('nope', 1234, 'win32')).toBeNull();
  });

  it('reads ps lstart on POSIX', () => {
    expect(processStartQuery(42, 'darwin')).toEqual({ file: 'ps', args: ['-o', 'lstart=', '-p', '42'] });
    expect(parseProcessStart('Thu Oct 22 10:00:05 2026\n', 42, 'linux')).toBe(parseLstart('Thu  Oct 22 10:00:05 2026'));
    expect(parseProcessStart('', 42, 'linux')).toBeNull();
  });

  it('never builds a query for a non-pid', () => {
    expect(processStartQuery(0, 'win32')).toBeNull();
    expect(processStartQuery('1; Remove-Item x', 'win32')).toBeNull();
  });

  it('matches only the same pid with the same creation time', () => {
    const recorded = { pid: 10, createdAt: 1000 };
    expect(sameProcess(recorded, { pid: 10, createdAt: 1000 })).toBe(true);
    // The pid was reused by a process that started later.
    expect(sameProcess(recorded, { pid: 10, createdAt: 5000 })).toBe(false);
    // Gone (no creation time readable), or never recorded: no match.
    expect(sameProcess(recorded, { pid: 10, createdAt: null })).toBe(false);
    expect(sameProcess({ pid: 10, createdAt: undefined }, { pid: 10, createdAt: 1000 })).toBe(false);
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
