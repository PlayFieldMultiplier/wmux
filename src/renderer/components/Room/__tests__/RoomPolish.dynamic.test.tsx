// @vitest-environment jsdom
//
// The room dock's polish: the factory-off state and its Turn on, the HQ
// room folded to what needs the owner (open-question threads, the plan
// folded once answered, the report folded until opened) with the timeline
// keeping its share of the height, proposals answered in place, the
// composer naming the real bot it queued for, and the merge lane rows of
// Settings › Factory.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import type { RoomCard as RoomCardData, ThreadSummary } from '../../../../shared/room';
import type { BotProfile, BotStatus } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import { ALL_THREADS } from '../../../stores/slices/roomSlice';
import { setRoomsApiForTests, type RoomsApi } from '../../../hooks/useRoomSync';
import RoomDock, { HQ_PINNED_MIN_HEIGHT, THREADS_MIN_HEIGHT, hqVisibleThreads } from '../RoomDock';
import { HqRoom, planFit } from '../HqRoom';
import { RoomCard, PROPOSAL_RESOLUTION } from '../RoomCard';
import { RoomComposer, deliveryLine, predictedAddressees, sentFrom } from '../RoomComposer';
import { FactoryTab, parseDailyCap } from '../../Settings/FactoryTab';
import {
  setFactoryBotPort,
  setFactorySettingsPort,
  type FactoryBotPort,
  type FactoryBotRow,
  type FactorySettingsPort,
  type FactorySettingsView,
} from '../factoryPorts';

const WS = 'ws-a';
const HQ = 'ws-hq';
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({
    roomStatus: null, roomThreads: {}, roomTimelines: {}, roomSelectedThread: {}, roomReadThrough: {}, roomPushCount: 0, roomPushedAt: {},
    roomScope: 'workspace', activeWorkspaceId: '', settingsInitialTab: null,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  setRoomsApiForTests(undefined);
  setFactorySettingsPort(null);
  setFactoryBotPort(null);
});

async function render(el: React.ReactElement) {
  await act(async () => root.render(el));
}

function summary(threadId: ThreadSummary['threadId'], over: Partial<ThreadSummary> = {}): ThreadSummary {
  return { threadId, title: `T ${threadId}`, lastAt: 0, lastSeq: 0, cardCount: 1, openQuestions: 0, lastKind: 'status', status: 'open', unread: null, ...over };
}

function card(seq: number, over: Partial<RoomCardData> = {}): RoomCardData {
  return { version: 1, id: `c${seq}`, seq, workspaceId: WS, threadId: 'general', kind: 'status', at: 1, actor: { kind: 'system' }, title: `card ${seq}`, ...over };
}

function bot(id: string, over: Partial<BotProfile> = {}): BotProfile {
  return {
    version: 1, id, workspaceId: WS, role: 'lead', name: `Bot ${id}`, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}

function running(botId: string, wakeId: string): BotStatus {
  return { botId, presence: 'running', currentTurn: { wakeId, startedAt: 1 }, queueDepth: 0, budgetLeft: { turnsHour: 1, turnsDay: 1, workerHoursDay: 1 } };
}

function fakeApi(over: Record<string, unknown> = {}) {
  const api = {
    status: vi.fn(async () => ({ running: true, enabled: true, hqWorkspaceId: null })),
    threads: vi.fn(async () => ({ ok: true, workspaceId: WS, threads: [] })),
    read: vi.fn(async () => ({ ok: true, workspaceId: WS, threadId: null, cards: [], nextSinceSeq: 0, hasMore: false })),
    post: vi.fn(async () => ({ ok: true, card: card(9), addressee: null })),
    resolve: vi.fn(async () => ({ ok: true, card: card(1) })),
    decision: vi.fn(async () => ({ decision: null })),
    actors: vi.fn(async () => ({ actors: {} })),
    onEvent: vi.fn(() => () => undefined),
  };
  return Object.assign(api, over) as typeof api;
}

const VIEW: FactorySettingsView = {
  version: 1, enabled: true, hqWorkspaceId: null, trustedAuthors: [], morning: { hour: 9, weekdays: [1] },
  verifierOnOwnerPrs: true, defaultEngine: { kind: 'claude-sdk' }, globalConcurrentBots: 2, laneAutoMerge: false, laneDailyCap: 5,
};

function settingsPort(view: FactorySettingsView = VIEW, available = true) {
  const port = {
    available,
    get: vi.fn(async () => view),
    set: vi.fn(async (p: Partial<FactorySettingsView>) => ({ ...view, ...p })),
  };
  return port as typeof port & FactorySettingsPort;
}

const NO_BOTS: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }) };

describe('RoomDock with the factory off', () => {
  it('says what the factory is; Turn on writes enabled through the settings port and re-reads the status', async () => {
    const api = fakeApi();
    setRoomsApiForTests(api as unknown as RoomsApi);
    const port = settingsPort({ ...VIEW, enabled: false });
    setFactorySettingsPort(port);
    useStore.setState({ roomStatus: { running: true, enabled: false, hqWorkspaceId: null }, activeWorkspaceId: WS });
    await render(createElement(RoomDock));
    expect(container.querySelector('[data-testid="room-factory-off"]')?.textContent).toContain('Bots work in each workspace');
    // Nothing of a room is drawn while off, and no room is read.
    expect(container.querySelector('[data-testid="room-composer"]')).toBeNull();
    expect(container.querySelector('[data-testid="room-threads"]')).toBeNull();
    expect(api.threads).not.toHaveBeenCalled();
    const turnOn = container.querySelector<HTMLButtonElement>('[data-testid="room-factory-turn-on"]')!;
    expect(turnOn.className).toContain('ui-btn-primary');
    await act(async () => turnOn.click());
    expect(port.set).toHaveBeenCalledWith({ enabled: true });
    expect(api.status).toHaveBeenCalled();
    expect(useStore.getState().roomStatus?.enabled).toBe(true);
  });

  it('a runtime that has not started says so; the settings link opens Settings › Factory', async () => {
    setRoomsApiForTests(fakeApi({ status: vi.fn(async () => ({ running: false, enabled: false, hqWorkspaceId: null })) }) as unknown as RoomsApi);
    const port = settingsPort({ ...VIEW, enabled: false });
    port.set.mockResolvedValueOnce(null as never);
    setFactorySettingsPort(port);
    useStore.setState({ roomStatus: { running: false, enabled: false, hqWorkspaceId: null }, activeWorkspaceId: WS });
    await render(createElement(RoomDock));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-factory-turn-on"]')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Bots haven't started yet. Try again in a moment.");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-factory-settings"]')!.click());
    expect(useStore.getState().settingsInitialTab).toBe('factory');
  });

  it('without a factory settings port there is no Turn on, only the settings link', async () => {
    setRoomsApiForTests(fakeApi() as unknown as RoomsApi);
    setFactorySettingsPort(settingsPort(VIEW, false));
    useStore.setState({ roomStatus: { running: true, enabled: false, hqWorkspaceId: null }, activeWorkspaceId: WS });
    await render(createElement(RoomDock));
    expect(container.querySelector('[data-testid="room-factory-turn-on"]')).toBeNull();
    expect(container.querySelector('[data-testid="room-factory-settings"]')).not.toBeNull();
  });
});

/** A clamp(min, calc(p% - k px), max) floor at a dock height. */
function floorAt(rule: string, dock: number): number {
  const m = /clamp\((\d+)px, calc\((\d+)% - (\d+)px\), (\d+)px\)/.exec(rule)!;
  const [lo, pct, off, hi] = m.slice(1).map(Number);
  return Math.min(hi, Math.max(lo, (dock * pct) / 100 - off));
}

describe('HQ room height', () => {
  it('the floors leave room for the header, the timeline\'s 40% and the composer down to the smallest window', () => {
    // The HQ room has no row of its own bots (its strip of every bot holds them).
    const HEADER = 40;
    const COMPOSER = 156; // two rows of role chips, as measured at 1280x800
    for (const dock of [550, 650, 750, 1000]) {
      const used = HEADER + floorAt(HQ_PINNED_MIN_HEIGHT, dock) + floorAt(THREADS_MIN_HEIGHT, dock) + 0.4 * dock + COMPOSER;
      expect(used, `dock ${dock}px`).toBeLessThanOrEqual(dock);
    }
    // Full floors at the measured 800px window (dock 750): the plan's
    // answers, and the threads toggle (28) over the All activity row (31.5),
    // the 1px gap and one whole two-line thread row (48) — measured live, a
    // 100px floor cut that row's second line — and not the 4px top margin of
    // what follows (Show all threads), so nothing of it peeks in.
    expect(floorAt(HQ_PINNED_MIN_HEIGHT, 750)).toBe(132);
    expect(floorAt(THREADS_MIN_HEIGHT, 750)).toBe(112);
    expect(floorAt(THREADS_MIN_HEIGHT, 750)).toBeGreaterThanOrEqual(28 + 31.5 + 1 + 48);
  });

  it('lists only the threads with an open question (and the shown one) until asked for all', () => {
    const threads = [summary('general'), summary('pr:o/r#1', { openQuestions: 1 }), summary('task:t1'), summary('plan:p1')];
    expect(hqVisibleThreads(threads, ALL_THREADS).map((th) => th.threadId)).toEqual(['pr:o/r#1']);
    expect(hqVisibleThreads(threads, 'task:t1').map((th) => th.threadId)).toEqual(['pr:o/r#1', 'task:t1']);
  });

  it('the dock folds the HQ threads, unfolds them on request, and keeps the cards at least 40% of the height', async () => {
    const threads = [summary('general'), summary('pr:o/r#1', { openQuestions: 1, title: 'Merge #1?' }), summary('task:t1'), summary('plan:p1')];
    const plan = card(7, { workspaceId: HQ, threadId: 'plan:p1', kind: 'plan', state: 'open', title: 'Plan', actor: { kind: 'bot', workspaceId: HQ, botId: 'bot-moa' } });
    setRoomsApiForTests(fakeApi({
      threads: vi.fn(async () => ({ ok: true, workspaceId: HQ, threads })),
      read: vi.fn(async () => ({ ok: true, workspaceId: HQ, threadId: null, cards: [plan], nextSinceSeq: 7, hasMore: false })),
    }) as unknown as RoomsApi);
    setFactoryBotPort(NO_BOTS);
    useStore.setState({ roomStatus: { running: true, enabled: true, hqWorkspaceId: HQ }, activeWorkspaceId: '' });
    await render(createElement(RoomDock));
    const rows = () => [...container.querySelectorAll('[data-testid="room-thread-row"]')].map((r) => r.getAttribute('data-thread-id'));
    expect(container.querySelector('[data-testid="room-dock"]')?.getAttribute('data-room-hq')).toBe('true');
    expect(rows()).toEqual(['pr:o/r#1']);
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="room-threads-show-all"]')!;
    expect(toggle.textContent).toBe('Show all threads (3 more)');
    // The folded list still says how many questions wait.
    expect(container.querySelector('[data-threads-questions]')?.textContent).toBe('1 open');
    await act(async () => toggle.click());
    expect(rows()).toHaveLength(4);
    expect(container.querySelector('[data-testid="room-threads-show-all"]')?.textContent).toBe('Show only open questions');
    // Layout contract (jsdom has no layout): the timeline holds a 40% floor,
    // the threads give way and are capped.
    expect(container.querySelector('[data-testid="room-timeline-region"]')?.className).toContain('min-h-[40%]');
    const threadsRegion = container.querySelector('[data-testid="room-threads"]')!.className;
    expect(threadsRegion).toMatch(/\bshrink\b/);
    expect(threadsRegion).toContain('max-h-[30%]');
    expect((container.querySelector('[data-testid="room-threads"]') as HTMLElement).style.minHeight).toBe(THREADS_MIN_HEIGHT);
    await act(async () => { await Promise.resolve(); });
    expect((container.querySelector('[data-testid="hq-room"]') as HTMLElement).style.minHeight).toBe(HQ_PINNED_MIN_HEIGHT);
  });

  it('the HQ room shows its bots once, in the strip of every bot', async () => {
    setRoomsApiForTests(fakeApi({ threads: vi.fn(async () => ({ ok: true, workspaceId: HQ, threads: [] })) }) as unknown as RoomsApi);
    const rows: FactoryBotRow[] = [{ bot: bot('bot-moa', { role: 'moa', name: 'Moa', workspaceId: HQ }), status: null }];
    setFactoryBotPort({ ...NO_BOTS, list: async () => rows });
    useStore.setState({ roomStatus: { running: true, enabled: true, hqWorkspaceId: HQ }, activeWorkspaceId: '' });
    await render(createElement(RoomDock));
    await act(async () => { await Promise.resolve(); });
    const lists = [...container.querySelectorAll('[data-testid="room-bot-chips"]')];
    expect(lists).toHaveLength(1);
    expect(lists[0].closest('[data-testid="hq-bots"]')).not.toBeNull();
  });

  it('the threads keep no floor while no thread row is listed', async () => {
    const threads = [summary('general'), summary('task:t1')];
    setRoomsApiForTests(fakeApi({ threads: vi.fn(async () => ({ ok: true, workspaceId: HQ, threads })) }) as unknown as RoomsApi);
    setFactoryBotPort(NO_BOTS);
    useStore.setState({ roomStatus: { running: true, enabled: true, hqWorkspaceId: HQ }, activeWorkspaceId: '' });
    await render(createElement(RoomDock));
    expect(container.querySelectorAll('[data-testid="room-thread-row"]')).toHaveLength(0);
    expect((container.querySelector('[data-testid="room-threads"]') as HTMLElement).style.minHeight).toBe('');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-threads-show-all"]')!.click());
    expect(container.querySelectorAll('[data-testid="room-thread-row"]')).toHaveLength(2);
    expect((container.querySelector('[data-testid="room-threads"]') as HTMLElement).style.minHeight).toBe(THREADS_MIN_HEIGHT);
  });

  it('a workspace room lists every thread, with no fold toggle', async () => {
    const threads = [summary('general'), summary('task:t1'), summary('task:t2', { openQuestions: 1 })];
    setRoomsApiForTests(fakeApi({ threads: vi.fn(async () => ({ ok: true, workspaceId: WS, threads })) }) as unknown as RoomsApi);
    setFactoryBotPort(NO_BOTS);
    useStore.setState({ roomStatus: { running: true, enabled: true, hqWorkspaceId: null }, activeWorkspaceId: WS });
    await render(createElement(RoomDock));
    expect(container.querySelectorAll('[data-testid="room-thread-row"]')).toHaveLength(3);
    expect(container.querySelector('[data-testid="room-threads-show-all"]')).toBeNull();
  });

  it('the plan folds once answered; the report stays folded to its title until opened; the pinned region gives way', async () => {
    setRoomsApiForTests(fakeApi() as unknown as RoomsApi);
    const page = (planState: 'open' | 'resolved') => useStore.getState().setRoomPage(HQ, ALL_THREADS, {
      cards: [
        card(1, { workspaceId: HQ, kind: 'report', title: 'Morning report', body: '- #1 merged' }),
        card(2, { workspaceId: HQ, kind: 'plan', title: 'Plan', state: planState, body: '1. do it' }),
      ],
      nextSinceSeq: 2,
      hasMore: false,
    }, 'replace');
    page('open');
    await render(createElement(HqRoom, { workspaceId: HQ, allBots: [], t, workspaceName: (id: string) => id }));
    expect(container.querySelector('[data-testid="hq-room"]')?.className).toMatch(/\bshrink\b.*max-h-\[34%\]/);
    // Open: the answers sit right under the title, before a clamped preview.
    const plan = container.querySelector('[data-testid="hq-plan"]')!;
    const actions = plan.querySelector('[data-plan-actions]')!;
    expect(plan.querySelector('[data-plan-body]')?.getAttribute('data-clamped')).toBe('true');
    expect(actions.compareDocumentPosition(plan.querySelector('[data-plan-body]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('[data-report-body]')).toBeNull();
    expect(container.querySelector('[data-testid="hq-report"]')?.textContent).toContain('Morning report');
    await act(async () => page('resolved'));
    expect(container.querySelector('[data-plan-body]')).toBeNull();
    expect(container.querySelector('[data-testid="hq-plan"]')?.textContent).toContain('Plan');
    expect(container.querySelector('[data-plan-actions]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="hq-plan-more"]')!.click());
    expect(container.querySelector('[data-plan-body]')?.textContent).toContain('do it');
    expect(container.querySelector('[data-plan-body]')?.getAttribute('data-clamped')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="hq-report-more"]')!.click());
    expect(container.querySelector('[data-report-body]')?.textContent).toContain('#1 merged');
  });

  it('a plan already answered when the room opens starts folded', async () => {
    setRoomsApiForTests(fakeApi() as unknown as RoomsApi);
    useStore.getState().setRoomPage(HQ, ALL_THREADS, {
      cards: [card(2, { workspaceId: HQ, kind: 'plan', title: 'Plan', state: 'resolved', body: '1. do it' })],
      nextSinceSeq: 2,
      hasMore: false,
    }, 'replace');
    await render(createElement(HqRoom, { workspaceId: HQ, allBots: [], t, workspaceName: (id: string) => id }));
    expect(container.querySelector('[data-plan-body]')).toBeNull();
    expect(container.querySelector('[data-testid="hq-plan-more"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('with nothing pinned the region keeps no floor: the bots take their own height', async () => {
    setRoomsApiForTests(fakeApi() as unknown as RoomsApi);
    const bots: FactoryBotRow[] = [{ bot: bot('bot-lead'), status: null }];
    await render(createElement(HqRoom, { workspaceId: HQ, allBots: bots, t, workspaceName: (id: string) => id, minHeight: HQ_PINNED_MIN_HEIGHT }));
    const region = container.querySelector<HTMLElement>('[data-testid="hq-room"]')!;
    expect(container.querySelector('[data-testid="hq-bots"]')).not.toBeNull();
    expect(region.style.minHeight).toBe('');
    // A pinned card brings the floor back.
    await act(async () => useStore.getState().setRoomPage(HQ, ALL_THREADS, {
      cards: [card(3, { workspaceId: HQ, kind: 'report', title: 'Morning report' })], nextSinceSeq: 3, hasMore: false,
    }, 'replace'));
    expect(region.style.minHeight).toBe(HQ_PINNED_MIN_HEIGHT);
  });

  it('an open plan gives way by its body only: the frame, title and answers never shrink', async () => {
    setRoomsApiForTests(fakeApi() as unknown as RoomsApi);
    useStore.getState().setRoomPage(HQ, ALL_THREADS, {
      cards: [
        card(1, { workspaceId: HQ, kind: 'report', title: 'Morning report', body: 'x' }),
        card(2, { workspaceId: HQ, kind: 'plan', title: 'Plan', state: 'open', body: '1. do it' }),
      ],
      nextSinceSeq: 2,
      hasMore: false,
    }, 'replace');
    await render(createElement(HqRoom, { workspaceId: HQ, allBots: [{ bot: bot('bot-lead'), status: null }], t, workspaceName: (id: string) => id }));
    const plan = container.querySelector<HTMLElement>('[data-testid="hq-plan"]')!;
    // The card itself never gives way to its neighbours; it is capped at the
    // region's height, and inside it the body is what shrinks.
    expect(plan.className).toMatch(/\bflex-col\b.*\bshrink-0\b.*\bmax-h-full\b/);
    for (const child of [...plan.children] as HTMLElement[]) {
      if (child.hasAttribute('data-plan-body')) expect(child.className).toMatch(/\bmin-h-0\b/);
      else expect(child.className, child.outerHTML.slice(0, 60)).toMatch(/\bshrink-0\b/);
    }
    expect(container.querySelector('[data-testid="hq-report"]')?.className).toMatch(/\bshrink-0\b/);
    expect(container.querySelector('[data-testid="hq-bots"]')?.className).toMatch(/\bshrink-0\b/);
    // Opened in full, the body is what the owner asked to read: the card
    // keeps its whole height and the region scrolls.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="hq-plan-more"]')!.click());
    expect(container.querySelector('[data-testid="hq-plan"]')!.className).not.toMatch(/max-h-full/);
    expect(container.querySelector('[data-plan-body]')!.className).toMatch(/\bshrink-0\b/);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="hq-plan-more"]')!.click());
    // Editing has no body to give: the card keeps its whole height.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="hq-plan-edit"]')!.click());
    expect(container.querySelector('[data-testid="hq-plan"]')!.className).not.toMatch(/max-h-full/);
  });

  it('planFit: the card keeps everything but its body; a cut preview ends on its last whole line', () => {
    // Lines of the rendered markdown need not be evenly spaced (a list after a paragraph).
    const lines = [21, 42, 71];
    // Every line fits: no clip; the floor is the card without its body.
    expect(planFit({ fixedHeight: 137, bodyHeight: 71, lineBottoms: lines })).toEqual({ minHeight: 137, clipBottom: 0 });
    // Squeezed to 60px: the third line is cut, so everything under the second goes.
    expect(planFit({ fixedHeight: 137, bodyHeight: 60, lineBottoms: lines })).toEqual({ minHeight: 137, clipBottom: 18 });
    // Squeezed under the first line: nothing of it shows.
    expect(planFit({ fixedHeight: 137, bodyHeight: 10, lineBottoms: lines })).toEqual({ minHeight: 137, clipBottom: 10 });
    // Lines the line clamp hides below a whole last line clip only the gap under it.
    expect(planFit({ fixedHeight: 137, bodyHeight: 64, lineBottoms: [21, 42, 63, 84, 105] })).toEqual({ minHeight: 137, clipBottom: 1 });
    // No lines measured (jsdom, an empty body): nothing is clipped.
    expect(planFit({ fixedHeight: 137, bodyHeight: 50, lineBottoms: [] }).clipBottom).toBe(0);
  });
});

describe('proposal cards', () => {
  it('an open proposal from a bot is approved or declined in place through room:resolve', async () => {
    const api = fakeApi();
    const proposal = card(4, { kind: 'proposal', state: 'open', title: 'Add a lint rule', actor: { kind: 'bot', workspaceId: HQ, botId: 'bot-1' } });
    await render(createElement(RoomCard, { card: proposal, workspaceId: HQ, t, bots: [], roomsBridge: api as unknown as RoomsApi }));
    const decline = container.querySelector<HTMLButtonElement>('[data-testid="room-proposal-decline"]')!;
    // Both secondary: the room's one primary is the HQ plan's Approve.
    expect(decline.className).not.toContain('ui-btn-primary');
    expect(container.querySelector('[data-testid="room-proposal-approve"]')?.className).not.toContain('ui-btn-primary');
    await act(async () => decline.click());
    expect(api.resolve).toHaveBeenCalledWith({ workspaceId: HQ, cardId: 'c4', resolution: PROPOSAL_RESOLUTION.decline });
  });

  it('a resolved proposal, or one no bot wrote, has no answers', async () => {
    const api = fakeApi();
    await render(createElement('div', null,
      createElement(RoomCard, { card: card(5, { kind: 'proposal', state: 'resolved', actor: { kind: 'bot', workspaceId: HQ, botId: 'bot-1' } }), workspaceId: HQ, t, bots: [], roomsBridge: api as unknown as RoomsApi }),
      createElement(RoomCard, { card: card(6, { kind: 'proposal', state: 'open', actor: { kind: 'system' } }), workspaceId: HQ, t, bots: [], roomsBridge: api as unknown as RoomsApi }),
    ));
    expect(container.querySelector('[data-testid="room-proposal-decline"]')).toBeNull();
  });
});

describe('composer: the real bot it queued for', () => {
  const lead: FactoryBotRow = { bot: bot('bot-lead', { name: 'Ada' }), status: running('bot-lead', 'w-other') };
  const moa: FactoryBotRow = { bot: bot('bot-moa', { name: 'Moa HQ', role: 'moa', workspaceId: HQ }), status: null };

  it('queued only behind a turn other than the one the message woke; several addressees are named or counted', () => {
    expect(deliveryLine([{ botId: 'bot-lead', role: 'lead', wakeId: 'w-mine' }], [lead], t)).toBe('room.composer.queuedFor(name=Ada)');
    const runningMine = { ...lead, status: running('bot-lead', 'w-mine') };
    expect(deliveryLine([{ botId: 'bot-lead', role: 'lead', wakeId: 'w-mine' }], [runningMine], t)).toBe('room.composer.sentTo(name=Ada)');
    expect(deliveryLine([{ botId: 'bot-moa', role: 'moa' }], [lead, moa], t)).toBe('room.composer.sentTo(name=Moa HQ)');
    expect(deliveryLine([{ botId: 'bot-lead', role: 'lead' }, { botId: 'bot-moa', role: 'moa' }], [lead, moa], t)).toBe('room.composer.sentTo(name=Ada, Moa HQ)');
    const four = ['a', 'b', 'c', 'd'].map((x) => ({ botId: `bot-${x}`, role: 'lead' as const }));
    expect(deliveryLine(four, [], t)).toBe('room.composer.sentToBots(count=4)');
    expect(deliveryLine(null, [], t)).toBe('room.composer.noAddressee');
    expect(deliveryLine([], [], t)).toBe('room.composer.noAddressee');
    expect(deliveryLine(undefined, [], t)).toBeNull();
    expect(sentFrom({ addressee: { botId: 'bot-lead', role: 'lead' }, wakeId: 'w-1' })).toEqual([{ botId: 'bot-lead', role: 'lead', wakeId: 'w-1' }]);
    expect(sentFrom({ addressee: null })).toBeNull();
  });

  it('predicts main\'s addressees: the mentioned bots that are on, else every bot of the room, oldest first', () => {
    const other: FactoryBotRow = { bot: bot('bot-other', { workspaceId: 'ws-b', name: 'Other lead' }), status: null };
    const late: FactoryBotRow = { bot: bot('bot-late', { name: 'Late', createdAt: 9 }), status: null };
    const rows = [late, other, lead, moa];
    expect(predictedAddressees(rows, WS, []).map((r) => r.bot.id)).toEqual(['bot-lead', 'bot-late']);
    expect(predictedAddressees(rows, WS, ['bot-moa', 'bot-gone']).map((r) => r.bot.id)).toEqual(['bot-moa']);
    expect(predictedAddressees(rows, HQ, []).map((r) => r.bot.id)).toEqual(['bot-moa']);
    expect(predictedAddressees([{ ...lead, bot: { ...lead.bot, enabled: false } }], WS, [])).toEqual([]);
  });

  it('before a send to a lone busy bot, names it as the one the message will wait for', async () => {
    const api = fakeApi();
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [lead, moa], t, api: api as unknown as RoomsApi }));
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'hi');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="room-composer-status"]')?.textContent).toBe('room.composer.willQueue(name=Ada)');
  });

  it('@Moa typed from a workspace room names the HQ bot from the bot list after the send', async () => {
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true, card: card(9), addressee: { botId: 'bot-moa', role: 'moa' }, wakeId: 'w-9' })) });
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [lead, { ...moa, status: running('bot-moa', 'w-1') }], t, api: api as unknown as RoomsApi }));
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '@Moa HQ plan tomorrow');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-composer-send"]')!.click());
    expect((api.post.mock.calls as unknown as Array<[unknown]>)[0][0]).toMatchObject({ mentions: ['bot-moa'] });
    expect(container.querySelector('[data-testid="room-composer-status"]')?.textContent).toBe('room.composer.queuedFor(name=Moa HQ)');
  });
});

describe('Settings › Factory merge lane rows', () => {
  it('parses the daily cap: whole numbers, capped at the maximum', () => {
    expect(parseDailyCap('7')).toBe(7);
    expect(parseDailyCap(' 0 ')).toBe(0);
    expect(parseDailyCap('99')).toBe(50);
    expect(parseDailyCap('')).toBeNull();
    expect(parseDailyCap('-1')).toBeNull();
    expect(parseDailyCap('2.5')).toBeNull();
  });

  it('auto-merge is off by default; the cap can be set before it is turned on, and saves on blur', async () => {
    const port = settingsPort();
    await render(createElement(FactoryTab, { settingsPort: port, botPort: NO_BOTS }));
    const sw = container.querySelector<HTMLButtonElement>('[data-testid="factory-lane-auto-merge"]')!;
    const cap = () => container.querySelector<HTMLInputElement>('[data-testid="factory-lane-daily-cap"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(cap().disabled).toBe(false);
    expect(cap().value).toBe('5');
    expect(container.querySelector('[data-setting-id="factorylaneautomerge"]')?.textContent).toContain('Merges bot pull requests that passed their Verifier and CI, up to the daily cap.');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(cap(), '7');
      cap().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { cap().focus(); cap().blur(); });
    expect(port.set).toHaveBeenLastCalledWith({ laneDailyCap: 7 });
    expect(cap().value).toBe('7');
    // The cap is saved while auto-merge is still off; turning it on is its own write.
    expect(port.set).not.toHaveBeenCalledWith({ laneAutoMerge: true });
    await act(async () => sw.click());
    expect(port.set).toHaveBeenLastCalledWith({ laneAutoMerge: true });
  });

  it('lists bot names as the bot port reports them', async () => {
    const rows: FactoryBotRow[] = [{ bot: bot('bot-lead', { name: 'Ada' }), status: null }];
    const port: FactoryBotPort = { ...NO_BOTS, list: async () => rows };
    await render(createElement(FactoryTab, { settingsPort: settingsPort(), botPort: port }));
    expect(container.querySelector('[data-testid="factory-bot-row"]')?.textContent).toContain('Ada');
  });
});
