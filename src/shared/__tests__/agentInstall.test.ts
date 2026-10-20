import { describe, expect, it } from 'vitest';
import { AGENT_IDS } from '../agentSetup';
import {
  agentExecutableNames,
  agentInstallMethod,
  agentLoginCommand,
  classifyInstallFailure,
  shellSyntax,
} from '../agentInstall';

describe('bundled install table', () => {
  it('holds the vendors\' documented native installer lines, verbatim', () => {
    // A change here must come with a re-check against the source URL in agentInstall.ts.
    expect(agentInstallMethod('claude', 'darwin')?.command).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(agentInstallMethod('claude', 'linux')?.command).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(agentInstallMethod('claude', 'win32')?.command).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(agentInstallMethod('codex', 'darwin')?.command).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
    expect(agentInstallMethod('codex', 'win32')?.command)
      .toBe('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"');
    for (const agent of AGENT_IDS) {
      const win = agentInstallMethod(agent, 'win32');
      const posix = agentInstallMethod(agent, 'darwin');
      expect(win?.shell).toBe('powershell');
      expect(posix?.shell).toBe('user');
      // No elevation anywhere: both installers write to the user's folder.
      expect(`${win?.command} ${posix?.command}`).not.toMatch(/sudo|runas|-Verb/i);
    }
  });
});

describe('agentLoginCommand', () => {
  it('quotes paths with spaces, Korean and apostrophes for each shell', () => {
    expect(agentLoginCommand("/Users/김 O'Neil/.local/bin/claude", 'user')).toBe(`'/Users/김 O'\\''Neil/.local/bin/claude'`);
    expect(agentLoginCommand("C:\\Users\\김 O'Neil\\.local\\bin\\claude.exe", 'powershell'))
      .toBe("& 'C:\\Users\\김 O''Neil\\.local\\bin\\claude.exe'");
    expect(agentLoginCommand('C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'powershell'))
      .toBe("node 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'");
  });
});

describe('classifyInstallFailure', () => {
  it('recognises network, permission and anything else', () => {
    expect(classifyInstallFailure('curl: (6) Could not resolve host: claude.ai')).toBe('network');
    expect(classifyInstallFailure('irm : Unable to connect to the remote server')).toBe('network');
    expect(classifyInstallFailure('mkdir: /Users/u/.local/bin: Permission denied')).toBe('permission');
    expect(classifyInstallFailure('Unsupported platform')).toBe('unknown');
  });
});

describe('agentExecutableNames', () => {
  it('accepts the binary, its .exe and the npm entrypoints', () => {
    expect(agentExecutableNames('claude')).toEqual(['claude', 'claude.exe', 'cli.js']);
    expect(agentExecutableNames('codex')).toEqual(['codex', 'codex.exe', 'codex.js']);
  });
});

describe('shellSyntax', () => {
  it('quotes for PowerShell only for pwsh / powershell executables', () => {
    expect(shellSyntax('/usr/local/bin/pwsh')).toBe('powershell');
    expect(shellSyntax('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(shellSyntax('/bin/zsh')).toBe('user');
    expect(shellSyntax(undefined)).toBe('user');
  });
});
