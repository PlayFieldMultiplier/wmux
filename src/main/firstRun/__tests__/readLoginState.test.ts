import { describe, expect, it } from 'vitest';
import { readLoginState, type ProbeResult } from '../AgentSetupDetector';

const result = (over: Partial<ProbeResult>): ProbeResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });

// Only the agent's own definite "signed out" may block a scheduled run; every
// other outcome of the status command is "cannot tell" (null) and lets it run.
describe('readLoginState', () => {
  it('reads Claude as signed out only from loggedIn:false with exit 1', () => {
    expect(readLoginState('claude', result({ code: 1, stdout: '{"loggedIn":false}' }))).toBe(false);
    expect(readLoginState('claude', result({ code: 0, stdout: '{"loggedIn":true}' }))).toBe(true);
    expect(readLoginState('claude', result({ code: 2, stdout: '{"loggedIn":false}' }))).toBeNull();
    expect(readLoginState('claude', result({ code: 1, stdout: 'Error: network' }))).toBeNull();
    expect(readLoginState('claude', result({ code: null, timedOut: true }))).toBeNull();
  });

  it("reads Codex as signed out only from exit 1 with its own signed-out line", () => {
    expect(readLoginState('codex', result({ code: 1, stderr: 'Not logged in' }))).toBe(false);
    expect(readLoginState('codex', result({ code: 0, stdout: 'Logged in using ChatGPT' }))).toBe(true);
    expect(readLoginState('codex', result({ code: 1, stderr: 'error: config is invalid' }))).toBeNull();
    expect(readLoginState('codex', result({ code: 127 }))).toBeNull();
  });

  it('cannot tell for an agent without a status command', () => {
    expect(readLoginState('grok', result({ code: 1 }))).toBeNull();
  });
});
