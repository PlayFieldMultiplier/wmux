// §13 rule 3: a factory bot's input.readScreen reaches its own workspace and
// the open task panes IT started — not another bot's tasks in the same
// workspace, not another workspace, whatever workspaceId it names. Dispatched
// through the real RpcRouter with a real bot token.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import { mintBotToken, __resetCommanderTrustForTesting } from '../../../deck/commanderTrust';
import type { PTYManager } from '../../../pty/PTYManager';
import type { TaskLedger } from '../../../../daemon/ledger/TaskLedger';
import type { LedgerDispatch } from '../../../../shared/ledger';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const BOT = { workspaceId: 'ws-bot', botId: 'bot-0a1b2c3d', role: 'verifier' as const };
const PANE_OWNERS: Record<string, string> = {
  'pty-own': 'ws-bot',
  'pty-mine': 'ws-task-mine',
  'pty-other-bot': 'ws-task-other',
  'pty-pane-task': 'ws-task-pane',
  'pty-stranger': 'ws-stranger',
  'pty-reclaimed': 'ws-task-reopened',
  'pty-reclaimed-other': 'ws-task-other-reopened',
};

interface Entry { ownerWorkspaceId: string; taskWorkspaceId: string; status: string; dispatch?: LedgerDispatch }

const ENTRIES: Entry[] = [
  { ownerWorkspaceId: 'ws-bot', taskWorkspaceId: 'ws-task-mine', status: 'working', dispatch: { origin: { kind: 'bot', botId: BOT.botId } } },
  { ownerWorkspaceId: 'ws-bot', taskWorkspaceId: 'ws-task-other', status: 'working', dispatch: { origin: { kind: 'bot', botId: 'bot-ffffffff' } } },
  { ownerWorkspaceId: 'ws-bot', taskWorkspaceId: 'ws-task-pane', status: 'working', dispatch: { origin: { kind: 'pane' } } },
];

function wire(): RpcRouter {
  const ledger = {
    list: (f: { ownerWorkspaceId?: string; openOnly?: boolean } = {}) =>
      ENTRIES.filter((e) => f.ownerWorkspaceId === undefined || e.ownerWorkspaceId === f.ownerWorkspaceId),
  } as unknown as TaskLedger;
  const router = new RpcRouter();
  registerInputRpc(router, { get: () => undefined } as unknown as PTYManager, () => ({}) as BrowserWindow, undefined, undefined, undefined, {
    getLedger: () => ledger,
    // main's reclaim records: this bot's ended task reopened in a new
    // workspace, and another bot's.
    reclaimedWorkerWorkspaces: (botId, owner) => (owner !== 'ws-bot' ? [] : botId === BOT.botId ? ['ws-task-reopened'] : ['ws-task-other-reopened']),
  });
  return router;
}

type Answer = { ok: boolean; error?: string; result?: Record<string, unknown> };
const asBot = (router: RpcRouter, params: Record<string, unknown>): Promise<Answer> =>
  router.dispatch({ id: '1', method: 'input.readScreen', params, commanderToken: mintBotToken(BOT) } as never) as Promise<Answer>;

beforeEach(() => {
  vi.clearAllMocks();
  sendToRendererMock.mockImplementation((_w: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: PANE_OWNERS[params['ptyId'] as string] ?? null });
    if (method === 'input.readScreen') {
      const ws = params['workspaceId'];
      if (!params['ptyId']) return Promise.resolve({ ptyId: ws === 'ws-bot' ? 'pty-own' : 'pty-stranger', text: `ACTIVE OF ${String(ws)}` });
      if (typeof ws === 'string' && PANE_OWNERS[params['ptyId'] as string] !== ws) return Promise.resolve({ error: 'not in workspace' });
      return Promise.resolve({ ptyId: params['ptyId'], text: 'SCREEN' });
    }
    return Promise.resolve(null);
  });
});

afterEach(() => {
  __resetCommanderTrustForTesting();
});

describe('input.readScreen — bot scope', () => {
  it('reads a pane of its own workspace and an open task it started', async () => {
    const router = wire();
    expect(await asBot(router, { ptyId: 'pty-own' })).toMatchObject({ ok: true, result: { text: 'SCREEN' } });
    expect(await asBot(router, { ptyId: 'pty-mine' })).toMatchObject({ ok: true, result: { text: 'SCREEN', untrusted: true } });
  });

  it('reads the pane of an ended task it started whose worker main reclaimed (resumed in a new pane)', async () => {
    const router = wire();
    expect(await asBot(router, { ptyId: 'pty-reclaimed' })).toMatchObject({ ok: true, result: { text: 'SCREEN', untrusted: true } });
  });

  it('refuses another bot\'s task, a pane-started task, and a foreign workspace', async () => {
    const router = wire();
    for (const ptyId of ['pty-other-bot', 'pty-pane-task', 'pty-stranger', 'pty-reclaimed-other']) {
      const res = await asBot(router, { ptyId });
      expect(res.ok, ptyId).toBe(false);
    }
  });

  it('a named workspaceId is ignored: the read stays in the bot\'s own workspace', async () => {
    const router = wire();
    const named = await asBot(router, { workspaceId: 'ws-stranger', ptyId: 'pty-stranger' });
    expect(named.ok).toBe(false);
    const active = await asBot(router, { workspaceId: 'ws-stranger' });
    expect(active).toMatchObject({ ok: true, result: { text: 'ACTIVE OF ws-bot' } });
  });
});
