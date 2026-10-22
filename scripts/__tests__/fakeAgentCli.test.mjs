// The fake agents' non-interactive answers must match what the first-run
// "Agent ready" detector reads (src/main/firstRun/AgentSetupDetector.ts
// readLoginState / parseAgentVersion), or the e2e scenario's fake Claude would
// show as "sign-in needed" instead of ready.
import { describe, expect, it } from 'vitest';
import {
  FAKE_AGENT_VERSION,
  parseFakeAgentArgs,
  probeAnswer,
} from '../fixtures/fake-agents/fakeAgentCli.mjs';

describe('parseFakeAgentArgs', () => {
  it('recognises the version and sign-in probes of each CLI', () => {
    expect(parseFakeAgentArgs('claude', ['--version'])).toEqual({ kind: 'version' });
    expect(parseFakeAgentArgs('codex', ['--version'])).toEqual({ kind: 'version' });
    expect(parseFakeAgentArgs('claude', ['auth', 'status', '--json'])).toEqual({ kind: 'login-status' });
    expect(parseFakeAgentArgs('codex', ['login', 'status'])).toEqual({ kind: 'login-status' });
    // The other CLI's subcommand is just a prompt word.
    expect(parseFakeAgentArgs('codex', ['auth', 'status'])).toEqual({ kind: 'tui', prompt: 'auth' });
  });

  it('takes the first positional argument as the first prompt, skipping flag values', () => {
    expect(parseFakeAgentArgs('claude', ['Use the wmux browser_open tool'])).toEqual({ kind: 'tui', prompt: 'Use the wmux browser_open tool' });
    expect(parseFakeAgentArgs('claude', ['--session-id', '0b4a', '--dangerously-skip-permissions', 'hello'])).toEqual({ kind: 'tui', prompt: 'hello' });
    expect(parseFakeAgentArgs('claude', [])).toEqual({ kind: 'tui' });
    expect(parseFakeAgentArgs('claude', ['--model', 'opus'])).toEqual({ kind: 'tui' });
  });
});

describe('probeAnswer', () => {
  it('prints a version the detector parses', () => {
    expect(probeAnswer('claude', 'version')).toEqual({ code: 0, stdout: `${FAKE_AGENT_VERSION} (Claude Code)\n` });
    expect(probeAnswer('codex', 'version')).toEqual({ code: 0, stdout: `codex-cli ${FAKE_AGENT_VERSION}\n` });
  });

  it('answers claude auth status as Claude Code does: JSON loggedIn, exit 0 / 1', () => {
    const signedIn = probeAnswer('claude', 'login-status', {});
    expect(signedIn.code).toBe(0);
    expect(JSON.parse(signedIn.stdout).loggedIn).toBe(true);
    const signedOut = probeAnswer('claude', 'login-status', { FAKE_CLAUDE_SIGNED_OUT: '1' });
    expect(signedOut.code).toBe(1);
    expect(JSON.parse(signedOut.stdout).loggedIn).toBe(false);
  });

  it('answers codex login status by exit code, with the fixed signed-out line', () => {
    expect(probeAnswer('codex', 'login-status', {}).code).toBe(0);
    const out = probeAnswer('codex', 'login-status', { FAKE_CODEX_SIGNED_OUT: '1' });
    expect(out.code).toBe(1);
    expect(out.stdout.toLowerCase()).toContain('not logged in');
  });
});
