#!/usr/bin/env node
// acp-stub: a scripted ACP agent for factory smokes (no model, no cost).
//
// Speaks ACP over stdio (newline-delimited JSON-RPC) the way AcpBrainAdapter
// drives an agent: initialize, session/new, session/load, session/prompt,
// session/cancel. On each prompt it plays one turn of a JSON script: calls
// wmux MCP tools through the MCP server it was handed in session/new|load
// `mcpServers` (spawned as given: command, args, env), waits, and says text.
// It never runs a shell or touches files besides its optional log.
//
//   node scripts/acp-stub.mjs --script <file.json> [--log <file.jsonl>]
//   (or WMUX_ACP_STUB_SCRIPT / WMUX_ACP_STUB_LOG)
//
// Script:
//   {
//     "failLoad": false,            // true: session/load answers an error (forces a fresh session)
//     "turns": [                    // turn i plays on the i-th prompt; the last turn repeats
//       { "steps": [
//         { "tool": "pr_read", "args": { "prNumber": 12 },
//           "expect": "\"ok\":true",                   // optional: result text must contain this, else the turn stops
//           "save": { "head": "\"headSha\":\"([0-9a-f]{40})\"" } },  // optional: regex group 1 → {{head}}
//         { "sleep": 1000 },
//         { "waitFor": { "tool": "fact_poll", "args": { "kinds": ["task.done"], "since_seq": 0 },
//                        "match": "task.done", "timeoutMs": 600000, "everyMs": 5000 } },
//         { "capture": { "task": "\"taskId\": \"(wtask-[^\"]+)\"" } },  // regex group 1 of the prompt → {{task}}
//         { "say": "verdict recorded for {{head}}" }
//       ] }
//     ]
//   }
// Strings in `args` and `say` substitute {{name}} from `save` and `capture`
// captures and {{prompt}} (the prompt's text). A failed step (a `capture`
// that does not match counts) ends the turn with a "stub: ..." message and
// stopReason end_turn.
//
// Log (one JSON line per event, also mirrored to stderr as `[acp-stub] ...`):
// {at, event: 'initialize'|'session/new'|'session/load'|'prompt'|'tool'|'cancel'|'error', ...}.
// The factory smokes read it to assert which path was taken (load vs new).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const scriptPath = argValue('--script') ?? process.env.WMUX_ACP_STUB_SCRIPT;
const logPath = argValue('--log') ?? process.env.WMUX_ACP_STUB_LOG;

function record(event, data = {}) {
  const line = { at: Date.now(), event, ...data };
  process.stderr.write(`[acp-stub] ${event} ${JSON.stringify(data).slice(0, 600)}\n`);
  if (logPath) {
    try {
      fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`);
    } catch {
      // the log is evidence, never a reason to fail the turn
    }
  }
}

let script = { turns: [] };
try {
  if (scriptPath) script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
} catch (err) {
  record('error', { message: `script unreadable: ${String(err)}` });
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── MCP client (one per session, spawned on the first tool step) ───────────

function mcpClient(server) {
  const env = { ...process.env };
  for (const e of server.env ?? []) env[e.name] = e.value;
  const child = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  });
  child.on('exit', () => {
    for (const p of pending.values()) p({ error: { message: 'mcp server exited' } });
    pending.clear();
  });
  const request = (method, params, timeoutMs = 700_000) => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: { message: `mcp timeout: ${method}` } });
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const ready = request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wmux-acp-stub', version: '1' },
  }).then((r) => {
    if (r.error) throw new Error(`mcp initialize failed: ${r.error.message}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  });
  return {
    async call(name, args) {
      await ready;
      const r = await request('tools/call', { name, arguments: args ?? {} });
      if (r.error) return { ok: false, text: r.error.message ?? 'error' };
      const text = (r.result?.content ?? []).map((c) => c.text ?? '').join('\n');
      return { ok: !r.result?.isError, text };
    },
    close() {
      child.kill();
    },
  };
}

// ── sessions and turns ─────────────────────────────────────────────────────

const sessions = new Map(); // sessionId → { servers, mcp, turn, run }

function openSession(sessionId, params) {
  const prev = sessions.get(sessionId);
  prev?.mcp?.close();
  if (prev?.run) prev.run.cancelled = true;
  sessions.set(sessionId, { servers: params?.mcpServers ?? [], mcp: null, turn: 0, run: null });
}

function fill(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

async function runTurn(sessionId, promptText) {
  const s = sessions.get(sessionId);
  const turns = Array.isArray(script.turns) ? script.turns : [];
  const turn = turns[Math.min(s.turn, turns.length - 1)] ?? { steps: [] };
  s.turn += 1;
  // Cancellation belongs to this turn of this session only: a later prompt
  // never revives a cancelled turn.
  if (s.run) s.run.cancelled = true;
  const run = { cancelled: false };
  s.run = run;
  const vars = { prompt: promptText };
  const update = (u) => send({ method: 'session/update', params: { sessionId, update: u } });
  const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const tool = async (name, args) => {
    if (!s.mcp) {
      const server = s.servers.find((m) => m.name === 'wmux') ?? s.servers[0];
      if (!server) return { ok: false, text: 'no MCP server was handed to this session' };
      s.mcp = mcpClient(server);
    }
    const toolCallId = `stub-${crypto.randomBytes(4).toString('hex')}`;
    update({ sessionUpdate: 'tool_call', toolCallId, title: `wmux ${name}`, kind: 'other', status: 'pending' });
    const r = await s.mcp.call(name, args).catch((err) => ({ ok: false, text: String(err) }));
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: r.ok ? 'completed' : 'failed' });
    record('tool', { sessionId, name, ok: r.ok, text: r.text.slice(0, 2000) });
    return r;
  };
  for (const [i, step] of (turn.steps ?? []).entries()) {
    if (run.cancelled) return 'cancelled';
    if (typeof step.sleep === 'number') {
      await sleep(step.sleep);
    } else if (typeof step.say === 'string') {
      say(fill(step.say, vars));
    } else if (step.capture && typeof step.capture === 'object') {
      for (const [name, pattern] of Object.entries(step.capture)) {
        const m = new RegExp(pattern).exec(promptText);
        if (!m) {
          say(`stub: step ${i} found no ${name} in the prompt`);
          return 'end_turn';
        }
        vars[name] = m[1] ?? m[0];
      }
    } else if (typeof step.tool === 'string') {
      const r = await tool(step.tool, fill(step.args ?? {}, vars));
      if (!r.ok || (step.expect && !r.text.includes(step.expect))) {
        say(`stub: step ${i} (${step.tool}) did not succeed: ${r.text.slice(0, 500)}`);
        return 'end_turn';
      }
      for (const [name, pattern] of Object.entries(step.save ?? {})) {
        const m = new RegExp(pattern).exec(r.text);
        if (m) vars[name] = m[1] ?? m[0];
      }
    } else if (step.waitFor && typeof step.waitFor.tool === 'string') {
      const w = step.waitFor;
      const deadline = Date.now() + (w.timeoutMs ?? 600_000);
      let met = false;
      while (!met && !run.cancelled && Date.now() < deadline) {
        const r = await tool(w.tool, fill(w.args ?? {}, vars));
        met = r.ok && (!w.match || r.text.includes(w.match));
        if (!met) await sleep(w.everyMs ?? 5_000);
      }
      if (!met) {
        say(`stub: step ${i} waited for ${w.tool} and gave up`);
        return run.cancelled ? 'cancelled' : 'end_turn';
      }
    }
  }
  return run.cancelled ? 'cancelled' : 'end_turn';
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      record('initialize');
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
      return;
    case 'session/new': {
      const sessionId = `stub-${crypto.randomBytes(6).toString('hex')}`;
      openSession(sessionId, params);
      record('session/new', { sessionId, cwd: params?.cwd });
      send({ id, result: { sessionId } });
      return;
    }
    case 'session/load':
      record('session/load', { sessionId: params?.sessionId, refused: !!script.failLoad });
      if (script.failLoad) {
        send({ id, error: { code: -32000, message: 'unknown session' } });
        return;
      }
      openSession(params?.sessionId, params);
      send({ id, result: {} });
      return;
    case 'session/prompt': {
      const sessionId = params?.sessionId;
      if (!sessions.has(sessionId)) {
        send({ id, error: { code: -32000, message: 'unknown session' } });
        return;
      }
      const promptText = (params?.prompt ?? []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
      // The log keeps the whole wake block (graders read what a turn was
      // shown); stderr keeps a short line.
      record('prompt', { sessionId, text: promptText.slice(0, 32_000) });
      void runTurn(sessionId, promptText)
        .then((stopReason) => send({ id, result: { stopReason } }))
        .catch((err) => {
          record('error', { message: String(err) });
          send({ id, result: { stopReason: 'end_turn' } });
        });
      return;
    }
    case 'session/cancel':
      record('cancel', { sessionId: params?.sessionId });
      if (sessions.get(params?.sessionId)?.run) sessions.get(params?.sessionId).run.cancelled = true;
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});

process.stdin.on('end', () => {
  for (const s of sessions.values()) s.mcp?.close();
  process.exit(0);
});
