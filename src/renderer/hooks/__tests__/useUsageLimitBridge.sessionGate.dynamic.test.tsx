// @vitest-environment jsdom
// The global "continue after a usage limit resets" setting arms held panes
// only once the saved session's settings have landed: at boot `list()` can
// resolve first, and the default (on) must not arm panes against a saved "off".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '../../stores';
import { useUsageLimitBridge } from '../useUsageLimitBridge';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const update = vi.fn(async () => ({ ok: true }));

function Bridge() {
  useUsageLimitBridge();
  return null;
}

async function mountWithHeldPane() {
  vi.stubGlobal('electronAPI', {
    usageLimit: {
      update,
      list: vi.fn(async () => [{ ptyId: 'pty-1', provider: 'claude', detectedAt: 1_000, resetsAt: Date.now() + 3_600_000, source: 'hook' }]),
      onChanged: () => () => undefined,
    },
  });
  await act(async () => root.render(<Bridge />));
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
  expect(useStore.getState().usageLimits['pty-1']).toBeDefined();
}

beforeEach(() => {
  update.mockClear();
  useStore.setState({ usageLimits: {}, usageLimitAutoResume: true, sessionSettingsLoaded: false } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useUsageLimitBridge: the global setting waits for the saved session', () => {
  it('a saved "off" landing after the limits arms nothing', async () => {
    await mountWithHeldPane();
    expect(update).not.toHaveBeenCalled();
    // loadSession restores the setting and marks the settings loaded in one set.
    await act(async () => { useStore.setState({ usageLimitAutoResume: false, sessionSettingsLoaded: true } as never); });
    expect(update).not.toHaveBeenCalled();
  });

  it('a setup with the setting on arms the held pane once the settings land', async () => {
    await mountWithHeldPane();
    expect(update).not.toHaveBeenCalled();
    await act(async () => { useStore.setState({ sessionSettingsLoaded: true } as never); });
    expect(update).toHaveBeenCalledWith('pty-1', { autoResume: true });
  });
});
