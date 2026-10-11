// The bundled wmux MCP server over stdio, as an agent CLI would start it, with
// a ledger of every tool call and the size of what came back.
//
// Run it from inside a wmux pane: the server resolves its caller by walking
// up the process tree to the pane's shell, so the calls carry that pane's
// identity exactly as a real agent's do.
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from './lib.mjs';

const BUNDLE = path.join(ROOT, 'dist', 'mcp-bundle', 'index.js');
const TIMEOUT = 60_000;

/** The text an agent reads from a tool result: every text block, joined. */
export const textOf = (res) => (res?.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');

export async function connectWmuxMcp(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: TIMEOUT });
  /** One entry per tool call: name and the characters the caller received. */
  const calls = [];
  return {
    calls,
    async tools() {
      return (await client.listTools(undefined, { timeout: TIMEOUT })).tools.map((t) => t.name);
    },
    async call(tool, args = {}) {
      const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: TIMEOUT });
      const text = textOf(res);
      calls.push({ tool, chars: text.length });
      return { text, json: jsonOf(res), isError: res?.isError === true };
    },
    close: () => client.close(),
  };
}

/** The result's JSON body: its last text block (the fan-out tool puts WARNING blocks first). */
function jsonOf(res) {
  const blocks = (res?.content ?? []).filter((c) => typeof c.text === 'string');
  if (blocks.length === 0) return null;
  try {
    return JSON.parse(blocks[blocks.length - 1].text);
  } catch {
    return null;
  }
}
