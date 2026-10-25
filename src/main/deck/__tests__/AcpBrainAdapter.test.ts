import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpBrainAdapter, type AcpHermesPolicy } from '../AcpBrainAdapter';
import { HERMES_MCP_MISSING_LEAD, HERMES_TOOLS_CHANGED_LEAD } from '../../factory/engineError';
import { commanderTokenWorkspace } from '../commanderTrust';
import type { BrainEvent } from '../BrainAdapter';

// ── fake ACP agent over fake stdio ──────────────────────────────────────────
// Mirrors the ClaudeSdkAdapter test philosophy: drive the adapter's REAL wire
// plumbing (ndjson framing, request/response correlation, notification
// routing) against a scripted agent, no live subprocess.

interface Sent {
  msg: Record<string, unknown>;
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  sent: Sent[] = [];
  private responder: (msg: Record<string, unknown>) => void;
  stdin = {
    write: (line: string) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      this.sent.push({ msg });
      // Respond on a microtask so the adapter's await sequencing is realistic.
      queueMicrotask(() => this.responder(msg));
      return true;
    },
  };

  constructor(responder: (child: FakeChild, msg: Record<string, unknown>) => void) {
    super();
    this.responder = (msg) => responder(this, msg);
  }

  emitLine(obj: Record<string, unknown>): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0);
    return true;
  }
}

/** A standard scripted agent: answers initialize/session lifecycle, and for
 *  session/prompt emits the given updates before resolving the prompt. */
function scriptedAgent(opts?: {
  updates?: Array<Record<string, unknown>>;
  stopReason?: string;
  usage?: Record<string, unknown>;
  failLoad?: boolean;
}): { spawnFn: () => ChildProcessWithoutNullStreams; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn = () => {
    const child = new FakeChild((c, msg) => {
      const id = msg.id as number;
      switch (msg.method) {
        case 'initialize':
          c.emitLine({ jsonrpc: '2.0', id, result: { protocolVersion: 1, authMethods: [] } });
          return;
        case 'session/load':
          if (opts?.failLoad) c.emitLine({ jsonrpc: '2.0', id, error: { code: -32000, message: 'unknown session' } });
          else c.emitLine({ jsonrpc: '2.0', id, result: {} });
          return;
        case 'session/new':
          c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 'acp-sess-1' } });
          return;
        case 'session/prompt': {
          const sessionId = (msg.params as Record<string, unknown>).sessionId;
          for (const u of opts?.updates ?? []) {
            c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
          }
          c.emitLine({
            jsonrpc: '2.0',
            id,
            result: { stopReason: opts?.stopReason ?? 'end_turn', ...(opts?.usage ? { usage: opts.usage } : {}) },
          });
          return;
        }
        default:
          c.emitLine({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown' } });
      }
    });
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnFn, children };
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const SPEC = { command: 'hermes', args: ['acp'] };

describe('AcpBrainAdapter', () => {
  it('runs a full turn: updates map to the 5-event vocabulary, prompt response ends the turn', async () => {
    const { spawnFn } = scriptedAgent({
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'hi ' }] },
        { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'wmux pane_list', kind: 'other' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' },
        { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'done' }] },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({ systemPrompt: 'SYS' });
    const events = await collect(adapter.send('go'));
    expect(events.map((e) => e.type)).toEqual([
      'text-delta',
      'tool-start',
      'tool-end',
      'text-delta',
      'turn-end',
    ]);
    const toolEnd = events[2] as Extract<BrainEvent, { type: 'tool-end' }>;
    expect(toolEnd.name).toBe('wmux pane_list');
    expect(toolEnd.ok).toBe(true);
    const end = events[4] as Extract<BrainEvent, { type: 'turn-end' }>;
    expect(end.sessionId).toBe('acp-sess-1');
    expect(end.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    adapter.dispose();
  });

  it('injects the wmux MCP server per session with --commander arg + token env (P4)', async () => {
    const { spawnFn, children } = scriptedAgent();
    const adapter = new AcpBrainAdapter({
      spawnSpec: SPEC, newSessionSettleMs: 0,
      workspaceId: 'ws-1',
      mcpBundlePath: '/fake/mcp.js',
      spawnFn,
    });
    adapter.start({});
    await collect(adapter.send('go'));
    const sessionNew = children[0].sent.find((s) => s.msg.method === 'session/new');
    const servers = (sessionNew?.msg.params as Record<string, unknown>).mcpServers as Array<
      Record<string, unknown>
    >;
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('wmux');
    expect(servers[0].args).toEqual(['/fake/mcp.js', '--commander']);
    const env = servers[0].env as Array<{ name: string; value: string }>;
    const token = env.find((e) => e.name === 'WMUX_COMMANDER_TOKEN')?.value ?? '';
    expect(token.length).toBeGreaterThanOrEqual(64);
    // The injected token is LIVE and bound to this adapter's workspace.
    expect(commanderTokenWorkspace(token)).toBe('ws-1');
    adapter.dispose();
    // Dispose revokes it — the child's straggling RPCs fail closed (P4).
    expect(commanderTokenWorkspace(token)).toBeNull();
  });

  it('system prompt + fleet context ride the FIRST prompt only', async () => {
    const { spawnFn, children } = scriptedAgent();
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({ systemPrompt: 'SYS', fleetContext: 'FLEET' });
    await collect(adapter.send('first'));
    await collect(adapter.send('second'));
    const prompts = children[0].sent
      .filter((s) => s.msg.method === 'session/prompt')
      .map((s) => ((s.msg.params as Record<string, unknown>).prompt as Array<{ text: string }>)[0].text);
    expect(prompts[0]).toContain('SYS');
    expect(prompts[0]).toContain('FLEET');
    expect(prompts[0]).toContain('first');
    expect(prompts[1]).toBe('second');
    adapter.dispose();
  });

  it('resumes via session/load, and falls back to a fresh session on a dead id', async () => {
    const ok = scriptedAgent();
    const a1 = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: ok.spawnFn });
    a1.start({ resumeSessionId: 'persisted-1' });
    await collect(a1.send('go'));
    const loads = ok.children[0].sent.filter((s) => s.msg.method === 'session/load');
    expect(loads).toHaveLength(1);
    expect((loads[0].msg.params as Record<string, unknown>).sessionId).toBe('persisted-1');
    expect(a1.sessionId).toBe('persisted-1');
    a1.dispose();

    const dead = scriptedAgent({ failLoad: true });
    const a2 = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: dead.spawnFn });
    a2.start({ resumeSessionId: 'gc-ed' });
    const events = await collect(a2.send('go'));
    expect(events.at(-1)?.type).toBe('turn-end');
    expect(a2.sessionId).toBe('acp-sess-1'); // fresh session, turn not bricked
    a2.dispose();
  });

  it('a refusal stop reason surfaces as an error event (no turn-end)', async () => {
    const { spawnFn } = scriptedAgent({ stopReason: 'refusal' });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    const events = await collect(adapter.send('go'));
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some((e) => e.type === 'turn-end')).toBe(false);
    adapter.dispose();
  });

  it('loads a persisted session ONCE per child — later sends skip session/load (Codex P2)', async () => {
    const { spawnFn, children } = scriptedAgent();
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({ resumeSessionId: 'persisted-1' });
    await collect(adapter.send('one'));
    await collect(adapter.send('two'));
    await collect(adapter.send('three'));
    // Re-loading every turn replays the whole transcript on some agents —
    // latency would grow with history.
    expect(children[0].sent.filter((s) => s.msg.method === 'session/load')).toHaveLength(1);
    expect(children[0].sent.filter((s) => s.msg.method === 'session/prompt')).toHaveLength(3);
    adapter.dispose();
  });

  it('retries once on a fresh session when an UNVALIDATED resume dies at prompt time (Codex P2)', async () => {
    // Agent reports the unknown persisted id as a SUCCESSFUL empty load, then
    // errors the prompt — the adapter must drop the dead id and retry fresh.
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        if (msg.method === 'initialize') c.emitLine({ jsonrpc: '2.0', id, result: {} });
        else if (msg.method === 'session/load') c.emitLine({ jsonrpc: '2.0', id, result: {} }); // "success"
        else if (msg.method === 'session/new') c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 'fresh-1' } });
        else if (msg.method === 'session/prompt') {
          const sid = (msg.params as Record<string, unknown>).sessionId;
          if (sid === 'gc-ed') c.emitLine({ jsonrpc: '2.0', id, error: { code: -32000, message: 'unknown session' } });
          else {
            c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'ok' }] } } });
            c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          }
        }
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({ resumeSessionId: 'gc-ed' });
    const events = await collect(adapter.send('go'));
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'turn-end']);
    expect(adapter.sessionId).toBe('fresh-1');
    adapter.dispose();
  });

  it('correlates a response even when the agent echoes `method` on it (GLM P2)', async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        // Echo the method on every response — still a response, not a
        // notification.
        if (msg.method === 'initialize') c.emitLine({ jsonrpc: '2.0', id, method: 'initialize', result: {} });
        else if (msg.method === 'session/new') c.emitLine({ jsonrpc: '2.0', id, method: 'session/new', result: { sessionId: 's' } });
        else if (msg.method === 'session/prompt') c.emitLine({ jsonrpc: '2.0', id, method: 'session/prompt', result: { stopReason: 'end_turn' } });
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    const events = await collect(adapter.send('go'));
    expect(events.at(-1)?.type).toBe('turn-end');
    adapter.dispose();
  });

  it('reassembles ndjson lines split across stdout chunks (framing edge)', async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        if (msg.method === 'initialize') {
          // Split the response across two data events, plus two messages in
          // one chunk later.
          const line = JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n';
          c.stdout.emit('data', Buffer.from(line.slice(0, 10)));
          c.stdout.emit('data', Buffer.from(line.slice(10)));
        } else if (msg.method === 'session/new') {
          const l1 = JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 's' } });
          c.stdout.emit('data', Buffer.from(l1 + '\n'));
        } else if (msg.method === 'session/prompt') {
          const sid = (msg.params as Record<string, unknown>).sessionId;
          const upd = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'hi' }] } } });
          const res = JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          c.stdout.emit('data', Buffer.from(upd + '\n' + res + '\n')); // two lines, one chunk
        }
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    const events = await collect(adapter.send('go'));
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'turn-end']);
    adapter.dispose();
  });

  it('DENIES session/request_permission — a headless commander has no consenting human (Codex P1)', async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        if (msg.method === 'initialize') c.emitLine({ jsonrpc: '2.0', id, result: {} });
        else if (msg.method === 'session/new') c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 's' } });
        else if (msg.method === 'session/prompt') {
          // Agent asks permission mid-turn, then finishes.
          c.emitLine({
            jsonrpc: '2.0',
            id: 'agent-req-1',
            method: 'session/request_permission',
            params: { options: [{ optionId: 'opt-allow', kind: 'allow_once' }, { optionId: 'opt-deny', kind: 'reject_once' }] },
          });
          c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    await collect(adapter.send('go'));
    const reply = children[0].sent.find((s) => s.msg.id === 'agent-req-1');
    // The agent asks permission precisely when IT considers the action
    // dangerous; a blanket allow would hand pane-output prompt injection the
    // agent's native shell. Deny is the only fail-closed answer.
    expect((reply?.msg.result as Record<string, unknown>).outcome).toEqual({
      outcome: 'selected',
      optionId: 'opt-deny',
    });
    adapter.dispose();
  });

  it('agent process death mid-turn surfaces as an error event, not a hang', async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        if (msg.method === 'initialize') c.emitLine({ jsonrpc: '2.0', id, result: {} });
        else if (msg.method === 'session/new') c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 's' } });
        else if (msg.method === 'session/prompt') c.kill(); // crash mid-turn
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    const events = await collect(adapter.send('go'));
    expect(events.at(-1)?.type).toBe('error');
    adapter.dispose();
  });

  it('interrupt sends the session/cancel notification', async () => {
    const { spawnFn, children } = scriptedAgent();
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    await collect(adapter.send('go'));
    adapter.interrupt();
    const cancel = children[0].sent.find((s) => s.msg.method === 'session/cancel');
    expect(cancel).toBeTruthy();
    expect((cancel?.msg.params as Record<string, unknown>).sessionId).toBe('acp-sess-1');
    expect(cancel?.msg.id).toBeUndefined(); // notification, not a request
    adapter.dispose();
  });

  it('send after dispose yields a terminal error', async () => {
    const { spawnFn } = scriptedAgent();
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    adapter.dispose();
    const events = await collect(adapter.send('go'));
    expect(events).toEqual([{ type: 'error', message: 'commander session disposed' }]);
  });
});

// ── the Hermes preset ───────────────────────────────────────────────────────

const HERMES_TOOLS_OK = 'Available tools (2):\n  web: web_search\n  mcp-wmux: mcp__editor_wmux_ab12__room_post\n';

/** A Hermes-like agent: `/tools` answers from `tools`; any other prompt runs
 *  `onPrompt`, and a prompt it holds ends `cancelled` on session/cancel.
 *  `onReply` sees the adapter's answers to the agent's own requests. */
function hermesAgent(script: {
  onPrompt?: (c: FakeChild, promptId: number, sessionId: unknown) => 'hold' | void;
  onReply?: (c: FakeChild, msg: Record<string, unknown>) => void;
  tools?: string;
}): { spawnFn: () => ChildProcessWithoutNullStreams; children: FakeChild[]; prompts: () => number } {
  const children: FakeChild[] = [];
  let held: number | null = null;
  let prompts = 0;
  const spawnFn = () => {
    const child = new FakeChild((c, msg) => {
      const id = msg.id as number;
      if (msg.method === undefined) {
        script.onReply?.(c, msg);
        return;
      }
      switch (msg.method) {
        case 'initialize':
          c.emitLine({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
          return;
        case 'session/new':
          c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 'h-1' } });
          return;
        case 'session/load':
          c.emitLine({ jsonrpc: '2.0', id, result: {} });
          return;
        case 'session/cancel':
          if (held !== null) c.emitLine({ jsonrpc: '2.0', id: held, result: { stopReason: 'cancelled' } });
          held = null;
          return;
        case 'session/prompt': {
          const params = msg.params as Record<string, unknown>;
          const text = ((params.prompt as Array<Record<string, unknown>>)[0]?.text ?? '') as string;
          if (text === '/tools') {
            const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: script.tools ?? HERMES_TOOLS_OK } };
            c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update } });
            c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
            return;
          }
          prompts++;
          if (script.onPrompt?.(c, id, params.sessionId) === 'hold') held = id;
          else if (!script.onPrompt) c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          return;
        }
      }
    });
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnFn, children, prompts: () => prompts };
}

function hermesPolicy(over: Partial<AcpHermesPolicy> = {}) {
  const asks: Array<{ req: { title: string; command: string }; signal: AbortSignal; answer: (ok: boolean) => void }> = [];
  const policy: AcpHermesPolicy = {
    prepare: async () => ({ ok: true, env: { HERMES_HOME: '/r' } }),
    sessionStarted: () => null,
    askOwner: (req, signal) => new Promise<boolean>((answer) => {
      asks.push({ req, signal, answer });
    }),
    toolAllowed: (n) => n === 'web_search' || n.startsWith('mcp__editor_wmux_'),
    mcpReady: async () => true,
    unsettled: vi.fn(async () => undefined),
    ...over,
  };
  return { policy, asks };
}

const PERM_OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once' },
  { optionId: 'allow_always', kind: 'allow_always' },
  { optionId: 'deny', kind: 'reject_once' },
];
const permRequest = (id: string, toolCallId: string, kind: string, command?: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'session/request_permission',
  params: { sessionId: 'h-1', options: PERM_OPTIONS, toolCall: { toolCallId, kind, title: command ?? toolCallId, rawInput: command ? { command } : {} } },
});
const answerOf = (child: FakeChild, id: string) =>
  (child.sent.find((s) => s.msg.id === id && s.msg.method === undefined)?.msg.result as Record<string, unknown> | undefined)?.outcome;

describe('AcpBrainAdapter (Hermes preset)', () => {
  it('cards only command approvals: clarify, model confirmation and a second request are rejected at once; approve answers allow_once', async () => {
    const { policy, asks } = hermesPolicy();
    let promptId = 0;
    const agent = hermesAgent({
      onPrompt: (c, id) => {
        promptId = id;
        c.emitLine(permRequest('r-clarify', 'clarify-1', 'other'));
        c.emitLine(permRequest('r-model', 'model-confirm-1', 'other'));
        c.emitLine(permRequest('r-cmd', 'perm-check-1', 'execute', 'rm -rf build'));
        c.emitLine(permRequest('r-second', 'perm-check-2', 'execute', 'ls'));
        return 'hold';
      },
      onReply: (c, msg) => {
        if (msg.id === 'r-cmd') c.emitLine({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      },
    });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: agent.spawnFn, hermes: policy });
    adapter.start({});
    const turn = collect(adapter.send('go'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    const child = agent.children[0];
    for (const id of ['r-clarify', 'r-model', 'r-second']) expect(answerOf(child, id)).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(answerOf(child, 'r-cmd')).toBeUndefined();
    expect(asks[0].req).toEqual({ title: 'rm -rf build', command: 'rm -rf build' });
    asks[0].answer(true);
    const events = await turn;
    expect(answerOf(child, 'r-cmd')).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    expect(events.at(-1)?.type).toBe('turn-end');
    adapter.dispose();
  });

  it('a stop rejects the waiting request, cancels the turn and lets it settle; dispose rejects and adds no prompt', async () => {
    const { policy, asks } = hermesPolicy();
    const agent = hermesAgent({
      onPrompt: (c) => {
        c.emitLine(permRequest('r-cmd', 'perm-check-1', 'execute', 'make'));
        return 'hold';
      },
    });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: agent.spawnFn, hermes: policy });
    adapter.start({});
    const turn = collect(adapter.send('go'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    adapter.interrupt();
    const child = agent.children[0];
    expect(answerOf(child, 'r-cmd')).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(asks[0].signal.aborted).toBe(true);
    expect(child.sent.some((s) => s.msg.method === 'session/cancel')).toBe(true);
    await turn;
    // The cancelled turn ran no /tools check and no other prompt.
    expect(child.sent.filter((s) => s.msg.method === 'session/prompt')).toHaveLength(1);

    // Dispose while a request waits: rejected, the turn settles, the agent goes.
    const turn2 = collect(adapter.send('again'));
    await vi.waitFor(() => expect(asks).toHaveLength(2), { timeout: 5_000 });
    await adapter.shutdown();
    expect(answerOf(child, 'r-cmd')).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(child.sent.filter((s) => s.msg.id === 'r-cmd' && s.msg.method === undefined)).toHaveLength(2);
    expect(child.killed).toBe(true);
    expect(policy.unsettled).not.toHaveBeenCalled();
    await turn2;
    expect(agent.prompts()).toBe(2);
  });

  it('a tool outside the allowlist ends the turn, as does one /tools names after the first turn', async () => {
    const drift = hermesAgent({
      onPrompt: (c, id, sessionId) => {
        c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'terminal: ls -la' } } });
        return 'hold';
      },
    });
    const a1 = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: drift.spawnFn, hermes: hermesPolicy().policy });
    a1.start({});
    const e1 = await collect(a1.send('go'));
    expect(e1.at(-1)).toEqual({ type: 'error', message: `${HERMES_TOOLS_CHANGED_LEAD} terminal` });
    expect(drift.children[0].sent.some((s) => s.msg.method === 'session/cancel')).toBe(true);
    expect(drift.children[0].killed).toBe(true);
    a1.dispose();

    const listed = hermesAgent({ tools: 'Available tools (3):\n  web: web_search\n  terminal: terminal, process\n' });
    const a2 = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: listed.spawnFn, hermes: hermesPolicy().policy });
    a2.start({});
    const e2 = await collect(a2.send('go'));
    expect(e2.at(-1)).toEqual({ type: 'error', message: `${HERMES_TOOLS_CHANGED_LEAD} terminal, process` });
    a2.dispose();

    // A /tools answer whose names do not add up to its count reads as unknown: refused.
    const odd = hermesAgent({ tools: 'Available tools (4):\n  web: web_search\n' });
    const a4 = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: odd.spawnFn, hermes: hermesPolicy().policy });
    a4.start({});
    const e4 = await collect(a4.send('go'));
    expect(e4.at(-1)).toEqual({ type: 'error', message: `${HERMES_TOOLS_CHANGED_LEAD} wmux could not read the tools of this Hermes session` });
    a4.dispose();
  });

  it('a session whose wmux tools never connect, or a Hermes that is not ready, gets no prompt', async () => {
    const agent = hermesAgent({});
    const a1 = new AcpBrainAdapter({
      spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: '/fake/mcp.js', spawnFn: agent.spawnFn,
      hermes: hermesPolicy({ mcpReady: async () => false }).policy,
    });
    a1.start({});
    const e1 = await collect(a1.send('go'));
    expect(e1.at(-1)?.type).toBe('error');
    expect((e1.at(-1) as { message: string }).message.startsWith(HERMES_MCP_MISSING_LEAD)).toBe(true);
    expect(agent.prompts()).toBe(0);
    a1.dispose();

    // A refused session is checked again on the next turn, not reused.
    const refusals = ['its gateway runs messaging platforms', null];
    const sessionStarted = vi.fn(() => refusals.shift() ?? null);
    const a3 = new AcpBrainAdapter({
      spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: '/fake/mcp.js', spawnFn: agent.spawnFn,
      hermes: hermesPolicy({ sessionStarted }).policy,
    });
    a3.start({});
    expect((await collect(a3.send('go'))).at(-1)).toEqual({ type: 'error', message: 'its gateway runs messaging platforms' });
    expect(agent.prompts()).toBe(0);
    expect((await collect(a3.send('go'))).at(-1)?.type).toBe('turn-end');
    expect(sessionStarted).toHaveBeenCalledTimes(2);
    a3.dispose();

    const spawnFn = vi.fn(agent.spawnFn);
    const a2 = new AcpBrainAdapter({
      spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn,
      hermes: hermesPolicy({ prepare: async () => ({ ok: false, message: 'not ready' }) }).policy,
    });
    a2.start({});
    expect(await collect(a2.send('go'))).toEqual([{ type: 'error', message: 'not ready' }]);
    expect(spawnFn).not.toHaveBeenCalled();
    a2.dispose();
  });
});
