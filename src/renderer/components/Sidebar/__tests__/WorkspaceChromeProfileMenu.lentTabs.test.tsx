// @vitest-environment jsdom
//
// Return to me: a workspace bound to Live Chrome lists the user's own tabs its
// agents were lent, and each row hands its tab back through main.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import WorkspaceChromeProfileMenu from '../WorkspaceChromeProfileMenu';
import { useStore } from '../../../stores';

const bindings: Record<string, string> = { 'ws-1': 'live' };
const list = vi.fn(async () => ({ profiles: ['default'], bindings }));
let lent = [{ surfaceId: 'T1', title: 'Mail', url: 'https://mail.test/' }];
const lentTabs = vi.fn(async () => ({ ok: true, tabs: lent }));
const returnTab = vi.fn(async () => {
  lent = [];
  return { ok: true, returned: true };
});

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
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
function openSubmenu(container: Element) {
  act(() => {
    container.firstElementChild!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

beforeEach(() => {
  lent = [{ surfaceId: 'T1', title: 'Mail', url: 'https://mail.test/' }];
  bindings['ws-1'] = 'live';
  lentTabs.mockClear();
  returnTab.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    browser: {
      chromeProfiles: { list, create: vi.fn(), bind: vi.fn() },
      agentControl: { lentTabs, returnTab },
    },
  };
  act(() => { useStore.getState().setBrowserBackend('chrome'); });
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('WorkspaceChromeProfileMenu — Return to me', () => {
  it('lists the tabs lent to the workspace and returns one through main', async () => {
    const c = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(c);
    await flush();

    expect(lentTabs).toHaveBeenCalledWith('ws-1');
    const section = c.querySelector('[data-testid="chrome-lent-tabs"]')!;
    expect(section.textContent).toContain('Mail');
    const button = section.querySelector('[data-testid="chrome-lent-return"]')!;
    expect(button.textContent).toBe('Return to me');

    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(returnTab).toHaveBeenCalledWith('ws-1', 'T1');
    // Re-read after the return: the tab is the user's again, so the row goes.
    expect(c.querySelector('[data-testid="chrome-lent-tabs"]')).toBeNull();
  });

  it('shows no lent tabs section for a workspace on a wmux profile', async () => {
    bindings['ws-1'] = 'work';
    const c = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(c);
    await flush();
    expect(lentTabs).not.toHaveBeenCalled();
    expect(c.querySelector('[data-testid="chrome-lent-tabs"]')).toBeNull();
  });
});
