// #2372 — every pane of a reloaded window reads the whole session list (its
// reconnect, and pty:list). One call per pane filled the daemon's 200/s budget
// with the panes' resizes. Real DaemonClient over a real DaemonPipeServer.
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

const TOKEN = 'test-token-2372-list';
const PANES = 120;

function pipeName(): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-test-listcoalesce-${id}`;
  return path.join(os.tmpdir(), `wmux-test-listcoalesce-${id}.sock`);
}

describe('DaemonClient session-list reads in a burst (#2372)', () => {
  let server: DaemonPipeServer;
  let client: DaemonClient;
  /** Every listSessions call the daemon handled, by params. */
  let handled: Array<Record<string, unknown>>;
  /** The live list; a test changes it between calls. */
  let rows: Array<{ id: string; state: string }>;
  /** When set, the daemon's answer waits on this. */
  let gate: Promise<void> | null;

  beforeEach(async () => {
    // One frozen second: the limiter windows are 1 s of Date.now().
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const name = pipeName();
    server = new DaemonPipeServer(name);
    server.setAuthToken(TOKEN);
    handled = [];
    rows = Array.from({ length: PANES }, (_, n) => ({ id: `daemon-${n}`, state: 'attached' }));
    gate = null;
    server.onRpc('daemon.client.identify', async () => ({ ok: true }));
    server.onRpc('daemon.listSessions', async (params) => {
      handled.push(params);
      const snapshot = rows.map((r) => ({ ...r }));
      if (gate) await gate;
      return snapshot;
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

  it('every pane reading the list at once takes one daemon call, and none is refused', async () => {
    const lists = await Promise.all(Array.from({ length: PANES * 2 }, () => client.rpc('daemon.listSessions', {})));
    // Before #2372: 240 calls in one second, 40 of them refused.
    expect(handled).toHaveLength(1);
    for (const list of lists) expect((list as unknown[]).length).toBe(PANES);
  });

  it('a read asked while a call is in flight gets the next call, not the older answer', async () => {
    let open: () => void = () => undefined;
    gate = new Promise((resolve) => { open = resolve; });
    const first = client.rpc('daemon.listSessions', {});
    await vi.waitFor(() => expect(handled).toHaveLength(1), { timeout: 5_000 });
    // The list changes after the first call was answered by the daemon's read.
    rows.push({ id: 'daemon-new', state: 'attached' });
    const later = [client.rpc('daemon.listSessions', {}), client.rpc('daemon.listSessions', {})];
    gate = null;
    open();
    expect((await first as unknown[]).length).toBe(PANES);
    for (const list of await Promise.all(later)) expect((list as unknown[]).length).toBe(PANES + 1);
    expect(handled).toHaveLength(2);
  });

  it('callers get their own arrays, other params get their own call, and a read with a timeout is not shared', async () => {
    const [a, b, suspended] = await Promise.all([
      client.rpc('daemon.listSessions', {}),
      client.rpc('daemon.listSessions', {}),
      client.rpc('daemon.listSessions', { includeSuspended: true }),
    ]);
    (a as unknown[]).length = 0;
    expect((b as unknown[]).length).toBe(PANES);
    expect((suspended as unknown[]).length).toBe(PANES);
    expect(handled).toEqual([{}, { includeSuspended: true }]);
    await Promise.all([
      client.rpc('daemon.listSessions', {}, { timeoutMs: 1_000 }),
      client.rpc('daemon.listSessions', {}, { timeoutMs: 1_000 }),
    ]);
    expect(handled).toHaveLength(4);
    // Nested params are not a faithful key: never shared.
    await Promise.all([
      client.rpc('daemon.listSessions', { filter: { workspaceId: 'a' } }),
      client.rpc('daemon.listSessions', { filter: { workspaceId: 'b' } }),
    ]);
    expect(handled.slice(4)).toEqual([{ filter: { workspaceId: 'a' } }, { filter: { workspaceId: 'b' } }]);
  });
});
