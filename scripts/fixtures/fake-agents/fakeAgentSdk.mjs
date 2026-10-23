// The fake Claude's Agent SDK side: what `claude --output-format stream-json
// --input-format stream-json --verbose …` does when the Claude Agent SDK
// (`query()`, as main's ClaudeSdkAdapter runs a bot turn) spawns it.
//
// Protocol, as @anthropic-ai/claude-agent-sdk 0.3.x speaks it over stdio
// (one JSON object per line each way):
//   - the SDK sends `control_request`s (`initialize` first) and waits for a
//     `control_response` with the same request_id: answered with success
//     (initialize with an empty command/model/agent list);
//   - each `user` message is one turn: a `system`/`init` frame (once per
//     process), one `assistant` message with the fixed answer
//     `Fake answer: <first 60 chars of the prompt>`, and a `result` success;
//   - stdin ending (the SDK closes it after the first result of a one-prompt
//     query) ends the process with code 0.
// The init frame lists every server of `--mcp-config` and every in-process
// server `initialize` names as connected, and the `--allowedTools` as the
// session's tools, so main's bot tool guard
// (src/main/deck/botToolGuard.ts) sees a session with its wmux tools. No
// tool is ever called, no MCP server started, nothing read or written but
// FAKE_AGENT_LOG: the bot's answer reaches its room as the turn's closing
// text (BotRuntime postTurnText).
//
// createSdkSession is pure (lines in, frames out) for
// scripts/__tests__/fakeAgentCli.test.mjs; runFakeSdk is the stdio loop.

import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { FAKE_AGENT_VERSION } from './fakeAgentCli.mjs';

/** How much of the prompt the answer repeats. */
export const FAKE_ANSWER_PROMPT_CHARS = 60;

/** The fixed answer to a prompt. */
export function fakeAnswer(prompt) {
  return `Fake answer: ${String(prompt).replace(/\s+/g, ' ').trim().slice(0, FAKE_ANSWER_PROMPT_CHARS)}`;
}

/** A user message's text: a string, or its text blocks joined. */
function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * One SDK session. `sdk` is parseFakeAgentArgs' `{ kind: 'sdk', … }`.
 * `handle(line)` returns `{ out, logs }`: the frames to write, in order, and
 * the `[event, fields]` pairs to log. Unknown or malformed lines produce
 * nothing (the real CLI ignores what it does not know as well).
 */
export function createSdkSession(sdk, { cwd = '/', newId = randomUUID } = {}) {
  const sessionId = sdk.sessionId || newId();
  let initSent = false;
  let turns = 0;
  let sdkMcpServers = [];

  const initFrame = () => ({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: FAKE_AGENT_VERSION,
    cwd,
    tools: [...sdk.tools],
    mcp_servers: [...sdk.mcpServers, ...sdkMcpServers].map((name) => ({ name, status: 'connected' })),
    model: sdk.model || 'fake-model',
    permissionMode: sdk.permissionMode || 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: newId(),
    session_id: sessionId,
  });

  function onControl(msg) {
    const subtype = msg.request?.subtype;
    if (subtype === 'initialize' && Array.isArray(msg.request.sdkMcpServers)) {
      sdkMcpServers = msg.request.sdkMcpServers.filter((n) => typeof n === 'string');
    }
    const response = subtype === 'initialize'
      ? { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} }
      : {};
    return {
      out: [{ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } }],
      logs: [['sdk-control', { subtype: subtype ?? null }]],
    };
  }

  function onUser(msg) {
    if (msg.shouldQuery === false) return { out: [], logs: [] };
    const prompt = promptText(msg.message?.content);
    const text = fakeAnswer(prompt);
    turns += 1;
    const out = [];
    if (!initSent) {
      initSent = true;
      out.push(initFrame());
    }
    out.push({
      type: 'assistant',
      message: {
        id: `msg_fake_${turns}`,
        type: 'message',
        role: 'assistant',
        model: sdk.model || 'fake-model',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: newId(),
      session_id: sessionId,
    });
    out.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: 1,
      result: text,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: newId(),
      session_id: sessionId,
    });
    return {
      out,
      logs: [['sdk-prompt', { sessionId, prompt }], ['sdk-answer', { sessionId, text }]],
    };
  }

  return {
    sessionId,
    handle(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return { out: [], logs: [] };
      }
      if (msg?.type === 'control_request') return onControl(msg);
      if (msg?.type === 'user') return onUser(msg);
      return { out: [], logs: [] };
    },
  };
}

/** Run the session over this process's stdin and stdout until stdin ends. */
export function runFakeSdk(sdk, log) {
  const session = createSdkSession(sdk, { cwd: process.cwd() });
  log('sdk-start', { sessionId: session.sessionId, resume: sdk.resume ?? null, mcpServers: sdk.mcpServers, cwd: process.cwd() });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const { out, logs } = session.handle(line);
    for (const [event, fields] of logs) log(event, fields);
    for (const frame of out) process.stdout.write(`${JSON.stringify(frame)}\n`);
  });
  rl.on('close', () => {
    log('sdk-end', { sessionId: session.sessionId });
    process.exitCode = 0;
  });
}
