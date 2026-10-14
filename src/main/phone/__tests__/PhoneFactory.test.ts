import { describe, expect, it, vi } from 'vitest';
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: vi.fn() }));
import { handlePhoneRoomCommand, withPhoneFactory, type PhoneFactoryPorts } from '../PhoneFactory';
import { fitSidebarToBudget } from '../PhoneWorkspaces';
import type { PhoneSidebarSnapshot } from '../../../shared/phoneFleetSidebar';

const sidebar: PhoneSidebarSnapshot = {
  activeWorkspaceId: null,
  workspaces: [{ id: 'ws-1', order: 0, pinned: false }],
  panes: [],
  moa: true,
};

const ports = (over: Partial<PhoneFactoryPorts> = {}): PhoneFactoryPorts => ({
  settings: () => ({ enabled: true, hqWorkspaceId: null }),
  bots: () => [],
  status: () => null,
  rooms: () => null,
  handoffs: () => null,
  roomFileExists: () => false,
  roomReadable: () => true,
  now: () => 1,
  ...over,
});

describe('withPhoneFactory', () => {
  it('leaves the snapshot as the renderer made it when the factory has not started or a store throws', () => {
    expect(withPhoneFactory(sidebar, ports({ bots: () => null }))).toBe(sidebar);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(withPhoneFactory(sidebar, ports({ bots: () => { throw new Error('boom'); } }))).toBe(sidebar);
    warn.mockRestore();
  });

  it('factory on with no bots: no moa, no-hq-bot; rooms down leaves counts out, not zero', () => {
    const out = withPhoneFactory(sidebar, ports());
    expect(out).toMatchObject({ factory: { enabled: true }, moaWakeBlocked: 'no-hq-bot' });
    expect(out).not.toHaveProperty('moa');
    expect(out.workspaces[0]).not.toHaveProperty('openQuestions');
  });
});

describe('withPhoneFactory — the bot the phone talks to', () => {
  const mk = (id: string, workspaceId: string, over: Record<string, unknown> = {}) => ({
    version: 1 as const, id, workspaceId, role: 'lead' as const, name: id, engine: { kind: 'claude-sdk' as const },
    triggers: [], budget: {}, enabled: true, createdAt: 1, updatedAt: 1, ...over,
  }) as unknown as NonNullable<ReturnType<PhoneFactoryPorts['bots']>>[number];
  const lead = mk('bot-0000000b', 'ws-1', { createdAt: 1 });
  const coord = mk('bot-0000000c', 'ws-1', { template: 'coordinator', role: 'moa', createdAt: 2 });

  it('serves the pinned bot as hqBotId, else the oldest Coordinator; its role stays a legacy label', () => {
    const pinned = withPhoneFactory(sidebar, ports({ bots: () => [lead, coord], settings: () => ({ enabled: true, hqWorkspaceId: null, phoneBotId: lead.id }) }));
    expect(pinned).toMatchObject({ moa: true, factory: { enabled: true, hqBotId: lead.id, hqWorkspaceId: 'ws-1' } });
    const auto = withPhoneFactory(sidebar, ports({ bots: () => [lead, coord] }));
    expect(auto.factory).toMatchObject({ hqBotId: coord.id });
    expect(auto.workspaces[0].bots?.map((b) => b.role)).toEqual(['lead', 'moa']);
  });
});

describe('handlePhoneRoomCommand', () => {
  it('answers only its two commands, and fails closed', () => {
    expect(handlePhoneRoomCommand('workspaces.list', {}, ports())).toBeNull();
    expect(handlePhoneRoomCommand('workspaces.roomThreads', { workspaceId: '../x' }, ports())).toEqual({ invalid: true });
    expect(handlePhoneRoomCommand('workspaces.roomThreads', { workspaceId: 'ws-1' }, ports())).toEqual({ unavailable: true });
    expect(handlePhoneRoomCommand('workspaces.roomCards', { workspaceId: 'ws-1', limit: 5 }, ports({ bots: () => null }))).toEqual({ unavailable: true });
  });

  it('a room file that exists but cannot be read is unavailable, never an empty room', () => {
    const rooms = { read: vi.fn(), summary: vi.fn(), threads: vi.fn(() => []) };
    const p = ports({ rooms: () => rooms, roomFileExists: () => true, roomReadable: () => false });
    expect(handlePhoneRoomCommand('workspaces.roomThreads', { workspaceId: 'ws-1' }, p)).toEqual({ unavailable: true });
    expect(handlePhoneRoomCommand('workspaces.roomCards', { workspaceId: 'ws-1', limit: 5 }, p)).toEqual({ unavailable: true });
    expect(rooms.threads).not.toHaveBeenCalled();
    expect(rooms.read).not.toHaveBeenCalled();
  });
});

describe('fitSidebarToBudget — factory rows', () => {
  it('drops per-workspace bots and question counts first, keeping the factory block', () => {
    const bots = Array.from({ length: 16 }, (_, i) => ({ id: `bot-${String(i).padStart(8, '0')}`, role: 'lead' as const, presence: 'idle' as const, queueDepth: 0 }));
    const big: PhoneSidebarSnapshot = {
      ...sidebar,
      factory: { enabled: true },
      workspaces: Array.from({ length: 50 }, (_, i) => ({ id: `ws-${i}`, order: i, pinned: false, bots, openQuestions: 1 })),
    };
    const drops: string[] = [];
    const fitted = fitSidebarToBudget({ workspaces: [] }, big, 20_000, (r) => drops.push(r));
    expect(drops[0]).toBe('budget.factoryRows');
    expect(fitted?.factory).toEqual({ enabled: true });
    expect(fitted?.workspaces.every((w) => w.bots === undefined && w.openQuestions === undefined)).toBe(true);
  });
});

describe('withPhoneFactory — bot pictures', () => {
  it('never puts a bot\'s picture into the phone snapshot', () => {
    const avatar = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(64, 'A')}`;
    const bot = {
      version: 1 as const, id: 'bot-0000000a', workspaceId: 'ws-1', role: 'moa' as const, name: 'Moa', engine: { kind: 'claude-sdk' as const },
      triggers: [], budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 0, maxWorkerHoursPerDay: 0, turnTimeoutMs: 60_000 },
      avatar, enabled: true, createdAt: 1, updatedAt: 1,
    };
    const out = withPhoneFactory(sidebar, ports({ bots: () => [bot] }));
    expect(out.workspaces[0]).toMatchObject({ bots: [{ id: 'bot-0000000a', role: 'moa' }] });
    expect(JSON.stringify(out)).not.toContain('data:image');
  });
});
