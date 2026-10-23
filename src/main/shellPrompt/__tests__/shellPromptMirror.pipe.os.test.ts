// The daemon.shellPrompt.list answer and a shell.prompt event can share one
// pipe chunk. DaemonClient emits the event at once but hands the answer back
// through a promise, so main applies them out of order; the versions must keep
// a clear that happened after the list from being undone by it.
//
// Real DaemonClient over a real pipe, against a minimal daemon that writes
// the list answer and a newer clear in a single write.
import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: () => undefined,
  getLastBroadcastAgentStatus: () => undefined,
  hasOutstandingRunningClaim: () => false,
}));

import { DaemonClient } from '../../DaemonClient';
import type { ShellPromptChange } from '../../../shared/shellPrompt';
import { noteShellPrompt, resetShellPromptMirrorForTests, resyncShellPromptsAtConnect, shellPromptOf } from '../shellPromptMirror';

const TOKEN = 'test-token-shell-prompt-order';
const push = { shape: 'yes-no', question: 'Push anyway? [y/N]' } as const;

function pipeName(): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-sptest-${id}`;
  return path.join(os.tmpdir(), `wmux-sptest-${id}.sock`);
}

/** Answers identify and subscribe; answers the list and writes `after` in the same write. */
function fakeDaemon(name: string, after: object) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const req = JSON.parse(line) as { id: string; method: string; token: string };
        if (req.token !== TOKEN) continue;
        const frame = (result: unknown) => JSON.stringify({ id: req.id, ok: true, result }) + '\n';
        if (req.method === 'daemon.client.identify') { socket.write(frame({ ok: true })); continue; }
        if (req.method === 'daemon.events.subscribe') { socket.write(frame({ ok: true })); continue; }
        if (req.method === 'daemon.shellPrompt.list') {
          // Taken at seq 5 with p1 shown; the clear at seq 6 follows in the same chunk.
          const list = { epoch: 'e1', seq: 5, prompts: [{ sessionId: 'p1', prompt: push, seq: 5 }] };
          socket.write(frame(list) + JSON.stringify(after) + '\n');
          continue;
        }
        socket.write(JSON.stringify({ id: req.id, ok: false, error: `Unknown method: ${req.method}` }) + '\n');
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    start: () => new Promise<void>((resolve) => server.listen(name, resolve)),
    stop: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

let daemon: ReturnType<typeof fakeDaemon> | null = null;
let client: DaemonClient | null = null;
afterEach(async () => {
  await client?.disconnect().catch(() => undefined);
  await daemon?.stop();
  client = null;
  daemon = null;
  resetShellPromptMirrorForTests();
});

describe('shell prompt list and event in one pipe chunk', () => {
  it('list, then a newer clear in the same chunk: cleared', async () => {
    const name = pipeName();
    daemon = fakeDaemon(name, { type: 'shell.prompt', sessionId: 'p1', data: { epoch: 'e1', seq: 6, prompt: null } });
    await daemon.start();
    client = new DaemonClient(name, TOKEN);
    expect(await client.connect()).toBe(true);

    // main's side, as DaemonNotificationRouter and src/main/index.ts compose it.
    const order: string[] = [];
    client.on('session:shellPrompt', (p: { sessionId: string } & ShellPromptChange) => {
      order.push(`event:${p.seq}`);
      noteShellPrompt(p.sessionId, p);
    });
    const sent: Array<[string, unknown]> = [];
    await resyncShellPromptsAtConnect(
      async () => {
        const list = await client!.listShellPrompts();
        order.push(`list:${list?.seq}`);
        return list;
      },
      (id, prompt) => sent.push([id, prompt]),
    );

    // The event did overtake the list: the race is real.
    expect(order).toEqual(['event:6', 'list:5']);
    expect(shellPromptOf('p1')).toBeNull();
    expect(sent).toEqual([]);
  });
});
