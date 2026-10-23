// @vitest-environment jsdom
//
// The wizard's first-task step end to end: nothing is turned on, created or
// posted before the usage screen's confirm; the default task is the
// read-only "explain" one, posted once under FIRST_TASK_CLIENT_POST_ID; a 1:1
// that already holds the task is waited on; the answer is the bot's own card
// after the task; Skip never makes a bot; a folder that is not a repository
// keeps Send disabled.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FirstRunWizard from '../FirstRunWizard';
import { setFirstTaskTimingForTests } from '../FirstRunFirstTask';
import { setFactoryBotPort, setFactorySettingsPort, type FactoryBotPort, type FactorySettingsPort } from '../Room/factoryPorts';
import { useStore } from '../../stores';
import { resetAgentSetupForTests } from '../../utils/agentSetupRuns';
import { FIRST_TASK_CLIENT_POST_ID, type FirstRunFolderCheck } from '../../../shared/firstRun';
import type { RoomCard } from '../../../shared/room';
import type { AgentSetupStatus } from '../../../shared/agentSetup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXPLAIN_TASK = "Explain what this folder contains: what the project is, how it is laid out, and where to start reading. Don't change any files.";

let container: HTMLDivElement;
let root: Root;
let firstRun: Record<string, ReturnType<typeof vi.fn>>;
let rooms: Record<string, ReturnType<typeof vi.fn>>;
let settingsSet: ReturnType<typeof vi.fn>;
/** The bot's 1:1 as main holds it. */
let thread: RoomCard[];
/** Pending poll waits: `tick()` lets them go. */
let waits: Array<() => void>;

const ready: AgentSetupStatus = {
  agent: 'claude', readiness: 'ready', executable: '/u/bin/claude', version: '9.9.9', updateRecommended: false, loginKnown: true, candidates: [],
};

const card = (seq: number, actor: RoomCard['actor'], over: Partial<RoomCard> = {}): RoomCard => ({
  version: 1, id: `c${seq}`, seq, workspaceId: 'w1', threadId: 'dm:b1', kind: actor.kind === 'human' ? 'human' : 'report',
  at: seq, actor, title: `card ${seq}`, ...over,
});
const BOT = { kind: 'bot', workspaceId: 'w1', botId: 'b1' } as const;

function install({ folder = { ok: true, root: '/r', displayRoot: '~/r', repoKey: 'o/r' } as FirstRunFolderCheck } = {}) {
  thread = [];
  waits = [];
  firstRun = {
    check: vi.fn().mockResolvedValue({ shown: false, status: { claudeFound: true, mcpRegistered: true, claudeJsonPath: '' } }),
    reopen: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    registerMcp: vi.fn(),
    startSampleTask: vi.fn(),
    onSampleTaskReady: vi.fn(() => () => undefined),
    onSampleTaskTimeout: vi.fn(() => () => undefined),
    agentStatus: vi.fn().mockResolvedValue([ready]),
    checkFolder: vi.fn().mockResolvedValue(folder),
    firstBot: vi.fn().mockResolvedValue({
      ok: true, created: true, bot: { id: 'b1', name: 'Mochi', workspaceId: 'w1', repoPath: '/r' }, threadId: 'dm:b1',
    }),
  };
  rooms = {
    status: vi.fn().mockResolvedValue({ running: true, enabled: true, hqWorkspaceId: null }),
    read: vi.fn(async ({ sinceSeq = 0 }: { sinceSeq?: number }) => {
      const cards = thread.filter((c) => c.seq > sinceSeq);
      return { ok: true, workspaceId: 'w1', threadId: 'dm:b1', cards, nextSinceSeq: cards.at(-1)?.seq ?? sinceSeq, hasMore: false };
    }),
    post: vi.fn(async (p: { title: string; body?: string }) => {
      const posted = card((thread.at(-1)?.seq ?? 0) + 1, { kind: 'human' }, { title: p.title });
      thread.push(posted);
      return { ok: true, card: posted };
    }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    firstRun,
    rooms,
    deck: { hooksBridge: { status: vi.fn().mockResolvedValue({ installed: true }), install: vi.fn() } },
    dialog: { pickFolder: vi.fn().mockResolvedValue(['/elsewhere']) },
    pty: { onData: vi.fn(() => () => undefined), onExit: vi.fn(() => () => undefined) },
  };
  setFactoryBotPort({
    available: true,
    list: async () => [],
    subscribe: () => () => undefined,
    act: async () => ({ ok: true }),
    suggestRepo: vi.fn().mockResolvedValue({ ok: true, repoKey: 'o/r', root: '/r', displayRoot: '~/r', inherited: false }),
  } as FactoryBotPort);
  settingsSet = vi.fn().mockResolvedValue({ enabled: true });
  setFactorySettingsPort({ available: true, get: vi.fn().mockResolvedValue({ enabled: false }), set: settingsSet } as unknown as FactorySettingsPort);
  setFirstTaskTimingForTests({ wait: () => new Promise<void>((r) => { waits.push(r); }), now: () => 0 });
  act(() => { useStore.setState({ activeWorkspaceId: 'w1' } as never); });
}

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const tick = async () => {
  const pending = waits;
  waits = [];
  await act(async () => { pending.forEach((r) => r()); });
  await settle();
};
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
const click = async (id: string) => {
  await act(async () => { byId(id)?.click(); });
  await settle();
};
const primaries = () => Array.from(container.querySelectorAll('.ui-btn-primary')).map((b) => (b as HTMLElement).dataset.testid);

async function mount(onClose = vi.fn()) {
  await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose })); });
  await settle();
  return onClose;
}

beforeEach(() => {
  resetAgentSetupForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetAgentSetupForTests();
  setFactoryBotPort(null);
  setFactorySettingsPort(null);
  setFirstTaskTimingForTests(null);
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('FirstRunWizard first task', () => {
  it('Send opens the usage screen without making or posting anything; Cancel leaves the bots off', async () => {
    install();
    await mount();
    expect(byId('first-run-folder-status')?.dataset.status).toBe('ok');
    expect(primaries()).toEqual(['first-run-first-task-send']);

    await click('first-run-first-task-send');
    expect(byId('first-run-first-task-consent')?.getAttribute('role')).toBe('alertdialog');
    // The usage screen's confirm is the only primary while it is open.
    expect(primaries()).toEqual(['first-run-first-task-consent-confirm']);
    expect(firstRun.firstBot).not.toHaveBeenCalled();
    expect(rooms.post).not.toHaveBeenCalled();
    expect(settingsSet).not.toHaveBeenCalled();

    await click('first-run-first-task-consent-cancel');
    expect(byId('first-run-first-task-consent')).toBeNull();
    expect(byId('first-run-first-task-send')?.disabled).toBe(false);
    expect(firstRun.firstBot).not.toHaveBeenCalled();
    expect(rooms.post).not.toHaveBeenCalled();
    expect(settingsSet).not.toHaveBeenCalled();
  });

  it('Confirm stores the consent, then posts the default explain task once, under the first-task post id', async () => {
    install();
    await mount();
    expect(byId('first-run-first-task-example-explain')?.getAttribute('aria-checked')).toBe('true');
    expect(byId('first-run-first-task-example-readme')?.getAttribute('aria-checked')).toBe('false');

    await click('first-run-first-task-send');
    await click('first-run-first-task-consent-confirm');
    expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, planConsent: expect.anything() }));
    expect(firstRun.firstBot).toHaveBeenCalledWith({ workspaceId: 'w1', folder: '/r' });
    expect(rooms.post).toHaveBeenCalledTimes(1);
    expect(rooms.post).toHaveBeenCalledWith({
      workspaceId: 'w1', threadId: 'dm:b1', title: EXPLAIN_TASK, mentions: ['b1'], clientPostId: FIRST_TASK_CLIENT_POST_ID,
    });
    expect(byId('first-run-first-task-waiting')).not.toBeNull();
    // In flight: nothing is primary.
    expect(primaries()).toEqual([]);
  });

  it('a 1:1 that already holds the task is waited on, not posted to again', async () => {
    install();
    await mount();
    thread.push(card(3, { kind: 'human' }, { title: EXPLAIN_TASK }));
    await click('first-run-first-task-send');
    await click('first-run-first-task-consent-confirm');
    expect(rooms.post).not.toHaveBeenCalled();
    expect(byId('first-run-first-task-waiting')).not.toBeNull();

    thread.push(card(4, BOT, { title: 'This is a todo app', body: 'src/ holds the UI.' }));
    await tick();
    expect(byId('first-run-first-task-answer')?.textContent).toContain('This is a todo app');
    expect(rooms.post).not.toHaveBeenCalled();
  });

  it('the answer is the bot card after the task, not an earlier card or a system line', async () => {
    install();
    await mount();
    thread.push(card(1, BOT, { title: 'an older greeting' }));
    await click('first-run-first-task-send');
    await click('first-run-first-task-consent-confirm');
    // The task is card 2; the earlier bot card is not its answer.
    expect(byId('first-run-first-task-answer')).toBeNull();
    expect(byId('first-run-first-task-waiting')).not.toBeNull();

    thread.push(card(3, { kind: 'system' }, { kind: 'fact', title: 'Mochi started' }));
    await tick();
    expect(byId('first-run-first-task-answer')).toBeNull();

    thread.push(card(4, BOT, { title: 'This folder is a CLI', body: 'Start in src/main.ts.' }));
    await tick();
    const answer = byId('first-run-first-task-answer');
    expect(answer?.textContent).toContain('This folder is a CLI');
    expect(answer?.textContent).toContain('Start in src/main.ts.');
    expect(firstRun.complete).toHaveBeenCalledTimes(1);
    expect(primaries()).toEqual(['first-run-first-task-open']);
  });

  it("an error card from the bot shows as an error and does not complete the first run", async () => {
    install();
    await mount();
    await click('first-run-first-task-send');
    await click('first-run-first-task-consent-confirm');
    thread.push(card(2, BOT, { kind: 'refusal', title: 'Mochi was refused read' }));
    await tick();
    expect(byId('first-run-first-task-error')?.textContent).toContain('Mochi was refused read');
    expect(byId('first-run-first-task-answer')).toBeNull();
    expect(firstRun.complete).not.toHaveBeenCalled();
  });

  it('Skip from the card dismisses and never makes the bot or posts', async () => {
    install();
    const onClose = await mount();
    await click('first-run-wizard-skip');
    expect(firstRun.dismiss).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(firstRun.firstBot).not.toHaveBeenCalled();
    expect(rooms.post).not.toHaveBeenCalled();
  });

  it('a folder that is not a repository says so and keeps Send disabled', async () => {
    install({ folder: { ok: false, code: 'not_a_repo', message: 'not a git repository' } });
    await mount();
    const status = byId('first-run-folder-status');
    expect(status?.dataset.status).toBe('not_a_repo');
    expect(status?.textContent).toBe('Bots read a git repository with a GitHub remote. Pick one, or skip.');
    expect(byId('first-run-first-task-send')?.disabled).toBe(true);
    expect(primaries()).not.toContain('first-run-first-task-send');
  });

  it('is not offered when the wizard is reopened', async () => {
    install();
    firstRun.reopen.mockResolvedValue({ shown: false, status: { claudeFound: true, mcpRegistered: true, claudeJsonPath: '' } });
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'reopen', onClose: vi.fn() })); });
    await settle();
    expect(byId('first-run-first-task')).toBeNull();
    expect(firstRun.checkFolder).not.toHaveBeenCalled();
  });
});
