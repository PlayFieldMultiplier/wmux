// #2372 — a reloaded window reports every pane's viewer visibility twice (on
// mount and after its reattach), one daemon call each. Real DaemonClient over
// a real DaemonPipeServer.
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
import { viewerVisibilityUpdates } from '../../shared/viewerVisibilityBatch';

const TOKEN = 'test-token-2372-vis';
const PANES = 120;

function pipeName(): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-test-visbatch-${id}`;
  return path.join(os.tmpdir(), `wmux-test-visbatch-${id}.sock`);
}

describe('DaemonClient viewer-visibility reports in a burst (#2372)', () => {
  let server: DaemonPipeServer;
  let client: DaemonClient;
  /** Every call the daemon handled. */
  let calls: Array<Record<string, unknown>>;
  /** What the daemon ends up holding, per pane. */
  let visible: Map<string, boolean>;
  /** An older daemon: only the single form. */
  let older: boolean;

  const settled = () => vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 5_000 });

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const name = pipeName();
    server = new DaemonPipeServer(name);
    server.setAuthToken(TOKEN);
    calls = [];
    visible = new Map();
    older = false;
    server.onRpc('daemon.client.identify', async () => ({ ok: true }));
    server.onRpc('daemon.setSessionViewerVisibility', async (params) => {
      calls.push(params);
      if (params['updates'] !== undefined && !older) {
        const updates = viewerVisibilityUpdates(params['updates']);
        for (const u of updates) visible.set(u.id, u.visible);
        return { ok: true, applied: updates.length };
      }
      if (typeof params['id'] !== 'string' || typeof params['visible'] !== 'boolean') {
        throw new Error('setSessionViewerVisibility: id (string) and visible (boolean) are required');
      }
      visible.set(params['id'] as string, params['visible'] as boolean);
      return { ok: true };
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

  it('every pane reported twice in one turn takes one call, and each pane keeps its last report', async () => {
    const ids = Array.from({ length: PANES }, (_, n) => `daemon-${n}`);
    for (const id of ids) client.setViewerVisibility(id, false);
    for (const id of ids) client.setViewerVisibility(id, id.endsWith('0'));
    await settled();
    // Before #2372: 240 calls in one second.
    expect(calls).toHaveLength(1);
    expect((calls[0]['updates'] as unknown[]).length).toBe(PANES);
    for (const id of ids) expect(visible.get(id)).toBe(id.endsWith('0'));
  });

  it('a lone report stays a single call', async () => {
    client.setViewerVisibility('daemon-a', false);
    await settled();
    expect(calls).toEqual([{ id: 'daemon-a', visible: false }]);
  });

  it('an older daemon that refuses the batch is sent each pane on its own', async () => {
    older = true;
    client.setViewerVisibility('daemon-a', false);
    client.setViewerVisibility('daemon-b', true);
    await vi.waitFor(() => expect(visible.size).toBe(2), { timeout: 5_000 });
    expect(visible.get('daemon-a')).toBe(false);
    expect(visible.get('daemon-b')).toBe(true);
    expect(calls).toHaveLength(3); // the refused batch, then one per pane
  });
});

describe('viewerVisibilityUpdates', () => {
  it('refuses anything but 1..256 { id, visible }', () => {
    expect(() => viewerVisibilityUpdates([])).toThrow();
    expect(() => viewerVisibilityUpdates('x')).toThrow();
    expect(() => viewerVisibilityUpdates([{ id: 'a' }])).toThrow();
    expect(() => viewerVisibilityUpdates([{ id: 1, visible: true }])).toThrow();
    expect(() => viewerVisibilityUpdates(Array.from({ length: 257 }, (_, n) => ({ id: `p${n}`, visible: true })))).toThrow();
    expect(viewerVisibilityUpdates([{ id: 'a', visible: true, extra: 1 }])).toEqual([{ id: 'a', visible: true }]);
  });
});
