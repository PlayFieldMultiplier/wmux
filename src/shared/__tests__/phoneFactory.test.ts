import { describe, it, expect } from 'vitest';
import { applyFactoryToSidebar, delegationsFromHandoffs, type PhoneFactoryState } from '../phoneFactory';
import { parsePhoneSidebarSnapshot, PHONE_MOA_DELEGATION_RECENT_MS, type PhoneSidebarSnapshot } from '../phoneFleetSidebar';
import type { Handoff } from '../handoff';

const legacy: PhoneSidebarSnapshot = {
  activeWorkspaceId: 'ws-1',
  workspaces: [{ id: 'ws-1', order: 0, pinned: false }, { id: 'ws-hq', order: 1, pinned: false }],
  panes: [],
  hqWorkspaceId: 'ws-hq',
  moa: true,
  moaWakeBlocked: 'moa-mode-off',
  moaDelegations: [{ taskId: 't-legacy', workspaceId: 'ws-1', agentName: 'Claude', title: 'old', state: 'working', since: 5 }],
};

const on = (over: Partial<PhoneFactoryState> = {}): PhoneFactoryState => ({
  enabled: true,
  hq: { botId: 'bot-0000aaaa', workspaceId: 'ws-hq', sessionId: 'sess-1' },
  bots: new Map([['ws-1', [{ id: 'bot-1111bbbb', role: 'lead' as const, presence: 'idle' as const, queueDepth: 2 }]]]),
  openQuestions: new Map([['ws-1', 3]]),
  delegations: [],
  ...over,
});

describe('applyFactoryToSidebar', () => {
  it('factory on: moa follows the HQ bot, legacy Moa fields are replaced, rows gain bots and openQuestions', () => {
    const out = applyFactoryToSidebar(legacy, on());
    expect(out.factory).toEqual({ enabled: true, hqBotId: 'bot-0000aaaa', hqWorkspaceId: 'ws-hq', hqSessionId: 'sess-1' });
    expect(out.moa).toBe(true);
    expect(out.moaWakeBlocked).toBeUndefined();
    expect(out.moaDelegations).toEqual([]);
    expect(out.workspaces[0]).toEqual({ id: 'ws-1', order: 0, pinned: false, bots: [{ id: 'bot-1111bbbb', role: 'lead', presence: 'idle', queueDepth: 2 }], openQuestions: 3 });
    expect(out.workspaces[1]).toEqual({ id: 'ws-hq', order: 1, pinned: false });
    // The daemon's parser keeps every factory field.
    expect(parsePhoneSidebarSnapshot(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });

  it('factory on: Fleet tickets pass through untouched; a dispatch has no ticket, so its handoff-id delegation pairs with none', () => {
    const ticket = { id: 'wl-1', taskId: 'task-1', origin: 'manual' as const, workspaceId: 'ws-1', title: 'A job', state: 'working' as const, updatedAt: 5 };
    const delegation = { taskId: 'h-01JAAAAAAA', workspaceId: 'ws-1', agentName: 'Lead', title: 'Fix it', state: 'working' as const, since: 6 };
    const out = applyFactoryToSidebar({ ...legacy, fleetTickets: [ticket] }, on({ delegations: [delegation] }));
    expect(out.fleetTickets).toEqual([ticket]);
    // The shipped app pairs a ticket with a delegation by `taskId` or `id`.
    expect(out.fleetTickets?.some((t) => t.taskId === delegation.taskId || t.id === delegation.taskId)).toBe(false);
    expect(out.moaDelegations).toEqual([delegation]);
  });

  it('factory on with no HQ bot: no moa, blocked no-hq-bot; unreadable handoffs leave delegations out', () => {
    const out = applyFactoryToSidebar(legacy, on({ hq: null, delegations: null }));
    expect(out.factory).toEqual({ enabled: true });
    expect(out.moa).toBeUndefined();
    expect(out.moaWakeBlocked).toBe('no-hq-bot');
    expect(out.moaDelegations).toBeUndefined();
  });

  it('factory off: the legacy fields stand; factory-off only when no legacy Moa is on', () => {
    const off = { enabled: false, hq: null, bots: new Map(), openQuestions: new Map(), delegations: null };
    expect(applyFactoryToSidebar(legacy, off)).toEqual({ ...legacy, factory: { enabled: false } });
    const { moa: _m, moaWakeBlocked: _b, ...noMoa } = legacy;
    expect(applyFactoryToSidebar(noMoa, off)).toEqual({ ...noMoa, factory: { enabled: false }, moaWakeBlocked: 'factory-off' });
  });

  it('the parser drops a malformed bot and factory field on its own', () => {
    const drops: string[] = [];
    const parsed = parsePhoneSidebarSnapshot({
      ...legacy,
      moaWakeBlocked: 'something-new',
      factory: { enabled: true, hqBotId: '', hqSessionId: 'a\nb' },
      workspaces: [{ id: 'ws-1', order: 0, pinned: false, openQuestions: -1, bots: [{ id: 'bot-1', role: 'chef', presence: 'idle', queueDepth: 0 }, { id: 'bot-2', role: 'lead', presence: 'idle', queueDepth: 0 }] }],
    }, (r) => drops.push(r));
    expect(parsed?.factory).toEqual({ enabled: true });
    expect(parsed?.moaWakeBlocked).toBeUndefined();
    expect(parsed?.workspaces[0]).toEqual({ id: 'ws-1', order: 0, pinned: false, bots: [{ id: 'bot-2', role: 'lead', presence: 'idle', queueDepth: 0 }] });
    expect(drops).toEqual(expect.arrayContaining(['factory.hqBotId', 'factory.hqSessionId', 'moaWakeBlocked', 'workspace.bots.row', 'workspace.openQuestions']));
  });
});

function handoff(over: Partial<Handoff>): Handoff {
  return {
    version: 1, id: 'h-1', runId: 'r-1', threadId: 'handoff:h-1', depth: 1, hopsInRun: 1,
    from: { kind: 'bot', workspaceId: 'ws-hq', botId: 'bot-0000aaaa' },
    to: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-1111bbbb' },
    kind: 'dispatch', attribution: { originator: { kind: 'human' }, chain: [] }, landing: 'room',
    payload: { title: 'Fix the flaky test' }, status: 'delivered', createdAt: 1, updatedAt: 1000,
    ...over,
  } as Handoff;
}

describe('delegationsFromHandoffs', () => {
  const NOW = 10 * PHONE_MOA_DELEGATION_RECENT_MS;
  const bot = (id: string) => (id === 'bot-1111bbbb' ? { name: 'Lead' } : null);

  it('maps open dispatches to working / blocked and recent ended ones to done / failed, newest first', () => {
    const rows = delegationsFromHandoffs([
      handoff({ id: 'h-open', updatedAt: NOW - 10 }),
      handoff({ id: 'h-ask', threadId: 'handoff:h-ask', status: 'queued', updatedAt: NOW - 20 }),
      handoff({ id: 'h-done', status: 'answered', updatedAt: NOW - 30 }),
      handoff({ id: 'h-refused', status: 'refused', updatedAt: NOW - 40 }),
      handoff({ id: 'h-old', status: 'answered', updatedAt: NOW - PHONE_MOA_DELEGATION_RECENT_MS - 1 }),
      handoff({ id: 'h-result', kind: 'result', updatedAt: NOW }),
      handoff({ id: 'h-human', to: { kind: 'human' }, updatedAt: NOW }),
    ], bot, (_ws, thread) => thread === 'handoff:h-ask', NOW);
    expect(rows.map((r) => [r.taskId, r.state])).toEqual([
      ['h-open', 'working'], ['h-ask', 'blocked'], ['h-done', 'done'], ['h-refused', 'failed'],
    ]);
    expect(rows[0]).toEqual({ taskId: 'h-open', workspaceId: 'ws-1', agentName: 'Lead', title: 'Fix the flaky test', state: 'working', since: NOW - 10 });
  });

  it('an unknown bot reads as "Bot", and the list is bounded', () => {
    const many = Array.from({ length: 30 }, (_, i) => handoff({ id: `h-${i}`, to: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-gone' }, updatedAt: NOW - i }));
    const rows = delegationsFromHandoffs(many, bot, () => false, NOW);
    expect(rows).toHaveLength(20);
    expect(rows[0].agentName).toBe('Bot');
  });
});
