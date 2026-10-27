// The daemon.folderTrustState contract, over a real DaemonClient and a real
// DaemonPipeServer: main's gate falls back to it when the renderer has no
// screen for a pane, and anything but a clear answer must read as 'unknown'.
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

const TOKEN = 'test-token-folder-trust';

function pipeName(): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-test-foldertrust-${id}`;
  return path.join(os.tmpdir(), `wmux-test-foldertrust-${id}.sock`);
}

describe('DaemonClient.folderTrustState', () => {
  let server: DaemonPipeServer;
  let client: DaemonClient;
  let answer: () => Promise<unknown>;
  let asked: unknown[];

  beforeEach(async () => {
    const name = pipeName();
    server = new DaemonPipeServer(name);
    server.setAuthToken(TOKEN);
    server.onRpc('daemon.client.identify', async () => ({ ok: true }));
    asked = [];
    answer = async () => ({ state: 'clear' });
    server.onRpc('daemon.folderTrustState', async (params) => {
      asked.push(params['id']);
      return answer();
    });
    await server.start();
    client = new DaemonClient(name, TOKEN);
    expect(await client.connect()).toBe(true);
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
  });

  it("asks for the session by id and returns the daemon's verdict", async () => {
    for (const state of ['trust', 'clear'] as const) {
      answer = async () => ({ state });
      expect(await client.folderTrustState('daemon-1', 250)).toBe(state);
    }
    expect(asked).toEqual(['daemon-1', 'daemon-1']);
  });

  it("reads anything else as 'unknown'", async () => {
    for (const reply of [{ state: 'unknown' }, { state: 'yes' }, {}, null]) {
      answer = async () => reply;
      expect(await client.folderTrustState('daemon-1', 250)).toBe('unknown');
    }
    answer = async () => { throw new Error('SESSION_NOT_FOUND: daemon-1'); };
    expect(await client.folderTrustState('daemon-1', 250)).toBe('unknown');
  });

  it("is 'unknown' when the daemon does not answer within the budget", async () => {
    answer = () => new Promise(() => undefined);
    const started = Date.now();
    expect(await client.folderTrustState('daemon-1', 250)).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
