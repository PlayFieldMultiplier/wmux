// The daemon.folderTrustState contract, over a real DaemonClient and a real
// DaemonPipeServer: main's gate falls back to it when the renderer has no
// screen for a pane, and anything but a clear answer must read as 'unknown'.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
import { registerFolderTrustRpc } from '../../daemon/folderTrustState';
import { RingBuffer } from '../../daemon/RingBuffer';

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
    for (const state of ['trust', 'clear', 'unknown'] as const) {
      answer = async () => ({ state });
      expect(await client.folderTrustState('daemon-1', 400)).toEqual({ state });
    }
    expect(asked).toEqual(['daemon-1', 'daemon-1', 'daemon-1']);
  });

  it('says why there is no verdict: a malformed answer, an error, an older daemon', async () => {
    answer = async () => ({ state: 'yes' });
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ unavailable: 'malformed answer' });
    answer = async () => { throw new Error('boom'); };
    expect(await client.folderTrustState('daemon-1', 400)).toMatchObject({ unavailable: expect.stringContaining('boom') });
    expect(await client.folderTrustState('daemon-1', 400)).not.toHaveProperty('state');
  });

  it('a daemon without the method, or no answer in time, is unavailable', async () => {
    const olderName = pipeName();
    const older = new DaemonPipeServer(olderName);
    older.setAuthToken(TOKEN);
    older.onRpc('daemon.client.identify', async () => ({ ok: true }));
    await older.start();
    const olderClient = new DaemonClient(olderName, TOKEN);
    try {
      expect(await olderClient.connect()).toBe(true);
      expect(await olderClient.folderTrustState('daemon-1', 400)).toEqual({ unavailable: 'daemon predates daemon.folderTrustState' });
    } finally {
      await olderClient.disconnect();
      await older.stop();
    }
    answer = () => new Promise(() => undefined);
    const started = Date.now();
    expect(await client.folderTrustState('daemon-1', 400)).toMatchObject({ unavailable: expect.stringContaining('RPC timeout') });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('is unavailable without asking when the daemon is not connected', async () => {
    await client.disconnect();
    expect(await client.folderTrustState('daemon-1', 400)).toEqual({ unavailable: 'daemon not connected' });
    expect(asked).toEqual([]);
  });
});

// The daemon's own handler (registerFolderTrustRpc) over the wire: a session
// whose ring holds a measured dialog reads 'trust', one at a shell 'clear'.
describe('daemon.folderTrustState end to end', () => {
  it('answers from the session ring', async () => {
    const name = pipeName();
    const server = new DaemonPipeServer(name);
    server.setAuthToken(TOKEN);
    server.onRpc('daemon.client.identify', async () => ({ ok: true }));
    const rows = (JSON.parse(fs.readFileSync(path.join(__dirname, '../../daemon/approvals/__tests__/fixtures/folder-trust/codex-folder-trust-60x30.json'), 'utf8')) as { screen: string[] }).screen;
    const sessionAt = (bytes: string) => {
      const ring = new RingBuffer(64 * 1024);
      ring.noteGeometry(60, 30);
      ring.write(Buffer.from(bytes));
      return { meta: { state: 'attached' as const, cols: 60, rows: 30 }, ptyProcess: { cols: 60, rows: 30 }, ringBuffer: ring, bridge: { isMuted: false, outputModes: null }, deferred: false };
    };
    const sessions = new Map([
      ['pane-trust', sessionAt(`\x1b[2J${rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join('')}`)],
      ['pane-shell', sessionAt('$ ls\r\nREADME.md\r\n$ ')],
    ]);
    registerFolderTrustRpc(server, { getSession: (id) => sessions.get(id), getPendingRecovery: () => undefined });
    await server.start();
    const c = new DaemonClient(name, TOKEN);
    try {
      expect(await c.connect()).toBe(true);
      expect(await c.folderTrustState('pane-trust', 400)).toEqual({ state: 'trust' });
      expect(await c.folderTrustState('pane-shell', 400)).toEqual({ state: 'clear' });
      expect(await c.folderTrustState('pane-gone', 400)).toEqual({ state: 'unknown' });
    } finally {
      await c.disconnect();
      await server.stop();
    }
  });
});
