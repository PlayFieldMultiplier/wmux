// The owner's revoke and off switch also drop the guests' wakes that have
// not run: nothing a revoked guest posted runs after the revoke.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { WakeQueue, setWakeQueue, wakeQueuePath } from '../../../factory/wakeQueue';
import { createGuestBot, markGuestWorkspace, revokeGuestBot, setGuestBotsEnabled, type GuestWorkspacePorts } from '../guestBots.handler';

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

const bot = (id: string, over: Record<string, unknown> = {}) => ({
  version: 1, id, workspaceId: 'ws-g', role: 'lead', template: 'developer', name: id, engine: { kind: 'claude-sdk' },
  triggers: [], budget: {}, enabled: true, createdAt: 1, updatedAt: 1, ...over,
}) as never;

function workspaces(over: Partial<GuestWorkspacePorts> = {}): GuestWorkspacePorts & { calls: string[] } {
  const calls: string[] = [];
  const flagged = new Set<string>();
  return {
    calls,
    flag: (ws) => flagged.has(ws),
    list: () => ({ readable: true, workspaceIds: [...flagged] }),
    flush: async () => { calls.push('flush'); },
    add: async (ws) => { calls.push(`add:${ws}`); flagged.add(ws); },
    hqWorkspaceId: () => 'ws-hq',
    bots: () => [],
    liveWork: () => false,
    noteRecords: (ids) => { calls.push(`note:${ids.join(',')}`); },
    ...over,
  };
}

const scope = { workspaceId: 'ws-g', threadId: 'general' };
const createdGuest = { v: 1, guestId: G1, name: 'G', scope, createdAt: '2026-10-20T00:00:00.000Z' };

describe('guest create only in a guest workspace', () => {
  it('refuses a conversation outside a guest workspace without asking the daemon', async () => {
    const dc = { isConnected: true, rpc: vi.fn() };
    expect(await createGuestBot(dc as never, { name: 'G', scope }, () => 3, workspaces())).toEqual({ ok: false, code: 'not-guest-workspace' });
    expect(dc.rpc).not.toHaveBeenCalled();
  });

  it('refuses while the flags cannot be read (before startup, or an unreadable file)', async () => {
    const dc = { isConnected: true, rpc: vi.fn() };
    expect(await createGuestBot(dc as never, { name: 'G', scope }, () => 3, workspaces({ flag: () => 'unknown' }))).toEqual({ ok: false, code: 'unavailable' });
    expect(dc.rpc).not.toHaveBeenCalled();
  });

  it('the flag is on disk before the daemon is asked; the record\'s workspace is noted', async () => {
    const w = workspaces({ flag: () => true });
    const dc = { isConnected: true, rpc: vi.fn(async () => { w.calls.push('rpc'); return { ok: true, guest: createdGuest, token: 't' }; }) };
    const r = await createGuestBot(dc as never, { name: 'G', scope }, () => 3, w);
    expect(r.ok).toBe(true);
    expect(w.calls).toEqual(['flush', 'rpc', 'note:ws-g']);
  });

  it('a flag that could not be written makes no guest', async () => {
    const dc = { isConnected: true, rpc: vi.fn() };
    const w = workspaces({ flag: () => true, flush: async () => { throw new Error('disk'); } });
    expect(await createGuestBot(dc as never, { name: 'G', scope }, () => 3, w)).toEqual({ ok: false, code: 'persist-failed' });
    expect(dc.rpc).not.toHaveBeenCalled();
  });
});

describe('making a workspace a guest workspace', () => {
  it('flags it once, and again is a no-op', async () => {
    const w = workspaces();
    expect(await markGuestWorkspace({ workspaceId: 'ws-g' }, w)).toEqual({ ok: true });
    expect(await markGuestWorkspace({ workspaceId: 'ws-g' }, w)).toEqual({ ok: true });
    expect(w.calls).toEqual(['add:ws-g']);
  });

  it('refuses the HQ workspace', async () => {
    const w = workspaces();
    expect(await markGuestWorkspace({ workspaceId: 'ws-hq' }, w)).toEqual({ ok: false, code: 'refused', refusal: 'hq' });
    expect(w.calls).toEqual([]);
  });

  it('refuses while a bot breaks the rules: an engine without the per-call tool gate, a repository, a Coordinator', async () => {
    const w = workspaces({ bots: () => [bot('bot-0000aaaa', { engine: { kind: 'claude-pty' } }), bot('bot-0000bbbb', { repo: { repoKey: 'o/r', repoPath: '/r' } }), bot('bot-0000cccc', { template: 'coordinator', role: 'moa' }), bot('bot-0000dddd')] });
    expect(await markGuestWorkspace({ workspaceId: 'ws-g' }, w)).toEqual({ ok: false, code: 'refused', refusal: 'bots', botIds: ['bot-0000aaaa', 'bot-0000bbbb', 'bot-0000cccc'] });
    expect(w.calls).toEqual([]);
  });

  it('refuses while a turn, a task or a worker of it runs', async () => {
    const w = workspaces({ bots: () => [bot('bot-0000dddd')], liveWork: () => true });
    expect(await markGuestWorkspace({ workspaceId: 'ws-g' }, w)).toEqual({ ok: false, code: 'refused', refusal: 'live-work' });
    expect(w.calls).toEqual([]);
  });

  it('refuses while the flags cannot be read, and a write that fails', async () => {
    expect(await markGuestWorkspace({ workspaceId: 'ws-g' }, workspaces({ flag: () => 'unknown' }))).toEqual({ ok: false, code: 'unavailable' });
    expect(await markGuestWorkspace({ workspaceId: 'ws-g' }, workspaces({ add: async () => { throw new Error('disk'); } }))).toEqual({ ok: false, code: 'persist-failed' });
    expect(await markGuestWorkspace({ workspaceId: '../x' }, workspaces())).toEqual({ ok: false, code: 'invalid' });
  });
});
