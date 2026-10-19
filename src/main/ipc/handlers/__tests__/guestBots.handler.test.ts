// The owner's revoke and off switch also drop the guests' wakes that have
// not run: nothing a revoked guest posted runs after the revoke.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { WakeQueue, setWakeQueue, wakeQueuePath } from '../../../factory/wakeQueue';
import { revokeGuestBot, setGuestBotsEnabled } from '../guestBots.handler';

const G1 = '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const G2 = '1b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const dirs: string[] = [];

function queue(): WakeQueue {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-guest-handler-'));
  dirs.push(dir);
  const q = new WakeQueue(wakeQueuePath(dir), { now: () => 1 });
  setWakeQueue(q);
  return q;
}

const guestWake = (q: WakeQueue, guestId: string, cardId: string) =>
  q.enqueue({ botId: 'bot-0000aaaa', workspaceId: 'ws-1', priority: 2, reason: { kind: 'guest', guestId, guestName: 'G', cardId, text: 'hi' } });

const daemon = (ok: boolean) => ({ isConnected: true, rpc: vi.fn(async () => (ok ? { ok: true } : { ok: false, code: 'persist-failed' })) });

afterEach(async () => {
  setWakeQueue(null);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('guest bot revoke and off switch', () => {
  it('nothing of a revoked guest runs after the revoke; another guest\'s wake still does', async () => {
    const q = queue();
    guestWake(q, G1, 'c-1');
    guestWake(q, G2, 'c-2');
    expect(await revokeGuestBot(daemon(true) as never, G1)).toEqual({ ok: true });
    const next = q.next('bot-0000aaaa');
    expect(next?.reason).toMatchObject({ kind: 'guest', guestId: G2 });
    q.start(next!.id);
    q.finish(next!.id);
    expect(q.next('bot-0000aaaa')).toBeNull();
    await q.flush();
  });

  it('a revoke the daemon could not save still drops the guest\'s wakes', async () => {
    const q = queue();
    guestWake(q, G1, 'c-1');
    expect(await revokeGuestBot(daemon(false) as never, G1)).toEqual({ ok: false, code: 'persist-failed' });
    expect(q.next('bot-0000aaaa')).toBeNull();
    await q.flush();
  });

  it('turning guest bots off drops every guest wake; turning them on drops none', async () => {
    const q = queue();
    guestWake(q, G1, 'c-1');
    await setGuestBotsEnabled(daemon(true) as never, true);
    expect(q.queuedGuestWakes('bot-0000aaaa')).toBe(1);
    guestWake(q, G2, 'c-2');
    await setGuestBotsEnabled(daemon(true) as never, false);
    expect(q.queuedGuestWakes('bot-0000aaaa')).toBe(0);
    expect(q.next('bot-0000aaaa')).toBeNull();
    await q.flush();
  });
});
