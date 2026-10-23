// #2372 direction 3: a burst of per-pane agent reads (main's resync after it
// subscribes to events again, the renderer's agent-name reads at startup)
// used to send one daemon RPC per pane and fill the daemon's per-second
// budget. Real DaemonClient over a real DaemonPipeServer.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: () => undefined,
  getLastBroadcastAgentStatus: () => undefined,
  hasOutstandingRunningClaim: () => false,
}));

import { DaemonPipeServer } from '../../daemon/DaemonPipeServer';
import { DaemonClient } from '../DaemonClient';

const TOKEN = 'test-token-2372';
const PANES = 120;

function pipeName(): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-test-agentbatch-${id}`;
  return path.join(os.tmpdir(), `wmux-test-agentbatch-${id}.sock`);
}

const stateOf = (id: string) => ({
  agentName: `agent-${id}`,
  agentVerified: false,
  agentStatus: 'idle',
  inputQuiet: true,
  inputRevision: 0,
  incarnationId: `inc-${id}`,
});

describe('DaemonClient agent reads in a burst (#2372)', () => {
  let server: DaemonPipeServer;
  let client: DaemonClient;
  /** Every getAgentState request the daemon handled, single or batched. */
  let handled: Array<{ id?: unknown; ids?: unknown }>;
  let nameCalls = 0;

  beforeEach(async () => {
    // One frozen second: the limiter windows are 1 s of Date.now().
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const name = pipeName();
    server = new DaemonPipeServer(name);
    server.setAuthToken(TOKEN);
    handled = [];
    server.onRpc('daemon.client.identify', async () => ({ ok: true }));
    nameCalls = 0;
    server.onRpc('daemon.getAgentName', async (params) => { nameCalls += 1; return stateOf(String(params['id'])); });
    server.onRpc('daemon.getAgentState', async (params) => {
      handled.push({ id: params['id'], ids: params['ids'] });
      if (Array.isArray(params['ids'])) {
        return { states: Object.fromEntries((params['ids'] as string[]).map((id) => [id, stateOf(id)])) };
      }
      return stateOf(String(params['id']));
    });
    await server.start();
    client = new DaemonClient(name, TOKEN);
    expect(await client.connect()).toBe(true);
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
    vi.restoreAllMocks();
  });

  it('every pane\'s state and name read at once take one daemon call and none is refused', async () => {
    const ids = Array.from({ length: PANES }, (_, n) => `daemon-${n}`);
    const [states, names] = await Promise.all([
      Promise.all(ids.map((id) => client.getAgentState(id))),
      Promise.all(ids.map((id) => client.getAgentName(id))),
    ]);
    expect(states.filter((s) => s === null)).toHaveLength(0);
    expect(states.map((s) => s?.incarnationId)).toEqual(ids.map((id) => `inc-${id}`));
    expect(names).toEqual(ids.map((id) => `agent-${id}`));
    // Before #2372: 240 calls in one second, 40 of them refused (the names read null).
    expect(handled).toHaveLength(1);
    expect(nameCalls).toBe(0);
  });

  it('a lone read stays a single-id call, and a read with its own timeout is never batched', async () => {
    expect((await client.getAgentState('daemon-a'))?.incarnationId).toBe('inc-daemon-a');
    await Promise.all([client.getAgentState('daemon-b', { timeoutMs: 1_000 }), client.getAgentState('daemon-c', { timeoutMs: 1_000 })]);
    expect(handled).toEqual([{ id: 'daemon-a', ids: undefined }, { id: 'daemon-b', ids: undefined }, { id: 'daemon-c', ids: undefined }]);
  });

  it('an older daemon that ignores `ids` is read one pane at a time', async () => {
    server.onRpc('daemon.getAgentState', async (params) => {
      handled.push({ id: params['id'], ids: params['ids'] });
      return stateOf(String(params['id'] ?? ''));
    });
    const states = await Promise.all(['daemon-x', 'daemon-y'].map((id) => client.getAgentState(id)));
    expect(states.map((s) => s?.incarnationId)).toEqual(['inc-daemon-x', 'inc-daemon-y']);
  });
});
