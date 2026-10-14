// @vitest-environment jsdom
//
// The cheat sheet belongs to the page it was opened on: switching rail pages
// closes it, and so does a click outside it (a click inside keeps it).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type State = { appRoute: string; cheatSheetDismissed: boolean; cheatSheetForceShown: boolean; locale: string; setCheatSheetDismissed: () => void; setCheatSheetForceShown: (v: boolean) => void };
let state: State;
const listeners = new Set<() => void>();
function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

vi.mock('../../stores', () => ({
  useStore: <T,>(selector: (s: State) => T): T => useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => selector(state),
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

async function mount() {
  const { default: KeyboardCheatSheet } = await import('../KeyboardCheatSheet');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(KeyboardCheatSheet)); });
}

const sheet = () => document.querySelector('[data-testid="keyboard-cheat-sheet"]');

beforeEach(() => {
  state = {
    appRoute: 'fleet', cheatSheetDismissed: false, cheatSheetForceShown: true, locale: 'en',
    setCheatSheetDismissed: () => undefined,
    setCheatSheetForceShown: (v) => setState({ cheatSheetForceShown: v }),
  };
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe('KeyboardCheatSheet closes when its page is left', () => {
  it('a switch to another rail page closes it', async () => {
    await mount();
    expect(sheet()).not.toBeNull();
    await act(async () => { setState({ appRoute: 'bots' }); });
    expect(sheet()).toBeNull();
  });

  it('a click outside closes it; a click inside does not', async () => {
    await mount();
    const inside = sheet()?.querySelector('li') as Element;
    await act(async () => { inside.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(sheet()).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(sheet()).toBeNull();
  });
});
