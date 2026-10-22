// @vitest-environment jsdom
//
// The Bots composer's mic: one click starts, the next stops; the text goes in
// the box at the caret for the owner to edit, and nothing is posted.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { ALL_THREADS, timelineKey } from '../../../stores/slices/roomSlice';
import { setRoomsApiForTests, type RoomsApi } from '../../../hooks/useRoomSync';
import { setFactoryBotPort, type FactoryBotPort, type FactoryBotRow } from '../../Room/factoryPorts';
import { setBotGroupPort } from '../../Room/botGroups';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../../shared/bot';
import type { Pane, Workspace } from '../../../../shared/types';
import BotsPage from '../BotsPage';
import { resetDictationMock, setDictation, toggleDictation } from '../../Dictation/__tests__/dictationMock';

vi.mock('../../Terminal/Terminal', () => ({ default: () => null }));
vi.mock('../../../dictation/dictation', () => import('../../Dictation/__tests__/dictationMock'));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEAD = 'bot-0000000a';

function botRow(): FactoryBotRow {
  const bot: BotProfile = {
    version: 1, id: LEAD, workspaceId: 'w1', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1,
    repo: { repoKey: 'github.com/acme/api', repoPath: '/r/api' },
  };
  return { bot, status: { botId: LEAD, presence: 'idle', queueDepth: 0, budgetLeft: { turnsHour: 5, turnsDay: 30, workerHoursDay: 4 } } };
}
const leaf = (id: string): Pane => ({ id: `${id}-p`, type: 'leaf', ordinal: 1, surfaces: [], activeSurfaceId: '' }) as unknown as Pane;
const ws = (id: string, name: string): Workspace => ({ id, name, wsOrdinal: 1, rootPane: leaf(id), activePaneId: `${id}-p` }) as Workspace;

let posted: unknown[];
let container: HTMLDivElement;
let root: Root;

function api(): RoomsApi {
  return {
    status: vi.fn(async () => ({ running: true, enabled: true, hqWorkspaceId: 'hq' })),
    read: vi.fn(async (p: { workspaceId: string }) => ({ ok: true as const, workspaceId: p.workspaceId, threadId: null, cards: [], nextSinceSeq: 0, hasMore: false })),
    threads: vi.fn(async (workspaceId: string) => ({ ok: true as const, workspaceId, threads: [] })),
    post: vi.fn(async (p: unknown) => { posted.push(p); return { ok: false as const, code: 'x', message: 'x' }; }),
    resolve: vi.fn(async () => ({ ok: false as const, code: 'x', message: 'x' })),
    decision: vi.fn(async () => ({ decision: null })),
    actors: vi.fn(async () => ({ actors: {} })),
    onEvent: vi.fn(() => () => undefined),
  } as unknown as RoomsApi;
}

beforeEach(() => {
  resetDictationMock();
  posted = [];
  const rows = [botRow()];
  const port: FactoryBotPort = { available: true, list: async () => rows, subscribe: () => () => undefined, act: async () => ({ ok: true }) };
  setFactoryBotPort(port);
  setBotGroupPort({ available: true, list: async () => ({ ok: true, groups: [] }) } as never);
  setRoomsApiForTests(api());
  vi.stubGlobal('electronAPI', { web: { status: vi.fn(async () => ({ running: false })) }, dictation: {} });
  act(() => useStore.setState({
    roomStatus: { running: true, enabled: true, hqWorkspaceId: 'hq' },
    workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api')],
    activeWorkspaceId: 'hq',
    activeRemoteKey: null,
    appRoute: 'bots',
    roomThreads: { hq: [], w1: [] },
    roomTimelines: {
      [timelineKey('hq', ALL_THREADS)]: { cards: [], nextSinceSeq: 0, hasMore: false },
      [timelineKey('w1', ALL_THREADS)]: { cards: [], nextSinceSeq: 0, hasMore: false },
    },
    roomActors: {},
    surfaceAgentStatus: {},
  } as never));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setFactoryBotPort(null);
  setBotGroupPort(null);
  setRoomsApiForTests(undefined);
  vi.unstubAllGlobals();
  act(() => useStore.setState(useStore.getInitialState()));
});

const q = <E extends HTMLElement = HTMLElement>(sel: string) => container.querySelector<E>(sel);

describe('Bots composer mic', () => {
  it('toggles dictation and puts the text in the box without posting', async () => {
    await act(async () => { root.render(<BotsPage />); });
    await act(async () => { await Promise.resolve(); });
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const input = q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(input, 'Please');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const target = `bots:w1:dm:${LEAD}`;
    const mic = () => q<HTMLButtonElement>(`[data-dictation-button="${target}"]`)!;
    act(() => mic().click());
    expect(toggleDictation).toHaveBeenCalledWith(target, expect.any(Function));
    act(() => setDictation({ phase: 'recording', target, startedAt: Date.now() }));
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-dictation-clock]')?.textContent).toBe('0:00');
    act(() => mic().click());
    expect(toggleDictation).toHaveBeenCalledTimes(2);

    const deliver = toggleDictation.mock.calls[0][1];
    act(() => {
      setDictation({ phase: 'idle', target: null, startedAt: null });
      deliver('rebase onto main');
    });
    expect(q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')!.value).toBe('Please rebase onto main');
    expect(posted).toEqual([]);
  });
});
