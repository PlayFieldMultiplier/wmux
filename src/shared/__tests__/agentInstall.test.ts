import { describe, expect, it } from 'vitest';
import {
  AGENT_INSTALL_TABLE,
  agentInstallMethod,
  agentLoginCommand,
  classifyInstallFailure,
} from '../agentInstall';

describe('bundled install table', () => {
  it('holds the vendors\' documented native installer lines, verbatim', () => {
    // A change here must come with a re-check against the source URL in agentInstall.ts.
    expect(agentInstallMethod('claude', 'darwin').command).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(agentInstallMethod('claude', 'linux').command).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(agentInstallMethod('claude', 'win32').command).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(agentInstallMethod('codex', 'darwin').command).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
    expect(agentInstallMethod('codex', 'win32').command)
      .toBe('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"');
    for (const byOs of Object.values(AGENT_INSTALL_TABLE)) {
      expect(byOs.win32.shell).toBe('powershell');
      expect(byOs.posix.shell).toBe('user');
      // No elevation anywhere: both installers write to the user's folder.
      expect(`${byOs.win32.command} ${byOs.posix.command}`).not.toMatch(/sudo|runas|-Verb/i);
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
