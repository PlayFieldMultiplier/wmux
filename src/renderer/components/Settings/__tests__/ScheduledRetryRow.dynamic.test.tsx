// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledRetryRow } from '../ClaudeIntegrationSection';

let container: HTMLDivElement;
let root: Root;
let connected: Array<() => void>;
const settings = vi.fn();
const setSettings = vi.fn();
const t = (key: string) => key;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const sw = () => container.querySelector('[data-scheduled-retry]') as HTMLButtonElement;

beforeEach(() => {
  connected = [];
  settings.mockReset();
  setSettings.mockReset();
  vi.stubGlobal('electronAPI', {
    automation: { settings, setSettings },
    daemon: {
      onConnected: (cb: () => void) => { connected.push(cb); return () => undefined; },
      onReconnected: () => () => undefined,
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ScheduledRetryRow', () => {
  it('shows unknown while the daemon is unavailable, then the daemon\'s value once it connects', async () => {
    settings.mockResolvedValueOnce(null);
    await act(async () => root.render(<ScheduledRetryRow t={t} />));
    await flush();
    expect(sw().dataset.scheduledRetry).toBe('unknown');
    expect(sw().disabled).toBe(true);
    expect(container.textContent).toContain('claudeIntegration.scheduledRetryUnknown');
    settings.mockResolvedValueOnce({ retryTransientErrors: false });
    await act(async () => { for (const cb of connected) cb(); });
    await flush();
    expect(sw().dataset.scheduledRetry).toBe('off');
    expect(sw().disabled).toBe(false);
  });

  it('a write that errors marks it unknown and re-reads the saved value', async () => {
    settings.mockResolvedValueOnce({ retryTransientErrors: true });
    await act(async () => root.render(<ScheduledRetryRow t={t} />));
    await flush();
    expect(sw().dataset.scheduledRetry).toBe('on');
    let failWrite!: (e: unknown) => void;
    setSettings.mockReturnValueOnce(new Promise((_res, rej) => { failWrite = rej; }));
    await act(async () => { sw().click(); });
    expect(sw().dataset.scheduledRetry).toBe('off');
    let answerRead!: (v: unknown) => void;
    settings.mockReturnValueOnce(new Promise((res) => { answerRead = res; }));
    await act(async () => { failWrite(new Error('timeout')); });
    await flush();
    expect(sw().dataset.scheduledRetry).toBe('unknown');
    // The daemon did save it before the timeout.
    await act(async () => { answerRead({ retryTransientErrors: false }); });
    await flush();
    expect(sw().dataset.scheduledRetry).toBe('off');
    expect(settings).toHaveBeenCalledTimes(2);
  });
});
