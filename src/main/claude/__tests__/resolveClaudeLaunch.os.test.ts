import { describe, expect, it } from 'vitest';
import { resolveClaudeLaunch } from '../resolveClaudeLaunch';

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

  it('runs cli.js (and other scripts) under node — same as the Claude Agent SDK', () => {
    const node = '/usr/bin/node';
    const cli = 'C:\\Users\\a\\AppData\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    expect(resolveClaudeLaunch(cli, {
      platform: 'win32',
      nodeExecutable: node,
      args: ['--version'],
    })).toEqual({
      command: node,
      args: [cli, '--version'],
    });
    expect(resolveClaudeLaunch('/opt/claude/cli.mjs', { nodeExecutable: node, args: ['--version'] })).toEqual({
      command: node,
      args: ['/opt/claude/cli.mjs', '--version'],
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
    // Outer quotes wrap each-token-quoted inner line (shell.handler pattern).
    expect(launch.args[3]).toBe(`""${shim}" "--version""`);
    // .cmd on a non-Windows platform is treated as a normal file (no cmd.exe).
    expect(resolveClaudeLaunch('/tmp/claude.cmd', { platform: 'linux', args: ['--version'] })).toEqual({
      command: '/tmp/claude.cmd',
      args: ['--version'],
    });
  });
});
