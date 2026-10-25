// @vitest-environment jsdom
// The Bots profile's Engine line: picking Hermes shows whether Hermes can run
// here and asks once before main's engine verb is called; going back to
// Claude saves at once; a bot on Hermes offers the fix for what is missing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactoryBotRow } from '../../Room/factoryPorts';
import { DEFAULT_BOT_BUDGETS, HERMES_BOT_ENGINE, type BotEngine } from '../../../../shared/bot';
import { en } from '../../../i18n/locales/en';
import { useStore } from '../../../stores';
import { BotEngineLine } from '../BotEngineLine';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? ''));

function row(engine: BotEngine): FactoryBotRow {
  return {
    bot: {
      version: 1, id: 'bot-0000000a', workspaceId: 'ws-1', role: 'moa', template: 'coordinator', name: 'Ada',
      engine, triggers: [], budget: DEFAULT_BOT_BUDGETS.moa, enabled: true, createdAt: 1, updatedAt: 1,
    },
    status: null,
  } as unknown as FactoryBotRow;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const q = <E extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as E | null;
const flush = () => act(async () => { await Promise.resolve(); });

function pick(value: string): void {
  const select = q<HTMLSelectElement>('select[data-testid="bots-profile-engine"]')!;
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('Bots profile Engine line', () => {
  it('picking Hermes shows its readiness, then switches with setBotEngine; back to Claude saves at once', async () => {
    const setBotEngine = vi.fn(async (_botId: string, engine: string) => (engine === 'hermes' ? { ok: true } : { ok: false, message: 'refused by main' }));
    const factoryHermesReadiness = vi.fn(async () => ({ ready: true, version: '0.22.6' }));
    vi.stubGlobal('electronAPI', { factory: { factoryHermesReadiness, setBotEngine } });
    act(() => root.render(<BotEngineLine row={row({ kind: 'claude-sdk' })} t={t} />));
    // A Claude bot asks nothing of Hermes until Hermes is picked.
    expect(factoryHermesReadiness).not.toHaveBeenCalled();
    pick('hermes');
    await flush();
    expect(setBotEngine).not.toHaveBeenCalled();
    expect(q('[data-bots-hermes-readiness="ready"]')?.textContent).toContain('Hermes 0.22.6 is ready.');
    expect(q('[data-bots-hermes-can-do]')?.textContent).toContain('no shell, file, browser, memory or skills tools');
    await act(async () => { q('[data-testid="bots-profile-engine-switch-confirm"]')!.click(); });
    expect(setBotEngine).toHaveBeenCalledWith('bot-0000000a', 'hermes');

    act(() => root.render(<BotEngineLine row={row(HERMES_BOT_ENGINE)} t={t} />));
    await flush();
    pick('claude-sdk');
    await flush();
    expect(setBotEngine).toHaveBeenLastCalledWith('bot-0000000a', 'claude-sdk');
    expect(q('[role="alert"]')?.textContent).toBe('refused by main');
  });

  it('a bot on Hermes not set up: the line says wmux\'s Hermes is separate, and Set up opens Hermes\'s setup', async () => {
    const factoryHermesSetup = vi.fn(async () => undefined);
    vi.stubGlobal('electronAPI', { factory: { factoryHermesReadiness: async () => ({ ready: false, reason: 'not-set-up' }), factoryHermesSetup, setBotEngine: vi.fn() } });
    act(() => useStore.setState({ toasts: [] } as never));
    act(() => root.render(<BotEngineLine row={row(HERMES_BOT_ENGINE)} t={t} />));
    await flush();
    expect(q('[data-bots-hermes-readiness="not-set-up"]')?.textContent).toContain('separate from yours');
    await act(async () => { q('[data-bots-hermes-setup]')!.click(); });
    expect(factoryHermesSetup).toHaveBeenCalledTimes(1);
    expect(useStore.getState().toasts.at(-1)?.message).toBe(en['botsPage.hermes.setupOpened']);
  });

  it('another engine shows read-only', () => {
    vi.stubGlobal('electronAPI', { factory: { setBotEngine: vi.fn() } });
    act(() => root.render(<BotEngineLine row={row({ kind: 'acp', command: 'my-agent', args: ['--acp'] })} t={t} />));
    expect(q('[data-testid="bots-profile-engine"]')).toBeNull();
    expect(q('[data-testid="bots-profile-engine-value"]')?.textContent).toBe('ACP command: my-agent --acp');
  });
});
