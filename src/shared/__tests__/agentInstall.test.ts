// @wmux-lane unit -- pure string functions: the platform is a parameter here,
// never read from the host, so running on Windows cannot change a result.
import { describe, expect, it } from 'vitest';
import { AGENT_IDS } from '../agentSetup';
import {
  agentExecutableNames,
  agentInstallMethod,
  agentInstallMethods,
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
    expect(agentLoginCommand('C:\\Users\\O\u2019Neil\\.local\\bin\\claude.exe', 'powershell'))
      .toBe("& 'C:\\Users\\O\u2019\u2019Neil\\.local\\bin\\claude.exe'");
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

describe('Grok and Antigravity install lines', () => {
  it('macOS and Linux: the vendor install script, in the user\'s shell', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(agentInstallMethods('grok', platform)).toEqual([{
        via: 'script', command: 'curl -fsSL https://x.ai/cli/install.sh | bash', shell: 'user',
        source: 'https://docs.x.ai/build/overview', officialPage: 'https://docs.x.ai/build/overview', requires: ['curl', 'bash'],
      }]);
      expect(agentInstallMethods('agy', platform)).toEqual([{
        via: 'script', command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', shell: 'user',
        source: 'https://antigravity.google/docs/getting-started', officialPage: 'https://antigravity.google/docs/getting-started', requires: ['curl', 'bash'],
      }]);
    }
  });

  it('Windows: PowerShell first, then WinGet (Grok) or Command Prompt (Antigravity), each in its own shell', () => {
    expect(agentInstallMethods('grok', 'win32').map((m) => [m.via, m.shell, m.command, m.requires])).toEqual([
      ['script', 'powershell', 'irm https://x.ai/cli/install.ps1 | iex', []],
      ['winget', 'powershell', 'winget install --id xAI.GrokBuild -e', []],
    ]);
    expect(agentInstallMethods('agy', 'win32').map((m) => [m.via, m.shell, m.command, m.requires])).toEqual([
      ['script', 'powershell', 'irm https://antigravity.google/cli/install.ps1 | iex', []],
      ['cmd', 'cmd', 'curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd', ['curl.exe']],
    ]);
    // The first line stays the one agentInstallMethod gives.
    expect(agentInstallMethod('grok', 'win32')?.via).toBe('script');
    // Claude and Codex keep their one line per platform.
    expect(agentInstallMethods('claude', 'win32')).toHaveLength(1);
    expect(agentInstallMethods('codex', 'darwin')).toHaveLength(1);
  });

  it('signs in at the detected Windows path, quoted for PowerShell', () => {
    expect(agentLoginCommand('C:\\Users\\Kim O\'Neil\\.grok\\bin\\grok.exe', 'powershell'))
      .toBe("& 'C:\\Users\\Kim O''Neil\\.grok\\bin\\grok.exe'");
    expect(agentLoginCommand('C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe', 'powershell'))
      .toBe("& 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe'");
  });
});

describe('agentExecutableNames', () => {
  it('accepts the binary, its .exe and the npm entrypoints', () => {
    expect(agentExecutableNames('claude')).toEqual(['claude', 'claude.exe', 'cli.js']);
    expect(agentExecutableNames('codex')).toEqual(['codex', 'codex.exe', 'codex.js']);
    // No npm entrypoints for an agent whose vendor documents no npm install.
    expect(agentExecutableNames('grok')).toEqual(['grok', 'grok.exe']);
    expect(agentExecutableNames('agy')).toEqual(['agy', 'agy.exe']);
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
