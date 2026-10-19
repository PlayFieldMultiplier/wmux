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

  it('unknown text is other', () => {
    expect(classifyEngineError('something else went wrong')).toBe('other');
    expect(classifyEngineError('')).toBe('other');
  });
});
