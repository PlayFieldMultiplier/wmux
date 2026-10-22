// @vitest-environment jsdom
//
// The pane's agent controls only display main's state and send the user's
// intents: these pin what each state draws, which intent each button sends, and
// that the marker follows main's activity pushes on and off.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { BrowserAgentStatus, BrowserAgentTabMark, resetTouchedSurfacesForTests } from '../BrowserAgentControls';
import { resetBrowserAgentControlForTests } from '../../../hooks/useBrowserAgentControl';
import type { BrowserAgentControlState } from '../../../../shared/browserAgentControl';

let push: ((state: BrowserAgentControlState) => void) | null = null;
const list = vi.fn(async (): Promise<BrowserAgentControlState[]> => []);
const intent = vi.fn(async (surfaceId: string, which: string) => ({
  ok: true,
  state: {
    surfaceId,
    active: false,
    mode: which === 'stop' ? 'paused' : which === 'takeOver' ? 'user' : 'agent',
  } as BrowserAgentControlState,
}));

const mounted: Array<() => void> = [];
function render(ui: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}
async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}
function send(state: BrowserAgentControlState) {
  act(() => push?.(state));
}
function click(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  resetBrowserAgentControlForTests();
  resetTouchedSurfacesForTests();
  push = null;
  list.mockClear();
  intent.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    browser: {
      agentControl: {
        list,
        intent,
        onChanged: (cb: (s: BrowserAgentControlState) => void) => {
          push = cb;
          return () => { push = null; };
        },
      },
    },
  };
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('BrowserAgentStatus', () => {
  it('draws nothing for an idle tab, and the marker with Stop / Take over while an agent acts', async () => {
    const c = render(<BrowserAgentStatus surfaceId="tab-1" compact={false} />);
    await flush();
    expect(c.querySelector('[data-browser-agent-control]')).toBeNull();

    send({ surfaceId: 'tab-1', active: true, mode: 'agent' });
    const group = c.querySelector('[data-browser-agent-control="agent"]')!;
    expect(group.getAttribute('data-active')).toBe('true');
    expect(group.querySelector('[data-status-mark="dot"]')).not.toBeNull();
    expect(c.querySelector('[data-browser-agent-label]')!.textContent).toBe('Agent is using this tab');
    expect(c.querySelector('[data-browser-agent-stop]')).not.toBeNull();
    expect(c.querySelector('[data-browser-agent-take-over]')).not.toBeNull();

    // Another tab's activity is not this one's.
    send({ surfaceId: 'tab-2', active: true, mode: 'agent' });
    send({ surfaceId: 'tab-1', active: false, mode: 'agent' });
    // Between two steps: the mark, the words and Stop go; Take over stays.
    const idle = c.querySelector('[data-browser-agent-control="idle"]')!;
    expect(idle.querySelector('[data-status-mark]')).toBeNull();
    expect(c.querySelector('[data-browser-agent-label]')).toBeNull();
    expect(c.querySelector('[data-browser-agent-stop]')).toBeNull();
    expect(c.querySelector('[data-browser-agent-take-over]')).not.toBeNull();
  });

  it('offers Take over between an agent\'s steps, and it sends takeOver', async () => {
    const c = render(<BrowserAgentStatus surfaceId="tab-1" compact={false} />);
    await flush();
    send({ surfaceId: 'tab-1', active: true, mode: 'agent' });
    send({ surfaceId: 'tab-1', active: false, mode: 'agent' });

    click(c.querySelector('[data-browser-agent-take-over]')!);
    await flush();
    expect(intent).toHaveBeenCalledWith('tab-1', 'takeOver');
    expect(c.querySelector('[data-browser-agent-hand-back]')).not.toBeNull();
  });

  it('a tab no agent has touched shows nothing', async () => {
    const c = render(<BrowserAgentStatus surfaceId="tab-9" compact={false} />);
    await flush();
    send({ surfaceId: 'tab-1', active: true, mode: 'agent' });
    expect(c.querySelector('[data-browser-agent-control]')).toBeNull();
  });

  it('Stop sends the stop intent; the paused state offers Resume and Take over', async () => {
    const c = render(<BrowserAgentStatus surfaceId="tab-1" compact={false} />);
    await flush();
    send({ surfaceId: 'tab-1', active: true, mode: 'agent' });

    click(c.querySelector('[data-browser-agent-stop]')!);
    await flush();
    expect(intent).toHaveBeenCalledWith('tab-1', 'stop');
    expect(c.querySelector('[data-browser-agent-control="paused"]')).not.toBeNull();
    expect(c.querySelector('[data-browser-agent-stop]')).toBeNull();

    click(c.querySelector('[data-browser-agent-resume]')!);
    await flush();
    expect(intent).toHaveBeenLastCalledWith('tab-1', 'resume');
  });

  it('Take over toggles to a pressed Hand back, which sends handBack', async () => {
    const c = render(<BrowserAgentStatus surfaceId="tab-1" compact={false} />);
    await flush();
    send({ surfaceId: 'tab-1', active: true, mode: 'agent' });

    click(c.querySelector('[data-browser-agent-take-over]')!);
    await flush();
    expect(intent).toHaveBeenCalledWith('tab-1', 'takeOver');
    const handBack = c.querySelector('[data-browser-agent-hand-back]')!;
    expect(handBack.getAttribute('aria-pressed')).toBe('true');
    expect(c.querySelector('[data-browser-agent-label]')!.textContent).toBe('You have this tab');

    click(handBack);
    await flush();
    expect(intent).toHaveBeenLastCalledWith('tab-1', 'handBack');
    // Back under the agent, idle: Take over stays on offer.
    expect(c.querySelector('[data-browser-agent-control="idle"]')).not.toBeNull();
  });

  it('hydrates from main on mount, and steps aside for an open help request only while the agent has the tab', async () => {
    list.mockResolvedValueOnce([{ surfaceId: 'tab-1', active: false, mode: 'user' }]);
    const c = render(<BrowserAgentStatus surfaceId="tab-1" compact hidden />);
    await flush();
    // Hidden only yields the agent marker; a take-over keeps its Hand back.
    expect(c.querySelector('[data-browser-agent-hand-back]')).not.toBeNull();
    // Compact drops the words, not the controls.
    expect(c.querySelector('[data-browser-agent-label]')).toBeNull();

    send({ surfaceId: 'tab-1', active: true, mode: 'agent' });
    expect(c.querySelector('[data-browser-agent-control]')).toBeNull();
  });
});

describe('BrowserAgentTabMark', () => {
  it('marks the tab only while an agent is acting on it', async () => {
    const c = render(<BrowserAgentTabMark surfaceId="tab-1" />);
    await flush();
    expect(c.querySelector('[data-browser-agent-tab-mark]')).toBeNull();
    send({ surfaceId: 'tab-1', active: true, mode: 'agent' });
    expect(c.querySelector('[data-browser-agent-tab-mark] [aria-label="Agent is using this tab"]')).not.toBeNull();
    send({ surfaceId: 'tab-1', active: false, mode: 'paused' });
    expect(c.querySelector('[data-browser-agent-tab-mark]')).toBeNull();
  });
});
