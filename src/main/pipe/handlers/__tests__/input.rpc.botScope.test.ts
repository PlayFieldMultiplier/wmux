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
import { setRedactedSecrets } from '../../../factory/secretRedaction';

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
  'pty-signed': 'ws-task-signed',
  'pty-reclaimed-signed': 'ws-task-signed-reopened',
};

interface Entry { id: string; ownerWorkspaceId: string; taskWorkspaceId: string; status: string; dispatch?: LedgerDispatch }

const ENTRIES: Entry[] = [
  { id: 't-mine', ownerWorkspaceId: 'ws-bot', taskWorkspaceId: 'ws-task-mine', status: 'working', dispatch: { origin: { kind: 'bot', botId: BOT.botId } } },
  { id: 't-other', ownerWorkspaceId: 'ws-bot', taskWorkspaceId: 'ws-task-other', status: 'working', dispatch: { origin: { kind: 'bot', botId: 'bot-ffffffff' } } },
  { id: 't-pane', ownerWorkspaceId: 'ws-bot', taskWorkspaceId: 'ws-task-pane', status: 'working', dispatch: { origin: { kind: 'pane' } } },
  // A task whose worker used the owner's sign-in (main's gateway).
  { id: 't-signed', ownerWorkspaceId: 'ws-bot', taskWorkspaceId: 'ws-task-signed', status: 'working', dispatch: { origin: { kind: 'bot', botId: BOT.botId }, gatewayConnectors: ['gmail'] } },
  // Ended tasks whose workers main reclaimed and a resume reopened elsewhere.
  { id: 't-reopened', ownerWorkspaceId: 'ws-bot', taskWorkspaceId: 'ws-task-reopened-was', status: 'completed', dispatch: { origin: { kind: 'bot', botId: BOT.botId } } },
  { id: 't-signed-reopened', ownerWorkspaceId: 'ws-bot', taskWorkspaceId: 'ws-task-signed-was', status: 'completed', dispatch: { origin: { kind: 'bot', botId: BOT.botId }, gatewayConnectors: ['gmail'] } },
];

const RECLAIMED: Record<string, { taskId: string; botId: string }> = {
  'pty-reclaimed': { taskId: 't-reopened', botId: BOT.botId },
  'pty-reclaimed-signed': { taskId: 't-signed-reopened', botId: BOT.botId },
};

function wire(markSignedIn: (botId: string) => void = () => undefined): RpcRouter {
  const ledger = {
    list: (f: { ownerWorkspaceId?: string; openOnly?: boolean } = {}) =>
      ENTRIES.filter((e) => (f.ownerWorkspaceId === undefined || e.ownerWorkspaceId === f.ownerWorkspaceId) && (!f.openOnly || e.status === 'working')),
    findByTaskWorkspace: (ws: string) => ENTRIES.find((e) => e.taskWorkspaceId === ws) ?? null,
    get: (id: string) => ENTRIES.find((e) => e.id === id) ?? null,
  } as unknown as TaskLedger;
  const router = new RpcRouter();
  registerInputRpc(router, { get: () => undefined } as unknown as PTYManager, () => ({}) as BrowserWindow, undefined, undefined, undefined, {
    getLedger: () => ledger,
    // main's reclaim records: this bot's ended task reopened in a new
    // workspace, and another bot's.
    reclaimedWorkerWorkspaces: (botId, owner) => (owner !== 'ws-bot' ? [] : botId === BOT.botId ? ['ws-task-reopened', 'ws-task-signed-reopened'] : ['ws-task-other-reopened']),
    reclaimedTaskOfPane: (ws, ptyId) => (PANE_OWNERS[ptyId] === ws ? RECLAIMED[ptyId] ?? null : null),
    markSignedIn,
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
  setRedactedSecrets([]);
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

  it('reading the pane of a task that used a signed-in connection marks the reading conversation signed in, before the screen is read; a plain task\'s pane does not', async () => {
    const marked: string[] = [];
    const router = wire((botId) => {
      // Marked before the renderer read the screen.
      expect(sendToRendererMock.mock.calls.some((c) => c[1] === 'input.readScreen')).toBe(false);
      marked.push(botId);
    });
    for (const ptyId of ['pty-own', 'pty-mine', 'pty-reclaimed']) {
      expect(await asBot(router, { ptyId }), ptyId).toMatchObject({ ok: true, result: { text: 'SCREEN' } });
    }
    expect(marked).toEqual([]);
    sendToRendererMock.mockClear();
    expect(await asBot(router, { ptyId: 'pty-signed' })).toMatchObject({ ok: true, result: { text: 'SCREEN', untrusted: true } });
    expect(marked).toEqual([BOT.botId]);
    sendToRendererMock.mockClear();
    // An ended signed-in task's worker, reopened in a new workspace.
    expect(await asBot(router, { ptyId: 'pty-reclaimed-signed' })).toMatchObject({ ok: true, result: { text: 'SCREEN', untrusted: true } });
    expect(marked).toEqual([BOT.botId, BOT.botId]);
  });

  it('a named workspaceId is ignored: the read stays in the bot\'s own workspace', async () => {
    const router = wire();
    const named = await asBot(router, { workspaceId: 'ws-stranger', ptyId: 'pty-stranger' });
    expect(named.ok).toBe(false);
    const active = await asBot(router, { workspaceId: 'ws-stranger' });
    expect(active).toMatchObject({ ok: true, result: { text: 'ACTIVE OF ws-bot' } });
  });
});

describe('input.readScreen — stored secrets on a bot\'s read', () => {
  const VALUE = 'SECRETVALUE-0123456789abcdef';
  const rows = ['older row', `prefix ${VALUE.slice(0, -4)}`, `${VALUE.slice(-4)} after`, 'last row'];

  it('masks a value wrapped across the top edge of the requested rows as one value', async () => {
    setRedactedSecrets([{ name: 'TOKEN', value: VALUE }]);
    const reads: Array<Record<string, unknown>> = [];
    sendToRendererMock.mockImplementation((_w: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: PANE_OWNERS[params['ptyId'] as string] ?? null });
      if (method === 'input.readScreen') {
        reads.push(params);
        return Promise.resolve({ ptyId: params['ptyId'], text: rows.slice(-(params['tail_lines'] as number)).join('\n') });
      }
      return Promise.resolve(null);
    });
    const res = await asBot(wire(), { ptyId: 'pty-own', tail_lines: 2 });
    expect(reads[0]?.['tail_lines']).toBeGreaterThan(2);
    expect(res).toMatchObject({ ok: true, result: { text: 'prefix [secret:TOKEN] after\nlast row' } });
    expect(String(res.result?.['text'])).not.toContain('cdef');
  });

  it('with nothing stored the read is passed through unchanged', async () => {
    const res = await asBot(wire(), { ptyId: 'pty-own', tail_lines: 2 });
    expect(res).toMatchObject({ ok: true, result: { text: 'SCREEN' } });
    expect(sendToRendererMock.mock.calls.find((c) => c[1] === 'input.readScreen')?.[2]).toMatchObject({ tail_lines: 2 });
  });
});
