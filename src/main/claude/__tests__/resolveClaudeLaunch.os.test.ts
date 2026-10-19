import { describe, expect, it } from 'vitest';
import { resolveClaudeLaunch, sdkDefaultScriptHost } from '../resolveClaudeLaunch';

describe('resolveClaudeLaunch', () => {
  it('runs a native binary as the command', () => {
    expect(resolveClaudeLaunch('/usr/local/bin/claude', { args: ['--version'] })).toEqual({
      command: '/usr/local/bin/claude',
      args: ['--version'],
    });
    expect(resolveClaudeLaunch('C:\\Users\\a\\AppData\\npm\\claude.exe', {
      platform: 'win32',
      args: ['--version'],
    })).toEqual({
      command: 'C:\\Users\\a\\AppData\\npm\\claude.exe',
      args: ['--version'],
    });
  });

  it('runs cli.js under PATH node by default — same as the Claude Agent SDK (not process.execPath)', () => {
    const cli = 'C:\\Users\\a\\AppData\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    // Electron main: execPath is the wmux binary. The old bug spawned that
    // without ELECTRON_RUN_AS_NODE and timed out a valid npm install.
    const electron = '/Applications/wmux.app/Contents/MacOS/wmux';
    expect(resolveClaudeLaunch(cli, {
      platform: 'win32',
      execPath: electron,
      args: ['--version'],
    })).toEqual({
      command: 'node',
      args: [cli, '--version'],
    });
    expect(sdkDefaultScriptHost()).toBe('node');
    expect(resolveClaudeLaunch('/opt/claude/cli.mjs', { args: ['--version'] })).toEqual({
      command: 'node',
      args: ['/opt/claude/cli.mjs', '--version'],
    });
  });

  it('when an Electron binary is forced as the script host, sets ELECTRON_RUN_AS_NODE', () => {
    const electron = '/Applications/wmux.app/Contents/MacOS/wmux';
    const cli = '/opt/claude/cli.js';
    expect(resolveClaudeLaunch(cli, { nodeExecutable: electron, args: ['--version'] })).toEqual({
      command: electron,
      args: [cli, '--version'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('runs a Windows .cmd / .bat through cmd.exe with shell-safe quoting', () => {
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const shim = 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd';
    const launch = resolveClaudeLaunch(shim, {
      platform: 'win32',
      cmdExecutable: cmd,
      args: ['--version'],
    });
    expect(launch.command).toBe(cmd);
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(launch.args[3]).toBe(`""${shim}" "--version""`);
    expect(resolveClaudeLaunch('/tmp/claude.cmd', { platform: 'linux', args: ['--version'] })).toEqual({
      command: '/tmp/claude.cmd',
      args: ['--version'],
    });
  });
});
