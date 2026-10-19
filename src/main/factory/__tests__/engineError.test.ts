import { describe, expect, it } from 'vitest';
import { classifyEngineError } from '../engineError';

describe('classifyEngineError', () => {
  it('maps known engine_unavailable messages', () => {
    expect(classifyEngineError('Claude Code is not installed (no claude executable found)')).toBe('not_installed');
    expect(classifyEngineError('the wmux MCP bundle was not found, so the bot would have no tools')).toBe('mcp_missing');
    expect(classifyEngineError('ACP engines run bots only in a test build of wmux in this version; switch this bot to Claude (SDK) in its profile')).toBe('acp_test_only');
    expect(classifyEngineError('Claude is installed but could not run (claude --version exited 127).')).toBe('unusable');
    expect(classifyEngineError('Claude Code is not signed in.')).toBe('not_logged_in');
  });

  it('maps the setup failures the SDK adapter reports during a turn', () => {
    expect(classifyEngineError('Not logged in · Please run /login')).toBe('not_logged_in');
    expect(classifyEngineError('Failed to spawn Claude Code process: spawn EACCES')).toBe('unusable');
    expect(classifyEngineError('Claude Code native binary at /opt/claude exists but failed to launch. This usually means the binary does not match this system')).toBe('unusable');
    expect(classifyEngineError('Claude Code executable not found at /usr/local/bin/claude. Is options.pathToClaudeCodeExecutable set?')).toBe('not_installed');
  });

  it('unknown text is other', () => {
    expect(classifyEngineError('something else went wrong')).toBe('other');
    expect(classifyEngineError('')).toBe('other');
  });
});
