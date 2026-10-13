// The one-line redaction seams the secret scenario does not drive: the wake
// queue's file, the handoff store and the IPC error log.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../shared/bot';
import { WakeQueue, wakeQueuePath } from '../wakeQueue';
import type { WakeItem } from '../../../shared/wake';
import { HANDOFFS_FILENAME, HandoffRouter, deckDecisionPort } from '../handoffRouter';
import { RoomWriter, type FactoryRoomPorts } from '../roomWriter';
import { __resetRedactedSecretsForTesting, redactStoredSecretsDeep, setRedactedSecrets } from '../secretRedaction';
import { buildArgsSummary, wrapHandler } from '../../ipc/wrapHandler';
import { LEDGER_SUMMARY_MAX_BYTES, TaskLedger } from '../../../daemon/ledger/TaskLedger';

const VALUE = 'sk_live_SeamValue0123456789abc';
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-w4-seams-'));
  setRedactedSecrets([{ name: 'STRIPE_SECRET_KEY', value: VALUE }]);
});
afterEach(() => {
  __resetRedactedSecretsForTesting();
  fs.rmSync(dir, { recursive: true, force: true });
});

function bot(id: string, ws: string, role: BotProfile['role']): BotProfile {
  return {
    version: 1, id, workspaceId: ws, role, name: role, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS[role],
    enabled: true, createdAt: 1, updatedAt: 1,
  } as BotProfile;
}

describe('redaction seams', () => {
  it('a wake reason is stored redacted in wake-queue.json', async () => {
    const file = wakeQueuePath(dir);
    const q = new WakeQueue(file);
    q.load();
    const item = q.enqueue({ botId: 'bot-0000000a', workspaceId: 'ws-1', reason: { kind: 'human', text: `use ${VALUE}`, source: 'desktop' }, priority: 0 });
    expect(item?.reason).toMatchObject({ kind: 'human', text: 'use [secret:STRIPE_SECRET_KEY]' });
    await q.flush();
    expect(fs.readFileSync(file, 'utf8')).not.toContain(VALUE);
  });

  it('a handoff is stored redacted and the caller sees the redacted text', async () => {
    const hq = bot('bot-0000000c', 'hq', 'moa');
    const lead = bot('bot-0000000a', 'ws1', 'lead');
    const rooms = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
    const ports: Partial<FactoryRoomPorts> = {
      bots: { listEnabled: () => [hq, lead], get: (id: string) => [hq, lead].find((b) => b.id === id) ?? null },
      wakes: { enqueue: (w) => ({ id: 'w-1', ...w, enqueuedAt: 1, attempts: 0, state: 'queued' }) as unknown as WakeItem },
    };
    const router = new HandoffRouter({
      file: path.join(dir, 'factory', HANDOFFS_FILENAME),
      decisions: deckDecisionPort(dir),
      ports: () => ports,
      rooms: () => rooms,
      log: () => undefined,
    });
    await router.start();
    try {
      const r = router.send({ workspaceId: hq.workspaceId, botId: hq.id, role: hq.role }, { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'deploy', body: `token ${VALUE}` });
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
      if (!r.ok) return;
      expect(router.get(r.handoffId)?.payload.body).toBe('token [secret:STRIPE_SECRET_KEY]');
      expect(fs.readFileSync(path.join(dir, 'factory', HANDOFFS_FILENAME), 'utf8')).not.toContain(VALUE);
    } finally {
      router.dispose();
    }
  });

  it('the IPC error log never carries a stored value', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const h = wrapHandler('test:channel', async (_e: unknown, _req: unknown) => {
        throw new Error(`bad ${VALUE}`);
      });
      await expect(h({}, { note: VALUE })).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(lines.join('')).toContain('[secret:STRIPE_SECRET_KEY]');
    expect(lines.join('')).not.toContain(VALUE);
  });

  it('an argument summary is redacted before it is cut, so no part of a value is kept', () => {
    const summary = buildArgsSummary([{ note: `${'x'.repeat(180)}${VALUE}` }]) ?? '';
    expect(summary).not.toContain(VALUE.slice(0, 8));
  });

  it('ledger text is redacted before it is cut, so no part of a value is kept', async () => {
    const ledger = new TaskLedger({ dir: path.join(dir, 'ledger'), redact: redactStoredSecretsDeep });
    const pad = 'a'.repeat(LEDGER_SUMMARY_MAX_BYTES - 10);
    const entry = await ledger.register({ id: 'task-1', taskWorkspaceId: 'ws-t', ownerWorkspaceId: 'ws-o', title: `${pad}${VALUE}` });
    expect(entry.title).not.toContain(VALUE.slice(0, 8));
    const closed = await ledger.closeTask('task-1', undefined, `${pad}${VALUE}`);
    expect(closed?.summary).not.toContain(VALUE.slice(0, 8));
    const gated = await ledger.recordGate('task-2', { exitCode: 0, tail: `${VALUE}${'z'.repeat(LEDGER_SUMMARY_MAX_BYTES * 8)}`, at: 1, command: 'x', recordedBy: 'system' });
    expect(gated.ok).toBe(false);
    for (const f of fs.readdirSync(path.join(dir, 'ledger'))) expect(fs.readFileSync(path.join(dir, 'ledger', f), 'utf8')).not.toContain(VALUE.slice(0, 8));
  });
});

describe('room reads of cards written before a value was stored', () => {
  it('room.read (the renderer\'s and bots\' path), the phone\'s room routes, thread titles and get are clean', async () => {
    __resetRedactedSecretsForTesting();
    const rooms = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
    const posted = rooms.append({
      workspaceId: 'ws-1', threadId: 'task:t-1', kind: 'human', actor: { kind: 'human' },
      title: `key ${VALUE}`, body: `body ${VALUE}`, refs: { label: VALUE },
    });
    expect(posted?.title).toBe(`key ${VALUE}`); // nothing stored yet: written as typed
    setRedactedSecrets([{ name: 'STRIPE_SECRET_KEY', value: VALUE }]);

    const { handleRoomRead } = await import('../../pipe/handlers/room.rpc');
    const operator = { origin: 'local', operator: true } as unknown as import('../../../shared/rpc').RpcContext;
    const read = handleRoomRead({ workspaceId: 'ws-1' }, operator, { writer: () => rooms, ports: () => ({}), wmuxDir: () => dir });
    expect(JSON.stringify(read)).toContain('[secret:STRIPE_SECRET_KEY]');
    expect(JSON.stringify(read)).not.toContain(VALUE);

    const { handlePhoneRoomCommand, defaultPhoneFactoryPorts } = await import('../../phone/PhoneFactory');
    const phonePorts = {
      ...defaultPhoneFactoryPorts(),
      settings: () => ({ enabled: true, hqWorkspaceId: 'ws-1' }),
      bots: () => [],
      rooms: () => rooms,
      roomReadable: () => true,
      roomFileExists: () => true,
    };
    const cards = handlePhoneRoomCommand('workspaces.roomCards', { workspaceId: 'ws-1', limit: 10 }, phonePorts);
    const threads = handlePhoneRoomCommand('workspaces.roomThreads', { workspaceId: 'ws-1' }, phonePorts);
    expect(JSON.stringify(cards)).toContain('key');
    expect(JSON.stringify([cards, threads, rooms.threads('ws-1'), rooms.get('ws-1', posted!.id)])).not.toContain(VALUE);
  });
});
