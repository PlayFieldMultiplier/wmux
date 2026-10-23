// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { MissedWhileAsleepNotice } from '../MissedWhileAsleepNotice';
import { automation, run } from './fixtures';
import type { AutomationRunNowResult } from '../../../../shared/automation';

let container: HTMLDivElement;
let root: Root;
let finish: (result: AutomationRunNowResult) => void;
const runNow = vi.fn(() => new Promise<AutomationRunNowResult>((resolve) => { finish = resolve; }));

beforeEach(() => {
  runNow.mockClear();
  vi.stubGlobal('electronAPI', { automation: { runNow } });
  useStore.setState({
    automations: [automation({ id: 'a1' })],
    automationRuns: [run({ id: 'm1', automationId: 'a1', scheduledFor: 20_000, state: 'skipped', reason: 'missed' })],
    sleepWindow: { suspendedAt: 10_000, resumedAt: 100_000 },
    sleepNoticeDismissed: false,
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

describe('MissedWhileAsleepNotice', () => {
  it('Run now answers the notice before the runs start, so it cannot start them twice', async () => {
    await act(async () => root.render(<MissedWhileAsleepNotice />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-schedules-missed-run]')!.click());
    // The run has not come back yet; the notice is already gone.
    expect(runNow).toHaveBeenCalledTimes(1);
    expect(useStore.getState().sleepNoticeDismissed).toBe(true);
    expect(container.querySelector('[data-schedules-missed]')).toBeNull();
    await act(async () => finish({ ok: true, run: run({ id: 'n1', automationId: 'a1', trigger: 'manual', state: 'launching' }) }));
    expect(runNow).toHaveBeenCalledTimes(1);
  });
});
