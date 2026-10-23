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
import { createSdkSession, fakeAnswer } from '../fixtures/fake-agents/fakeAgentSdk.mjs';

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

// The flags and stdio frames of @anthropic-ai/claude-agent-sdk's
// ProcessTransport / Query (0.3.x). A full query() against the fake runs in
// fakeClaudeSdk.os.test.mjs.
const SDK_FLAGS = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];

describe('parseFakeAgentArgs: an Agent SDK spawn', () => {
  it('enters SDK mode on --output-format stream-json and reads the servers, tools and session', () => {
    const parsed = parseFakeAgentArgs('claude', [
      ...SDK_FLAGS,
      '--model', 'opus',
      '--allowedTools', 'mcp__wmux__room_post,Read',
      '--mcp-config', JSON.stringify({ mcpServers: { wmux: { type: 'stdio', command: 'node', args: ['x.js'] } } }),
      '--setting-sources=',
      '--permission-mode', 'default',
      '--resume', 'abc-123',
    ]);
    expect(parsed).toEqual({
      kind: 'sdk',
      mcpServers: ['wmux'],
      tools: ['mcp__wmux__room_post', 'Read'],
      model: 'opus',
      permissionMode: 'default',
      sessionId: 'abc-123',
      resume: 'abc-123',
    });
  });

  it('never takes the output format for a prompt, and leaves codex and text output alone', () => {
    expect(parseFakeAgentArgs('claude', SDK_FLAGS).kind).toBe('sdk');
    expect(parseFakeAgentArgs('claude', ['--output-format', 'text', 'hi'])).toEqual({ kind: 'tui', prompt: 'text' });
    expect(parseFakeAgentArgs('codex', SDK_FLAGS).kind).toBe('tui');
  });
});

describe('createSdkSession', () => {
  const sdk = parseFakeAgentArgs('claude', [...SDK_FLAGS, '--allowedTools', 'mcp__wmux__room_post', '--mcp-config', '{"mcpServers":{"wmux":{}}}']);
  let n = 0;
  const newId = () => `id-${++n}`;

  it('answers initialize with a success carrying its request_id', () => {
    const s = createSdkSession(sdk, { newId });
    const { out } = s.handle(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'initialize', sdkMcpServers: ['wmux_git'] } }));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('control_response');
    expect(out[0].response).toMatchObject({ subtype: 'success', request_id: 'r1', response: { commands: [], models: [] } });
    // Any other control request is acknowledged too (interrupt, set_model …).
    expect(s.handle(JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'interrupt' } })).out[0].response)
      .toEqual({ subtype: 'success', request_id: 'r2', response: {} });
  });

  it('turns each user message into init (once), the fixed answer and a success result', () => {
    const s = createSdkSession(sdk, { newId, cwd: '/repo' });
    s.handle(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'initialize', sdkMcpServers: ['wmux_git'] } }));
    const prompt = 'Explain what this repository does and how its parts fit together, briefly';
    const first = s.handle(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null }));
    expect(first.out.map((f) => `${f.type}/${f.subtype ?? ''}`)).toEqual(['system/init', 'assistant/', 'result/success']);
    const [init, assistant, result] = first.out;
    // What main's bot tool guard needs to see a session with its wmux tools.
    expect(init.mcp_servers).toEqual([{ name: 'wmux', status: 'connected' }, { name: 'wmux_git', status: 'connected' }]);
    expect(init.tools).toEqual(['mcp__wmux__room_post']);
    expect(init.cwd).toBe('/repo');
    expect(assistant.message.content).toEqual([{ type: 'text', text: fakeAnswer(prompt) }]);
    expect(fakeAnswer(prompt)).toBe(`Fake answer: ${prompt.slice(0, 60)}`);
    expect(result).toMatchObject({ is_error: false, result: fakeAnswer(prompt), session_id: s.sessionId });
    expect(first.logs.map(([e]) => e)).toEqual(['sdk-prompt', 'sdk-answer']);
    expect(first.logs[0][1].prompt).toBe(prompt);
    const second = s.handle(JSON.stringify({ type: 'user', message: { role: 'user', content: 'again' }, parent_tool_use_id: null }));
    expect(second.out.map((f) => f.type)).toEqual(['assistant', 'result']);
  });

  it('ignores what is not a turn: shouldQuery false, keep_alive, and malformed lines', () => {
    const s = createSdkSession(sdk, { newId });
    expect(s.handle(JSON.stringify({ type: 'user', shouldQuery: false, message: { role: 'user', content: 'x' } })).out).toEqual([]);
    expect(s.handle(JSON.stringify({ type: 'keep_alive' })).out).toEqual([]);
    expect(s.handle('not json').out).toEqual([]);
  });
});
