// The fake Claude (scripts/fixtures/fake-agents/claude.mjs) under the real
// Claude Agent SDK: query() spawns it the way main's ClaudeSdkAdapter runs a
// bot turn, and the turn completes with the fake's answer. This is what lets
// the first-run e2e (scripts/e2e-first-run.mjs) reach the bot's first answer
// without a model, an account or the network.
// @wmux-lane integration
// query() spawns the fake as a real child process through the SDK's own
// child_process import, which the lane rule cannot see.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-agents', 'claude.mjs');

function readLog(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('fake claude under the Agent SDK', () => {
  it('completes a query() turn: handshake, init with the wmux server, the fixed answer, a success result', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-sdk-'));
    const log = path.join(dir, 'fake.jsonl');
    try {
      const prompt = 'Explain what this repository does, in three sentences please';
      const frames = [];
      const q = query({
        prompt,
        options: {
          pathToClaudeCodeExecutable: FAKE,
          cwd: dir,
          mcpServers: { wmux: { type: 'stdio', command: 'node', args: [path.join(dir, 'never-started.js')] } },
          allowedTools: ['mcp__wmux__room_post'],
          settingSources: [],
          env: { ...process.env, FAKE_AGENT_LOG: log },
        },
      });
      for await (const m of q) frames.push(m);
      expect(frames.map((m) => m.type)).toEqual(['system', 'assistant', 'result']);
      expect(frames[0].mcp_servers).toEqual([{ name: 'wmux', status: 'connected' }]);
      expect(frames[1].message.content[0].text).toBe(`Fake answer: ${prompt}`);
      expect(frames[2]).toMatchObject({ subtype: 'success', is_error: false, result: `Fake answer: ${prompt}` });
      const events = readLog(log);
      expect(events.map((e) => e.event)).toEqual(['sdk-start', 'sdk-control', 'sdk-prompt', 'sdk-answer', 'sdk-end']);
      expect(events.find((e) => e.event === 'sdk-prompt').prompt).toBe(prompt);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
