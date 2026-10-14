// @vitest-environment jsdom
// The Bots rail page: the first screen, the conversation list (by latest
// activity, no pinned HQ; needs-you on the bot rows), adding a bot, a 1:1 and a group chat, the thread chip,
// sending to one bot, a worker's Open, the rail item's route and badge (the
// sum of the page's own rows) and the Toggle Company View shortcut.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { ALL_THREADS, timelineKey } from '../../../stores/slices/roomSlice';
import { setRoomsApiForTests, type RoomsApi } from '../../../hooks/useRoomSync';
import { setFactoryBotPort, type FactoryBotPort, type FactoryBotRow } from '../../Room/factoryPorts';
import type { RoomCard } from '../../../../shared/room';
import type { BotProfile, BotRole } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import type { Pane, Workspace } from '../../../../shared/types';
import BotsPage, { isStillStarting } from '../BotsPage';
import type { EnginePort } from '../botsEngine';
import MiniSidebar from '../../Sidebar/MiniSidebar';
import { chatCards, composerHint, oneToOneRefusal } from '../BotsChat';
import type { Conversation } from '../botsModel';
import { refreshApprovals, setApprovalsApiForTests, type ApprovalsApi } from '../../Room/approvalsStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEAD = 'bot-0000000a';
const VERIFIER = 'bot-0000000b';
const MOA = 'bot-0000000c';

function botRow(id: string, role: BotRole, workspaceId: string, createdAt: number, name: string, enabled = true): FactoryBotRow {
  const bot: BotProfile = {
    version: 1, id, workspaceId, role, name, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS[role], enabled, createdAt, updatedAt: createdAt,
    repo: { repoKey: 'github.com/acme/api', repoPath: '/r/api' },
  };
  return { bot, status: { botId: id, presence: 'idle', queueDepth: 0, budgetLeft: { turnsHour: 5, turnsDay: 30, workerHoursDay: 4 } } };
}

let seq = 0;
function card(p: Partial<RoomCard> & Pick<RoomCard, 'workspaceId' | 'actor'>): RoomCard {
  seq += 1;
  return { version: 1, id: `c${seq}`, seq, threadId: 'general', kind: 'status', at: 1_000 + seq, title: `card ${seq}`, ...p };
}
const by = (workspaceId: string, botId: string) => ({ kind: 'bot' as const, workspaceId, botId });

const leaf = (id: string): Pane => ({ id: `${id}-p`, type: 'leaf', ordinal: 1, surfaces: [], activeSurfaceId: '' }) as unknown as Pane;
const ws = (id: string, name: string): Workspace => ({ id, name, wsOrdinal: 1, rootPane: leaf(id), activePaneId: `${id}-p` }) as Workspace;

let bots: FactoryBotRow[];
let cards: RoomCard[];
let posted: Parameters<RoomsApi['post']>[0][];
let container: HTMLDivElement;
let root: Root;

const port: FactoryBotPort = {
  available: true,
  list: async () => bots,
  subscribe: () => () => undefined,
  act: async () => ({ ok: true }),
};

function api(): RoomsApi {
  return {
    status: vi.fn(async () => ({ running: true, enabled: true, hqWorkspaceId: 'hq' })),
    read: vi.fn(async (p: { workspaceId: string }) => {
      const mine = cards.filter((c) => c.workspaceId === p.workspaceId);
      return { ok: true as const, workspaceId: p.workspaceId, threadId: null, cards: mine, nextSinceSeq: mine.at(-1)?.seq ?? 0, hasMore: false };
    }),
    threads: vi.fn(async (workspaceId: string) => ({ ok: true as const, workspaceId, threads: [] })),
    post: vi.fn(async (p: Parameters<RoomsApi['post']>[0]) => {
      posted.push(p);
      const c = card({ workspaceId: p.workspaceId, actor: { kind: 'human' }, kind: 'human', title: p.title, refs: { botId: LEAD } });
      return { ok: true as const, card: c, addressee: { botId: LEAD, role: 'lead' as BotRole } };
    }),
    resolve: vi.fn(async () => ({ ok: false as const, code: 'x', message: 'x' })),
    decision: vi.fn(async () => ({ decision: null })),
    actors: vi.fn(async () => ({ actors: {} })),
    onEvent: vi.fn(() => () => undefined),
  } as unknown as RoomsApi;
}

function seedRooms(on = true) {
  const byWs = (id: string) => cards.filter((c) => c.workspaceId === id);
  act(() => useStore.setState({
    roomStatus: { running: true, enabled: on, hqWorkspaceId: 'hq' },
    workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), ws('t1', 'wtask: fix login')],
    activeWorkspaceId: 'hq',
    activeRemoteKey: null,
    appRoute: 'bots',
    roomThreads: { hq: [], w1: [] },
    roomTimelines: {
      [timelineKey('hq', ALL_THREADS)]: { cards: byWs('hq'), nextSinceSeq: 0, hasMore: false },
      [timelineKey('w1', ALL_THREADS)]: { cards: byWs('w1'), nextSinceSeq: 0, hasMore: false },
    },
    roomActors: {},
    fanoutOrigin: { t1: { kind: 'bot', botId: LEAD } },
    surfaceAgentStatus: {},
  } as never));
}

beforeEach(() => {
  seq = 0;
  posted = [];
  bots = [botRow(MOA, 'moa', 'hq', 1, 'Moa'), botRow(LEAD, 'lead', 'w1', 2, 'Lead'), botRow(VERIFIER, 'verifier', 'w1', 3, 'Verifier')];
  cards = [
    card({ workspaceId: 'hq', actor: by('hq', MOA), title: 'Morning, all quiet', at: 100 }),
    card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Started a worker on login', at: 200 }),
    card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', title: 'Thanks lead', refs: { botId: LEAD }, at: 210 }),
    card({ workspaceId: 'w1', actor: by('w1', VERIFIER), title: 'PR #1 passes', kind: 'verdict', threadId: 'pr:github.com/acme/api#1', at: 300 }),
    card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Merge #1 now?', kind: 'question', state: 'open', threadId: 'pr:github.com/acme/api#1', at: 400 }),
    card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', title: 'CI green on #1', at: 410 }),
  ];
  setFactoryBotPort(port);
  setRoomsApiForTests(api());
  vi.stubGlobal('electronAPI', { web: { status: vi.fn(async () => ({ running: false })) } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setFactoryBotPort(null);
  setRoomsApiForTests(undefined);
  vi.unstubAllGlobals();
});

const q = <E extends Element = HTMLElement>(sel: string) => container.querySelector<E & HTMLElement>(sel);
const rowIds = () => [...container.querySelectorAll('[data-bots-row]')].map((el) => el.getAttribute('data-bots-row'));
async function render(node: React.ReactNode) {
  await act(async () => { root.render(node); });
  await act(async () => { await Promise.resolve(); });
}

describe('Bots page', () => {
  it('bots off: the conversations and live workers stay, read-only, under a banner whose Turn bots on turns them on', async () => {
    // Opening the page asks main for the factory's state again.
    const off = api();
    off.status = vi.fn(async () => ({ running: true, enabled: false, hqWorkspaceId: 'hq' })) as unknown as RoomsApi['status'];
    setRoomsApiForTests(off);
    seedRooms(true);
    act(() => useStore.setState({
      workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), {
        ...ws('t1', 'wtask: fix login'),
        rootPane: { id: 't1-p', type: 'leaf', ordinal: 1, surfaces: [{ id: 's', ptyId: 'pty-t1', title: '', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }], activeSurfaceId: 's' },
      } as Workspace],
      surfaceAgent: { 'pty-t1': { name: 'Claude Code', status: 'running' } },
      surfaceAgentStatus: { 'pty-t1': 'running' },
    } as never));
    const settings = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => ({ enabled: true }) as never) };
    await render(<BotsPage settings={settings} />);
    expect(q('[data-bots-paused]')?.textContent).toContain('Bots are off');
    expect(q('[data-bots-run]')?.textContent).toBe('Turn bots on');
    // The list is all there, "+" too, and nothing is counted.
    expect(rowIds()).toEqual(['room:w1', `bot:${LEAD}`, `bot:${VERIFIER}`, `bot:${MOA}`, 'room:hq']);
    expect(q('[data-bots-add]')).not.toBeNull();
    expect(container.querySelectorAll('[data-bots-needs]')).toHaveLength(0);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    // The worker shows; the question shows without answers; nothing can be sent.
    expect(q('[data-bots-worker="t1"]')?.textContent).toContain('wtask: fix login');
    expect(container.querySelector('[data-testid="room-card"]')).toBeNull();
    expect(q('[data-room-card-id="c5"]')?.textContent).toContain('Merge #1 now?');
    expect(q<HTMLButtonElement>('[data-testid="bots-composer-send"]')!.disabled).toBe(true);
    expect(q('[data-testid="bots-composer-status"]')?.textContent).toBe('Bots are off. Turn bots on to message them.');
    await act(async () => { q('[data-bots-run]')!.click(); });
    expect(settings.set).toHaveBeenCalledWith({ enabled: true });
  });

  it('with no bot yet: one centred panel, a name and Start, which turns the bots on, adds the bot here and opens its chat', async () => {
    bots = [];
    const off = api();
    off.status = vi.fn(async () => ({ running: true, enabled: false, hqWorkspaceId: 'hq' })) as unknown as RoomsApi['status'];
    setRoomsApiForTests(off);
    seedRooms(false);
    act(() => useStore.setState({ activeWorkspaceId: 'w1' } as never));
    const created = botRow('bot-0000000e', 'lead', 'w1', 9, 'Ada').bot;
    const create = vi.fn(async () => ({ ok: true as const, bot: created }));
    const notify: Array<() => void> = [];
    setFactoryBotPort({ ...port, create, subscribe: (fn: () => void) => { notify.push(fn); return () => undefined; } } as unknown as FactoryBotPort);
    const settings = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => ({ enabled: true }) as never) };
    const engine: EnginePort = { readiness: vi.fn(async () => ({ ready: true })) };
    await render(<BotsPage settings={settings} engine={engine} />);
    // No list, no banner: the one panel, for the current workspace.
    expect(q('[data-bots-first-run]')?.textContent).toContain('Name your first bot');
    expect(q('[data-bots-first-run]')?.textContent).toContain('api');
    expect(q('[data-bots-paused]')).toBeNull();
    expect(q('[data-bots-row]')).toBeNull();
    const start = q<HTMLButtonElement>('[data-bots-first-start]')!;
    expect(start.disabled).toBe(true);
    const input = q<HTMLInputElement>('[data-bots-first-name]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ada');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(start.disabled).toBe(false);
    await act(async () => { start.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(settings.set).toHaveBeenCalledWith({ enabled: true });
    expect(create).toHaveBeenCalledWith({ workspaceId: 'w1', name: 'Ada' });
    // Its chat opens at once, starting, before the list shows the bot.
    expect(q('[data-bots-chat]')?.getAttribute('data-bots-chat')).toBe('bot:bot-0000000e');
    expect(q('[data-bots-starting]')?.textContent).toContain('Starting Ada');
    // Listed but not greeted yet: still starting.
    bots = [{ ...botRow('bot-0000000e', 'lead', 'w1', 9, 'Ada'), bot: created }];
    await act(async () => { for (const fn of notify) fn(); });
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-bots-starting]')).not.toBeNull();
    // The greeting arrives: the bot's chat replaces the placeholder.
    act(() => useStore.setState({
      roomStatus: { running: true, enabled: true, hqWorkspaceId: 'hq' },
      roomTimelines: {
        [timelineKey('w1', ALL_THREADS)]: { cards: [card({ workspaceId: 'w1', actor: by('w1', 'bot-0000000e'), kind: 'question', title: 'Hi, what should I do?', greeting: true, state: 'open' })], nextSinceSeq: 0, hasMore: false },
      },
    } as never));
    expect(q('[data-bots-starting]')).toBeNull();
    expect(q('[data-bots-chat]')?.getAttribute('data-bots-chat')).toBe('bot:bot-0000000e');
  });

  it('first screen: an engine that cannot sign in says why, offers Log in to Claude, and Start waits until it can', async () => {
    bots = [];
    seedRooms();
    const create = vi.fn(async () => ({ ok: false as const, code: 'invalid_argument' as const, message: 'x' }));
    setFactoryBotPort({ ...port, create } as unknown as FactoryBotPort);
    let ready = false;
    const engine: EnginePort = {
      readiness: vi.fn(async () => (ready ? { ready: true } : { ready: false, reason: 'claude-not-logged-in' as const })),
      login: vi.fn(async () => { ready = true; }),
    };
    await render(<BotsPage engine={engine} />);
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-bots-engine="claude-not-logged-in"]')?.textContent).toContain('Claude isn\'t signed in');
    const input = q<HTMLInputElement>('[data-bots-first-name]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ada');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(true);
    // One primary: Log in while Start waits.
    expect(q('[data-bots-engine-login]')?.className).toContain('ui-btn-primary');
    expect(q('[data-bots-first-start]')?.className).not.toContain('ui-btn-primary');
    await act(async () => { q('[data-bots-engine-login]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(engine.login).toHaveBeenCalledTimes(1);
    expect(q('[data-bots-engine]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(false);
  });

  it('first screen: Start waits for the engine\'s first answer', async () => {
    bots = [];
    seedRooms();
    setFactoryBotPort({ ...port, create: vi.fn() } as unknown as FactoryBotPort);
    let answer: (r: { ready: boolean }) => void = () => undefined;
    const engine: EnginePort = { readiness: () => new Promise((r) => { answer = r; }) };
    await render(<BotsPage engine={engine} />);
    const input = q<HTMLInputElement>('[data-bots-first-name]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ada');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(true);
    await act(async () => { answer({ ready: true }); });
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(false);
  });

  it('"+" while off: a job made invalid after the confirm opened closes it, and nothing is turned on', async () => {
    const off = api();
    off.status = vi.fn(async () => ({ running: true, enabled: false, hqWorkspaceId: 'hq' })) as unknown as RoomsApi['status'];
    setRoomsApiForTests(off);
    seedRooms(false);
    const create = vi.fn();
    setFactoryBotPort({ ...port, create } as unknown as FactoryBotPort);
    const settings = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => ({ enabled: true }) as never) };
    await render(<BotsPage settings={settings} />);
    act(() => q('[data-bots-add]')!.click());
    const dialog = document.querySelector('[data-testid="bots-add-bot"]')!;
    const name = dialog.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Triage');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => dialog.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!.click());
    expect(dialog.querySelector('[data-testid="factory-add-bot-on-confirm"]')).not.toBeNull();
    const job = dialog.querySelector<HTMLTextAreaElement>('[data-testid="factory-add-bot-job"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(job, 'bad\u0007job');
      job.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dialog.querySelector('[data-testid="factory-add-bot-on-confirm"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="factory-add-bot-blocked"]')).not.toBeNull();
    expect(settings.set).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('first screen: a build that cannot tell the engine\'s state never blocks Start', async () => {
    bots = [];
    seedRooms();
    setFactoryBotPort({ ...port, create: vi.fn() } as unknown as FactoryBotPort);
    await render(<BotsPage engine={{}} />);
    const input = q<HTMLInputElement>('[data-bots-first-name]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ada');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q('[data-bots-engine]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(false);
  });

  it('composerHint: a Lead\'s empty 1:1 asks for its first task; otherwise "Message <name>"', () => {
    const tt = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`;
    const conv = (role: BotRole): Conversation => ({
      kind: 'bot', id: 'bot:x', workspaceId: 'w1', row: botRow(LEAD, role, 'w1', 1, 'Lead'), last: null, lastAt: 0, needsYou: 0, openQuestions: 0, openApprovals: 0, workers: [],
    });
    expect(composerHint(conv('lead'), 0, 'Lead', tt)).toBe('botsPage.leadHint{"name":"Lead"}');
    expect(composerHint(conv('lead'), 2, 'Lead', tt)).toBe('botsPage.messageTo{"name":"Lead"}');
    expect(composerHint(conv('verifier'), 0, 'Lead', tt)).toBe('botsPage.messageTo{"name":"Lead"}');
  });

  it('a plan is answered on the Bots page with the room dock\'s own answers, naming workspaces', async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, card: cards[0] }));
    const plan = card({
      workspaceId: 'hq', actor: by('hq', MOA), kind: 'plan', state: 'open', threadId: 'plan:p-1', at: 500,
      title: 'Plan for today', body: '1. **Fix login** — workspace `w1`, size S. it breaks',
    });
    cards.push(plan);
    const a = api();
    a.resolve = resolve as unknown as RoomsApi['resolve'];
    setRoomsApiForTests(a);
    seedRooms();
    await render(<BotsPage api={a} />);
    // It waits on the owner: Moa's row counts it, and the rail sum with it.
    expect(q(`[data-bots-row="bot:${MOA}"] [data-bots-needs]`)?.textContent).toBe('1');
    act(() => q(`[data-bots-row="bot:${MOA}"]`)!.click());
    const bubble = q(`[data-room-card-id="${plan.id}"]`)!;
    expect(bubble.getAttribute('data-waits-on-owner')).toBe('true');
    expect(bubble.querySelector('[data-card-answers="plan"]')).not.toBeNull();
    expect(bubble.textContent).toContain('Fix login — api, size S');
    expect(bubble.textContent).not.toContain('`w1`');
    await act(async () => { bubble.querySelector<HTMLButtonElement>('[data-testid="hq-plan-approve"]')!.click(); });
    expect(resolve).toHaveBeenCalledWith({ workspaceId: 'hq', cardId: plan.id, resolution: 'approve' });
    // The HQ group shows the same answers.
    act(() => q('[data-bots-row="room:hq"]')!.click());
    expect(q(`[data-room-card-id="${plan.id}"] [data-card-answers="plan"]`)).not.toBeNull();
    // Editing, then the bots pause: the answers leave and the body is back.
    act(() => q<HTMLButtonElement>(`[data-room-card-id="${plan.id}"] [data-testid="hq-plan-edit"]`)!.click());
    expect(q(`[data-room-card-id="${plan.id}"] [data-card-body]`)).toBeNull();
    act(() => useStore.setState({ roomStatus: { running: true, enabled: false, hqWorkspaceId: 'hq' } } as never));
    expect(q(`[data-room-card-id="${plan.id}"] [data-testid="hq-plan-edit-input"]`)).toBeNull();
    expect(q(`[data-room-card-id="${plan.id}"] [data-card-body]`)?.textContent).toContain('Fix login');
  });

  it('system cards show their body (folded) in a group, and the ones about a bot\'s work in its 1:1', async () => {
    const reasons = 'The lane refused the merge:\n- no required checks\n- the file list was empty\n- the author is not trusted';
    cards.push(card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'refusal', threadId: 'pr:github.com/acme/api#1', title: 'Merge refused for #1 at abc1234', body: reasons, at: 420 }));
    const refusalId = cards[cards.length - 1].id;
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="room:w1"]')!.click());
    // It is a reply in the PR's thread: the thread's root says so, and the
    // thread opens beside the chat.
    expect(q(`[data-bots-messages] [data-room-card-id="${refusalId}"]`)).toBeNull();
    act(() => q('[data-bots-thread-summary="pr:github.com/acme/api#1"]')!.click());
    const line = q(`[data-bots-thread-panel] [data-room-card-id="${refusalId}"]`)!;
    expect(line.getAttribute('data-bots-bubble')).toBe('system');
    expect(line.textContent).toContain('Merge refused for #1');
    const body = line.querySelector('[data-card-body]')!;
    expect(body.textContent).toContain('no required checks');
    expect(body.getAttribute('data-clamped')).toBe('true');
    act(() => line.querySelector<HTMLButtonElement>('[data-card-more]')!.click());
    expect(line.querySelector('[data-card-body]')?.getAttribute('data-clamped')).toBeNull();
    // Lead asked in that PR's thread: the refusal is in Lead's 1:1 too; the
    // room-wide CI fact is not.
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-thread-summary="pr:github.com/acme/api#1"]')!.click());
    expect(q(`[data-bots-thread-panel] [data-room-card-id="${refusalId}"] [data-card-body]`)?.textContent).toContain('the author is not trusted');
    expect(q('[data-bots-messages] [data-room-card-id="c6"]')).toBeNull();
  });

  it('Stop in a bot\'s profile asks in place, then stops its turn and workers and says so', async () => {
    seedRooms();
    const stop = { stopBot: vi.fn(async () => ({ ok: true, workersStopped: 2 })) };
    act(() => useStore.setState({ toasts: [] } as never));
    await render(<BotsPage stop={stop} />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    act(() => q('[data-testid="bots-stop-bot"]')!.click());
    expect(stop.stopBot).not.toHaveBeenCalled();
    expect(q('[data-testid="bots-stop-bot-confirm-row"]')?.textContent).toContain("Stop Lead's turn and its workers?");
    // Cancel keeps it running.
    act(() => q('[data-testid="bots-stop-bot-cancel"]')!.click());
    expect(q('[data-testid="bots-stop-bot-confirm-row"]')).toBeNull();
    act(() => q('[data-testid="bots-stop-bot"]')!.click());
    await act(async () => { q('[data-testid="bots-stop-bot-confirm"]')!.click(); });
    expect(stop.stopBot).toHaveBeenCalledWith(LEAD);
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Stopped Lead and 2 of its workers.');
  });

  it('Stop all bots: the header menu, an inline confirm, then the counts that are not zero', async () => {
    seedRooms();
    const stop = { stopAll: vi.fn(async () => ({ ok: true, botsInterrupted: 1, workersStopped: 3, gatesCancelled: 0 })) };
    act(() => useStore.setState({ toasts: [] } as never));
    await render(<BotsPage stop={stop} />);
    act(() => q('[data-bots-menu]')!.click());
    act(() => q('[data-bots-stop-all]')!.click());
    expect(stop.stopAll).not.toHaveBeenCalled();
    expect(q('[data-testid="bots-stop-all-confirm-row"]')).not.toBeNull();
    await act(async () => { q('[data-testid="bots-stop-all-confirm"]')!.click(); });
    expect(stop.stopAll).toHaveBeenCalledTimes(1);
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Stopped: bot turns 1, workers 3');
    expect(q('[data-testid="bots-stop-all-confirm-row"]')).toBeNull();
  });

  it('without the stop verbs there is no menu and no Stop', async () => {
    seedRooms();
    await render(<BotsPage stop={{}} />);
    expect(q('[data-bots-menu]')).toBeNull();
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    expect(q('[data-testid="bots-stop-bot"]')).toBeNull();
  });

  it('lists rooms and bots by latest activity (the HQ room is not pinned), with needs-you on the bot that asked', async () => {
    seedRooms();
    await render(<BotsPage />);
    expect(rowIds()).toEqual(['room:w1', `bot:${LEAD}`, `bot:${VERIFIER}`, `bot:${MOA}`, 'room:hq']);
    expect(container.textContent).not.toContain('HQ');
    // Lead: one open question and its worker t1 (status not reported: not live).
    expect(q(`[data-bots-row="bot:${LEAD}"] [data-bots-needs]`)?.textContent).toBe('1');
    expect(q(`[data-bots-row="bot:${VERIFIER}"] [data-bots-needs]`)).toBeNull();
    expect(q('[data-bots-row="room:w1"] [data-bots-needs]')).toBeNull();
    // Previews: the newest message, the owner's as "You: …".
    expect(q(`[data-bots-row="bot:${VERIFIER}"]`)?.textContent).toContain('PR #1 passes');
    expect(q('[data-bots-row="room:w1"]')?.textContent).toContain('CI green on #1');
  });

  it('a 1:1 shows only that bot\'s cards and the owner\'s messages to it; a group shows the room', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q('[data-bots-page]')?.getAttribute('data-view')).toBe('chat');
    const shown = () => [...container.querySelectorAll('[data-bots-messages] [data-room-card-id]')].map((el) => el.getAttribute('data-room-card-id'));
    expect(shown()).toEqual(['c2', 'c3', 'c5']);
    expect(q('[data-bots-bubble="owner"]')?.textContent).toContain('Thanks lead');
    expect(q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')?.placeholder).toBe('Message Lead');
    act(() => q('[data-bots-row="room:w1"]')!.click());
    expect(shown()).toEqual(['c2', 'c3', 'c4', 'c5', 'c6']);
    expect(q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')?.placeholder).toBe('Message api');
    // Back (the narrow layout's list) and the profile under the pill.
    act(() => q('[data-bots-back]')!.click());
    expect(q('[data-bots-page]')?.getAttribute('data-view')).toBe('list');
  });

  it('a thread chip opens the thread beside the chat; the main timeline stays as it was', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="room:w1"]')!.click());
    const shown = (scope: string) => [...container.querySelectorAll(`${scope} [data-room-card-id]`)].map((el) => el.getAttribute('data-room-card-id'));
    // The thread's root (the verdict) and its open question (it waits on the
    // owner) both stay in the main timeline; the root says how many replies.
    expect(shown('[data-bots-messages]')).toEqual(['c2', 'c3', 'c4', 'c5', 'c6']);
    expect(q('[data-bots-thread-summary="pr:github.com/acme/api#1"]')?.textContent).toContain('1 reply');
    act(() => q('[data-room-card-id="c4"] [data-bots-thread-chip="pr:github.com/acme/api#1"]')!.click());
    expect(q('[data-bots-thread-panel]')?.getAttribute('data-bots-thread-panel')).toBe('pr:github.com/acme/api#1');
    expect(shown('[data-bots-thread-panel]')).toEqual(['c4', 'c5']);
    expect(shown('[data-bots-messages]')).toHaveLength(5);
    // Its composer posts into the thread.
    expect(q<HTMLTextAreaElement>('[data-bots-thread-panel] [data-testid="bots-composer-input"]')?.placeholder).toBe('Reply in thread');
    act(() => q('[data-bots-thread-close]')!.click());
    expect(q('[data-bots-thread-panel]')).toBeNull();
  });

  it('sends a 1:1 message to that bot (it is the one mention) and says who got it', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const input = q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(input, 'Please rebase');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('[data-testid="bots-composer-send"]')!.click(); });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ workspaceId: 'w1', threadId: 'general', title: 'Please rebase', mentions: [LEAD] });
    expect(posted[0].to).toBeUndefined();
    // The posted card arrives by push; its delivery line names the bot.
    const sentCard = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', title: 'Please rebase', refs: { botId: LEAD } });
    act(() => useStore.getState().applyRoomEvent({ workspaceId: 'w1', card: { ...sentCard, id: `c${seq - 1}` }, threadSummary: { threadId: 'general', title: 'General', lastAt: 1, lastSeq: 1, cardCount: 1, openQuestions: 0, lastKind: 'human', status: 'open', unread: null } }));
    expect(q('[data-bots-delivery]')?.textContent).toBe('Sent to Lead');
  });

  it('a group message goes to the whole room unless a bot is picked (a chip, or a typed @name)', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="room:w1"]')!.click());
    const input = q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Status?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('[data-testid="bots-composer-send"]')!.click(); });
    expect(posted[0]).toMatchObject({ workspaceId: 'w1', title: 'Status?' });
    expect(posted[0].to).toBeUndefined();
    expect(posted[0].mentions).toBeUndefined();
    expect(q('[data-testid="bots-composer-to-room"]')).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '@Lead rebase please');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q(`[data-testid="bots-composer-bot"][data-bot-id="${LEAD}"]`)?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { q('[data-testid="bots-composer-send"]')!.click(); });
    expect(posted[1]).toMatchObject({ workspaceId: 'w1', mentions: [LEAD] });
  });

  it('a live worker shows in its bot\'s conversation; Open shows its terminal beside the chat, never switching workspace', async () => {
    seedRooms();
    // t1 is running.
    act(() => useStore.setState({
      workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), {
        ...ws('t1', 'wtask: fix login'),
        rootPane: { id: 't1-p', type: 'leaf', ordinal: 1, surfaces: [{ id: 's', ptyId: 'pty-t1', title: '', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }], activeSurfaceId: 's' },
      } as Workspace],
      surfaceAgent: { 'pty-t1': { name: 'Claude Code', status: 'awaiting_input' } },
      surfaceAgentStatus: { 'pty-t1': 'awaiting_input' },
    } as never));
    await render(<BotsPage />);
    expect(q(`[data-bots-row="bot:${LEAD}"] [data-bots-needs]`)?.textContent).toBe('2');
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const worker = q('[data-bots-worker="t1"]');
    expect(worker?.textContent).toContain('wtask: fix login');
    expect(worker?.getAttribute('data-worker-waiting')).toBe('true');
    // It sits in the working rail above the composer, not in the history.
    expect(q('[data-bots-rail] [data-bots-worker="t1"]')).not.toBeNull();
    expect(q('[data-bots-messages] [data-bots-worker]')).toBeNull();
    act(() => q('[data-bots-worker-open="t1"]')!.click());
    expect(useStore.getState().activeWorkspaceId).toBe('hq');
    expect(useStore.getState().appRoute).toBe('bots');
    expect(useStore.getState().botsWorkerPanel).toEqual({ workspaceId: 't1', conversationId: `bot:${LEAD}` });
    expect(q('[data-bots-worker-panel="t1"]')).not.toBeNull();
    expect(q('[data-bots-worker-open="t1"]')?.getAttribute('aria-pressed')).toBe('true');
    // Close closes it; another conversation closes it too.
    act(() => q('[data-bots-worker-panel-close]')!.click());
    expect(q('[data-bots-worker-panel]')).toBeNull();
    act(() => q('[data-bots-worker-open="t1"]')!.click());
    act(() => q('[data-bots-row="room:w1"]')!.click());
    expect(useStore.getState().botsWorkerPanel).toBeNull();
    expect(q('[data-bots-worker-panel]')).toBeNull();
  });

  it('a done task offers Open only while its pane is open; a cleared one offers Resume, which shows the new pane beside the chat', async () => {
    seedRooms();
    const now = Date.now();
    const task = (taskId: string, taskWorkspaceId: string, extra: Record<string, unknown> = {}) => ({
      taskId, taskWorkspaceId, ownerWorkspaceId: 'w1', botId: LEAD, title: `task ${taskId}`, status: 'completed' as const,
      stage: 'closed' as const, worker: 'resumable' as const, updatedAt: now, ...extra,
    });
    bots[1] = { ...bots[1], tasks: [task('wtask-kept-00000001', 't1'), task('wtask-gone-00000002', 't-gone'), task('wtask-moved-0000003', 't-gone', { workerWorkspaceId: 't1' })] };
    const resumeWorker = vi.fn(async () => ({ ok: true, workspaceId: 't1' }));
    setFactoryBotPort({ ...port, resumeWorker });
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const bubble = (id: string) => q(`[data-bots-task="${id}"]`)!;
    expect(bubble('wtask-kept-00000001').querySelector('[data-bots-worker-open="t1"]')).not.toBeNull();
    expect(bubble('wtask-gone-00000002').querySelector('[data-bots-worker-open]')).toBeNull();
    expect(bubble('wtask-gone-00000002').textContent).toContain('Done');
    // A resume opened a new pane: Open goes there.
    expect(bubble('wtask-moved-0000003').querySelector('[data-bots-worker-open="t1"]')).not.toBeNull();
    await act(async () => { (bubble('wtask-gone-00000002').querySelector('[data-bots-task-resume]') as HTMLButtonElement).click(); });
    expect(resumeWorker).toHaveBeenCalledWith('wtask-gone-00000002');
    expect(useStore.getState().activeWorkspaceId).toBe('hq');
    expect(useStore.getState().botsWorkerPanel?.workspaceId).toBe('t1');
    expect(q('[data-bots-worker-panel="t1"]')).not.toBeNull();
    act(() => useStore.getState().setBotsWorkerPanel(null));
  });

  it('a worker waiting on input shows in its bot\'s 1:1 and in the room, with Open, though its pane reads idle', async () => {
    seedRooms();
    const now = Date.now();
    const task = (taskId: string, taskWorkspaceId: string, stage: 'working' | 'needs_input', title: string) => ({
      taskId, taskWorkspaceId, ownerWorkspaceId: 'w1', botId: LEAD, title, status: stage === 'working' ? 'working' as const : 'input_required' as const, stage, updatedAt: now,
    });
    // t1 asked for input (its stopped Claude reads idle on Fleet); t-gone's pane is closed.
    bots[1] = { ...bots[1], tasks: [{ ...task('wtask-ask-00000001', 't1', 'needs_input', 'README title'), summary: 'The push was denied; tell me the branch' }, task('wtask-gone-0000002', 't-gone', 'working', 'Gone')] };
    await render(<BotsPage />);
    expect(q(`[data-bots-row="bot:${LEAD}"] [data-bots-needs]`)?.textContent).toBe('2');
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const worker = q('[data-bots-worker="t1"]')!;
    expect(worker.getAttribute('data-worker-needs-input')).toBe('true');
    expect(worker.textContent).toContain('README title');
    expect(worker.textContent).toContain('Worker needs input');
    expect(worker.querySelector('[data-bots-worker-summary]')?.textContent).toBe('The push was denied; tell me the branch');
    expect(q('[data-bots-worker="t-gone"]')).toBeNull();
    // The room shows it too, under the bot's face.
    act(() => q('[data-bots-row="room:w1"]')!.click());
    expect(q('[data-bots-worker="t1"]')?.getAttribute('data-worker-needs-input')).toBe('true');
    act(() => q('[data-bots-worker-open="t1"]')!.click());
    expect(useStore.getState().activeWorkspaceId).toBe('hq');
    expect(useStore.getState().appRoute).toBe('bots');
    expect(useStore.getState().botsWorkerPanel).toEqual({ workspaceId: 't1', conversationId: 'room:w1' });
    expect(q('[data-bots-worker-panel="t1"]')?.textContent).toContain('Worker needs input');
    act(() => useStore.getState().setBotsWorkerPanel(null));
  });

  it('in a room a new bot\'s greeting is a "joined" line that opens its 1:1, where the greeting is', async () => {
    const NEW = 'bot-0000000e';
    bots.push(botRow(NEW, 'lead', 'w1', 500, 'Wmux Dev'));
    cards.push(card({ workspaceId: 'w1', actor: by('w1', NEW), kind: 'question', state: 'open', title: 'Hi, what should I work on?', threadId: 'handoff:h-0000000001', at: 520, greeting: true }));
    cards.push(card({ workspaceId: 'w1', actor: by('w1', NEW), title: 'Later note', at: 900_000 }));
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="room:w1"]')!.click());
    const greeting = cards.find((c) => c.title.startsWith('Hi,'))!;
    expect(q(`[data-bots-messages] [data-room-card-id="${greeting.id}"]`)).toBeNull();
    const joined = q(`[data-bots-joined="${NEW}"]`)!;
    expect(joined.textContent).toContain('Wmux Dev joined');
    // Placed by time: after the room's earlier cards, before the bot's later note.
    const order = [...container.querySelectorAll('[data-bots-messages] [data-room-card-id], [data-bots-joined]')]
      .map((el) => el.getAttribute('data-bots-joined') ? 'joined' : el.getAttribute('data-room-card-id'));
    expect(order.indexOf('joined')).toBe(order.length - 2);
    // A room whose first card is the greeting still shows the joined line.
    const W2 = 'bot-0000000f';
    bots.push(botRow(W2, 'lead', 'w2', 50_000, 'Wmux Issue'));
    cards.push(card({ workspaceId: 'w2', actor: by('w2', W2), kind: 'question', state: 'open', title: 'Hello', threadId: 'handoff:h-0000000009', at: 50_100, greeting: true }));
    cards.push(card({ workspaceId: 'w2', actor: { kind: 'human' }, kind: 'human', title: 'Hi', at: 60_000 }));
    act(() => useStore.setState({ workspaces: [...useStore.getState().workspaces, ws('w2', 'web')], roomThreads: { ...useStore.getState().roomThreads, w2: [] }, roomTimelines: { ...useStore.getState().roomTimelines, [timelineKey('w2', ALL_THREADS)]: { cards: cards.filter((c) => c.workspaceId === 'w2'), nextSinceSeq: 0, hasMore: false } } } as never));
    await render(<BotsPage />);
    act(() => q('[data-bots-row="room:w2"]')!.click());
    expect(q(`[data-bots-joined="${W2}"]`)).not.toBeNull();
    act(() => q('[data-bots-row="room:w1"]')!.click());
    act(() => q(`[data-bots-joined-open="${NEW}"]`)!.click());
    expect(q(`[data-bots-chat="bot:${NEW}"]`)).not.toBeNull();
    expect(q(`[data-bots-messages] [data-room-card-id="${greeting.id}"]`)).not.toBeNull();
  });

  it('a thread chip names a task by its title, never its id (the id stays in the tooltip)', async () => {
    seedRooms();
    cards.push(card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', title: 'Answered → Lead (lead): Push?', threadId: 'task:wtask-abc-00000001', refs: { botId: LEAD }, at: 600 }));
    cards.push(card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Asked', threadId: 'handoff:h-0000000002', at: 610 }));
    cards.push(card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Worker started', body: 'Task `wtask-abc-00000001` is running.', at: 620 }));
    bots[1] = { ...bots[1], tasks: [{ taskId: 'wtask-abc-00000001', taskWorkspaceId: 'tx', ownerWorkspaceId: 'w1', botId: LEAD, title: 'README title', status: 'working', stage: 'working', updatedAt: 1 }] };
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="room:w1"]')!.click());
    const taskChip = q('[data-bots-thread-chip="task:wtask-abc-00000001"]')!;
    expect(taskChip.textContent).toBe('README title');
    expect(taskChip.getAttribute('title')).toContain('wtask-abc-00000001');
    expect(q('[data-bots-thread-chip="handoff:h-0000000002"]')?.textContent).toBe('Request');
    // A bot citing the task id shows the task's title instead.
    expect(container.textContent).toContain('Task README title is running.');
    expect(container.textContent).not.toContain('Task wtask-abc-00000001');
    // A system line drops the role tag after a bot's name.
    expect(container.textContent).toContain('Answered → Lead: Push?');
    expect(container.textContent).not.toContain('(lead)');
  });

  it('the Approve N pending chip shows wherever the approval card is shown, not only in its PR thread', async () => {
    const approval = card({ workspaceId: 'w1', actor: by('w1', LEAD), kind: 'approval', state: 'open', title: 'Merge PR #1 at abc1234?', threadId: 'pr:github.com/acme/api#1', refs: { approvalId: 'apr-0000000001', pr: 1 }, at: 700 });
    // The same request asked where the bot talks with the owner, linking the PR's thread.
    const linked = card({ workspaceId: 'w1', actor: by('w1', LEAD), kind: 'approval', state: 'open', title: 'Merge PR #2 at def5678?', threadId: 'general', refs: { approvalId: 'apr-0000000002', pr: 2, threadId: 'pr:github.com/acme/api#2' }, at: 710 });
    cards.push(linked);
    cards.push(approval);
    seedRooms();
    const request = {
      requestId: 'apr-0000000001', action: 'merge', repoKey: 'github.com/acme/api', prNumber: 1, headSha: 'a'.repeat(40), botId: LEAD, workspaceId: 'w1',
      threadId: 'pr:github.com/acme/api#1', reason: 'green', tainted: false, cardId: approval.id, state: 'pending', createdAt: 1, updatedAt: 1,
    };
    const request2 = { ...request, requestId: 'apr-0000000002', prNumber: 2, threadId: 'general', cardId: linked.id };
    const decide = vi.fn(async () => ({ ok: true as const, request }));
    setApprovalsApiForTests({ list: vi.fn(async () => ({ ok: true as const, requests: [request, request2] })), decide, rules: vi.fn(), revokeRule: vi.fn() } as unknown as ApprovalsApi);
    try {
      await render(<BotsPage />);
      await act(async () => { await refreshApprovals(); });
      // The room's whole view (the owner is talking in General).
      act(() => q('[data-bots-row="room:w1"]')!.click());
      expect(q('[data-testid="approve-pending-chip"]')?.getAttribute('data-approve-ids')).toBe('apr-0000000001 apr-0000000002');
      // The card in General carries its PR thread's chip; narrowed there, it
      // is shown and counted, the other PR's is not.
      const prChip = q(`[data-room-card-id="${linked.id}"] [data-bots-thread-chip="pr:github.com/acme/api#2"]`)!;
      expect(prChip.textContent).toBe('acme/api#2');
      act(() => prChip.click());
      expect(q(`[data-bots-thread-panel] [data-room-card-id="${linked.id}"]`)).not.toBeNull();
      expect(q('[data-bots-thread-panel] [data-testid="approve-pending-chip"]')?.getAttribute('data-approve-ids')).toBe('apr-0000000002');
      // The asking bot's 1:1 too.
      act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
      expect(q('[data-testid="approve-pending-chip"]')?.getAttribute('data-approve-ids')).toBe('apr-0000000001 apr-0000000002');
      // Another bot's 1:1 does not show it.
      act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
      expect(q('[data-testid="approve-pending-chip"]')).toBeNull();
    } finally {
      setApprovalsApiForTests(undefined);
    }
  });

  it('the profile under the pill says what the bot can do, whom it reports to and its workers now (read-only)', async () => {
    seedRooms();
    act(() => useStore.setState({
      workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), {
        ...ws('t1', 'wtask: fix login'),
        rootPane: { id: 't1-p', type: 'leaf', ordinal: 1, surfaces: [{ id: 's', ptyId: 'pty-t1', title: '', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }], activeSurfaceId: 's' },
      } as Workspace],
      surfaceAgent: { 'pty-t1': { name: 'Claude Code', status: 'running' } },
      surfaceAgentStatus: { 'pty-t1': 'running' },
    } as never));
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    const profile = q(`[data-bots-profile="${LEAD}"]`)!;
    const canDo = [...profile.querySelectorAll('[data-can-do]')].map((el) => el.textContent);
    expect(canDo).toContain('Start workers in their own worktrees');
    expect(canDo).toContain('Ask you questions, with choices');
    expect(canDo).toContain('Record review verdicts (evidence, not a merge)');
    expect(canDo).not.toContain('Read every workspace\'s rooms and facts');
    expect(profile.querySelector('[data-bots-profile-reports-to]')?.textContent).toBe('You');
    expect(profile.querySelector('[data-bots-profile-workers]')?.textContent).toBe('1 running');
    // Turns used and left today (no hourly cap is shown).
    expect(profile.querySelector('[data-bots-profile-turns]')?.textContent).toBe(`${DEFAULT_BOT_BUDGETS.lead.maxTurnsPerDay - 30} used · 30 left`);
    // Nothing on it edits the bot's powers.
    expect(profile.querySelectorAll('input, button, select')).toHaveLength(0);

    act(() => q(`[data-bots-row="bot:${MOA}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    const moa = q(`[data-bots-profile="${MOA}"]`)!;
    expect(moa.querySelector('[data-bots-profile-reports-to]')?.textContent).toBe('You');
    const moaCanDo = [...moa.querySelectorAll('[data-can-do]')].map((el) => el.textContent);
    expect(moaCanDo).toContain('Propose plans for your approval');
    expect(moaCanDo).toContain('Start workers in their own worktrees');
    expect(moaCanDo).toContain('Read every workspace\'s rooms and facts');
    expect(moa.querySelector('[data-bots-profile-workers]')?.textContent).toBe('0 running');
  });

  it('the profile shows the template and the job, and edits the job through the bot port', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    setFactoryBotPort({ ...port, update } as FactoryBotPort);
    bots = bots.map((r) => (r.bot.id === LEAD ? { ...r, bot: { ...r.bot, template: 'issue', job: 'Fix every open issue.' } } : r));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    const profile = q(`[data-bots-profile="${LEAD}"]`)!;
    expect(profile.querySelector('[data-bots-profile-template]')?.textContent).toBe('Issues');
    expect(profile.querySelector('[data-bots-profile-job-text]')?.textContent).toBe('Fix every open issue.');
    act(() => profile.querySelector<HTMLButtonElement>('[data-testid="bots-profile-job-edit"]')!.click());
    const input = profile.querySelector<HTMLTextAreaElement>('[data-testid="bots-profile-job-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '  Review PRs.  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => profile.querySelector<HTMLButtonElement>('[data-testid="bots-profile-job-save"]')!.click());
    expect(update).toHaveBeenCalledWith(LEAD, { job: 'Review PRs.' });
  });

  it('a bot without a job of its own shows its template\'s starting job, in the UI language', async () => {
    bots = bots.map((r) => (r.bot.id === MOA ? { ...r, bot: { ...r.bot, template: 'coordinator', job: undefined } } : r));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${MOA}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    const profile = q(`[data-bots-profile="${MOA}"]`)!;
    expect(profile.querySelector('[data-bots-profile-job-text]')?.textContent).toMatch(/^Coordinate the team/);
    expect(profile.querySelector('[data-bots-profile-job-default]')?.textContent).toBe('Its starting job, until you give it one.');
  });

  it('a bot\'s job_changed card offers Undo, which writes the previous job back', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    setFactoryBotPort({ ...port, update } as FactoryBotPort);
    cards.push(card({
      workspaceId: 'w1', actor: by('w1', LEAD), kind: 'job_changed', title: 'Lead\'s job changed', body: 'Find root causes.',
      refs: { botId: LEAD, botIds: [LEAD] }, jobChange: { botId: LEAD, previous: 'Ship features.', next: 'Find root causes.' }, at: 500,
    }));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const undo = q<HTMLButtonElement>('[data-testid="bots-job-undo"]')!;
    expect(undo).not.toBeNull();
    await act(async () => undo.click());
    expect(update).toHaveBeenCalledWith(LEAD, { job: 'Ship features.' });
  });

  it('"+" opens the add form in a dialog, and the bot it adds is selected at once', async () => {
    seedRooms();
    const added = botRow('bot-0000000e', 'triage', 'w1', 9, 'Triage').bot;
    const create = vi.fn(async () => ({ ok: true as const, bot: added }));
    setFactoryBotPort({ ...port, create } as unknown as FactoryBotPort);
    await render(<BotsPage />);
    act(() => q('[data-bots-add]')!.click());
    const dialog = () => document.querySelector('[data-testid="bots-add-bot"]');
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Add bot');
    // A bot belongs to one of the owner's workspaces, never a bot worker's.
    const options = [...document.querySelectorAll('[data-testid="bots-add-bot"] option')].map((o) => o.textContent);
    expect(options).toContain('api');
    expect(options).not.toContain('wtask: fix login');
    // A disabled Add says why.
    const submit = dialog()!.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!;
    expect(submit.disabled).toBe(true);
    expect(dialog()!.querySelector('[data-testid="factory-add-bot-blocked"]')?.textContent).toBe('Give the bot a name to add it.');
    const name = dialog()!.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Triage');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dialog()!.querySelector('[data-testid="factory-add-bot-blocked"]')).toBeNull();
    await act(async () => { submit.click(); });
    await act(async () => { await Promise.resolve(); });
    // The form closes and the new bot's chat opens, starting, with no wait for the list.
    expect(dialog()).toBeNull();
    expect(q('[data-bots-chat]')?.getAttribute('data-bots-chat')).toBe('bot:bot-0000000e');
    expect(q('[data-bots-starting]')).not.toBeNull();
  });

  it('"+" while the bots are off: Add asks once, in place, then turns them on and adds', async () => {
    const off = api();
    off.status = vi.fn(async () => ({ running: true, enabled: false, hqWorkspaceId: 'hq' })) as unknown as RoomsApi['status'];
    setRoomsApiForTests(off);
    seedRooms(false);
    const added = botRow('bot-0000000e', 'triage', 'w1', 9, 'Triage').bot;
    const create = vi.fn(async () => ({ ok: true as const, bot: added }));
    setFactoryBotPort({ ...port, create } as unknown as FactoryBotPort);
    const settings = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => ({ enabled: true }) as never) };
    await render(<BotsPage settings={settings} />);
    act(() => q('[data-bots-add]')!.click());
    const dialog = document.querySelector('[data-testid="bots-add-bot"]')!;
    const name = dialog.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Triage');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => dialog.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!.click());
    expect(create).not.toHaveBeenCalled();
    expect(dialog.querySelector('[data-testid="factory-add-bot-on-confirm-row"]')?.textContent).toContain('Adding Triage turns bots on');
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-on-confirm"]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(settings.set).toHaveBeenCalledWith({ enabled: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('isStillStarting: a new bot starts until its first message, unless its turn failed', () => {
    const conv = (last: RoomCard | null, lastError?: { message: string; at: number }): Conversation => {
      const row = botRow(LEAD, 'lead', 'w1', 1, 'Lead');
      return { kind: 'bot', id: `bot:${LEAD}`, workspaceId: 'w1', row: { ...row, status: { ...row.status!, ...(lastError ? { lastError } : {}) } }, last, lastAt: 0, needsYou: 0, openQuestions: 0, openApprovals: 0, workers: [] };
    };
    expect(isStillStarting(undefined)).toBe(true);
    expect(isStillStarting(conv(null))).toBe(true);
    expect(isStillStarting(conv(card({ workspaceId: 'w1', actor: by('w1', LEAD) })))).toBe(false);
    expect(isStillStarting(conv(null, { message: 'no login', at: 1 }))).toBe(false);
  });

  it('"+" without a create port opens the factory settings page', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-add]')!.click());
    expect(useStore.getState().appRoute).toBe('settings');
    expect(useStore.getState().settingsInitialTab).toBe('factory');
  });

  it('"+" runs the add-bot override', async () => {
    seedRooms();
    const onAddBot = vi.fn();
    await render(<BotsPage onAddBot={onAddBot} />);
    act(() => q('[data-bots-add]')!.click());
    expect(onAddBot).toHaveBeenCalledTimes(1);
  });

  it('the rail item opens the page and its badge is the sum of the page\'s rows', async () => {
    seedRooms();
    act(() => useStore.setState({ appRoute: 'workspaces', sidebarVisible: true, readOnly: false, schedulesAvailable: true } as never));
    await render(<><MiniSidebar rail collapsed /><BotsPage /></>);
    const item = q('[data-sidebar-nav="bots"]')!;
    const rowsSum = [...container.querySelectorAll('[data-bots-row] [data-bots-needs]')].reduce((n, el) => n + Number(el.textContent), 0);
    expect(rowsSum).toBe(1);
    expect(item.querySelector('.wmux-nav-badge')?.textContent).toBe(String(rowsSum));
    expect(item.getAttribute('aria-label')).toBe('Bots, needs you 1');
    act(() => item.click());
    expect(useStore.getState().appRoute).toBe('bots');
    expect(item.getAttribute('aria-current')).toBe('page');
  });

  it('an open plan joins the rail badge, still the sum of the page\'s rows; paused, both are clear', async () => {
    cards.push(card({ workspaceId: 'hq', actor: by('hq', MOA), kind: 'plan', state: 'open', threadId: 'plan:p-1', at: 500 }));
    seedRooms();
    act(() => useStore.setState({ appRoute: 'workspaces', sidebarVisible: true, readOnly: false, schedulesAvailable: true } as never));
    await render(<><MiniSidebar rail collapsed /><BotsPage /></>);
    const item = q('[data-sidebar-nav="bots"]')!;
    const rowsSum = () => [...container.querySelectorAll('[data-bots-row] [data-bots-needs]')].reduce((n, el) => n + Number(el.textContent), 0);
    expect(rowsSum()).toBe(2);
    expect(item.querySelector('.wmux-nav-badge')?.textContent).toBe('2');
    act(() => useStore.setState({ roomStatus: { running: true, enabled: false, hqWorkspaceId: 'hq' } } as never));
    expect(rowsSum()).toBe(0);
    expect(item.querySelector('.wmux-nav-badge')).toBeNull();
  });

  it('messages are flat rows: a run of one author within ten minutes shows its header once', async () => {
    cards.push(card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'And the second part', at: 205 }));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const first = q('[data-room-card-id="c2"]')!;
    const next = q(`[data-room-card-id="${cards[cards.length - 1].id}"]`)!;
    expect(first.querySelector('[data-bots-msg-head]')?.textContent).toContain('Lead');
    expect(next.getAttribute('data-continuation')).toBe('true');
    expect(next.querySelector('[data-bots-msg-head]')).toBeNull();
    // The owner's message is a flat row too, its text read as markdown.
    expect(q('[data-bots-bubble="owner"]')?.className).toContain('wmux-bots-msg');
    expect(q('[data-bots-day]')).not.toBeNull();
  });

  it('the working rail says who is working and for how long, and its Stop interrupts the turn only', async () => {
    const act$ = vi.fn(async () => ({ ok: true }));
    bots[1] = { ...bots[1], status: { ...bots[1].status!, presence: 'running', currentTurn: { wakeId: 'w-1', startedAt: Date.now() - 14_000 }, queueDepth: 2 } };
    setFactoryBotPort({ ...port, act: act$ });
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const turn = q(`[data-bots-rail] [data-bots-turn="${LEAD}"]`)!;
    expect(turn.textContent).toContain('Lead working');
    expect(turn.textContent).toMatch(/0:1[45]/);
    expect(turn.textContent).toContain('2 queued');
    await act(async () => { q<HTMLButtonElement>(`[data-bots-turn-stop="${LEAD}"]`)!.click(); });
    expect(act$).toHaveBeenCalledWith('interrupt', LEAD);
    // With the bots off there is no turn line and no Stop.
    act(() => useStore.setState({ roomStatus: { running: true, enabled: false, hqWorkspaceId: 'hq' } } as never));
    expect(q('[data-bots-turn-stop]')).toBeNull();
  });

  it('a list row counts unread bot messages in neutral, and the orange needs-you count wins', async () => {
    cards.push(card({ workspaceId: 'w1', actor: by('w1', VERIFIER), title: 'Fresh news', at: Date.now() + 1000 }));
    seedRooms();
    await render(<BotsPage />);
    expect(q(`[data-bots-row="bot:${VERIFIER}"] [data-bots-unread]`)?.textContent).toBe('1');
    // Lead has a question open: its needs-you badge shows, never an unread one.
    expect(q(`[data-bots-row="bot:${LEAD}"] [data-bots-needs]`)).not.toBeNull();
    expect(q(`[data-bots-row="bot:${LEAD}"] [data-bots-unread]`)).toBeNull();
    // A chat the narrow layout keeps hidden behind the list reads nothing.
    const proto = HTMLElement.prototype as unknown as { checkVisibility?: () => boolean };
    proto.checkVisibility = () => false;
    try {
      act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
      expect(q(`[data-bots-row="bot:${VERIFIER}"] [data-bots-unread]`)?.textContent).toBe('1');
    } finally {
      delete proto.checkVisibility;
    }
    // Reading the 1:1 to its end clears it.
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
    expect(q(`[data-bots-row="bot:${VERIFIER}"] [data-bots-unread]`)).toBeNull();
  });

  it('an empty 1:1 opens with the bot, its job and first messages that fill the composer', async () => {
    const NEW = 'bot-0000000f';
    bots.push(botRow(NEW, 'lead', 'w1', 600, 'Quiet'));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${NEW}"]`)!.click());
    expect(q(`[data-bots-intro="${NEW}"]`)?.textContent).toContain('Quiet');
    act(() => q('[data-bots-suggestion="botsPage.chat.suggestStatus"]')!.click());
    expect(q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')?.value).toBe('Give me a status update.');
  });

  it('Toggle Bots opens the Bots page and, pressed there, returns to Workspaces', () => {
    act(() => useStore.setState({ appRoute: 'workspaces' } as never));
    act(() => useStore.getState().toggleBotsView());
    expect(useStore.getState().appRoute).toBe('bots');
    act(() => useStore.getState().toggleBotsView());
    expect(useStore.getState().appRoute).toBe('workspaces');
  });
});

describe('BotsChat helpers', () => {
  const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`;

  it('oneToOneRefusal: only an off bot; a 1:1 mentions its bot, so a second bot of a role is reachable too', () => {
    const lead = botRow(LEAD, 'lead', 'w1', 2, 'Lead');
    expect(oneToOneRefusal(lead, t)).toBeNull();
    const off = botRow(LEAD, 'lead', 'w1', 2, 'Lead', false);
    expect(oneToOneRefusal(off, t)).toContain('botsPage.botOff');
    expect(oneToOneRefusal(botRow('bot-0000000d', 'moa', 'w1', 9, 'Moa 2'), t)).toBeNull();
  });

  it('chatCards narrows to a thread', () => {
    const room: Conversation = { kind: 'room', id: 'room:w1', workspaceId: 'w1', bots: [], workers: [], last: null, lastAt: 0, needsYou: 0 };
    const a = card({ workspaceId: 'w1', actor: by('w1', LEAD) });
    const b = card({ workspaceId: 'w1', actor: by('w1', LEAD), threadId: 'task:t1' });
    expect(chatCards(room, [a, b], null)).toEqual([a, b]);
    expect(chatCards(room, [a, b], 'task:t1')).toEqual([b]);
  });
});
