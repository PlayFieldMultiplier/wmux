// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { installSleepPreventionBridge, type SleepPowerApi } from '../sleepPreventionBridge';
import { selectMissedWhileAsleep } from '../../stores/selectors/schedules';
import { seedFleetTriageStore } from './fleetTriageFixture';
import type { SleepWindow } from '../../../shared/sleepPrevention';

function fakePower() {
  let slept: ((w: SleepWindow) => void) | null = null;
  const off = vi.fn();
  const power: SleepPowerApi = {
    setSleepMode: vi.fn(),
    setAgentsWorking: vi.fn(),
    onSlept: vi.fn((cb) => { slept = cb; return off; }),
  };
  return { power, off, sleep: (w: SleepWindow) => slept?.(w) };
}

describe('sleep prevention bridge (renderer → main)', () => {
  it('primes main on install, then sends each change once', () => {
    const now = Date.now();
    seedFleetTriageStore(now); // pty-3 is working
    const { power, off } = fakePower();
    const dispose = installSleepPreventionBridge(useStore, power);
    expect(power.setSleepMode).toHaveBeenCalledWith('working');
    expect(power.setAgentsWorking).toHaveBeenCalledWith(true);

    // Output that moves no section sends nothing.
    useStore.setState({ surfaceOutputAt: { 'pty-3': now + 1 } });
    expect(power.setAgentsWorking).toHaveBeenCalledTimes(1);

    // The last working agent settles: all idle.
    useStore.setState({ surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'waiting' } }, surfaceTurnOpenAt: {} });
    expect(power.setAgentsWorking).toHaveBeenLastCalledWith(false);
    expect(power.setAgentsWorking).toHaveBeenCalledTimes(2);

    useStore.getState().setSleepPreventionMode('always');
    expect(power.setSleepMode).toHaveBeenLastCalledWith('always');
    useStore.getState().setSleepPreventionMode('off');
    expect(power.setSleepMode).toHaveBeenLastCalledWith('off');
    expect(power.setSleepMode).toHaveBeenCalledTimes(3);

    dispose();
    expect(off).toHaveBeenCalled();
    useStore.getState().setSleepPreventionMode('working');
    expect(power.setSleepMode).toHaveBeenCalledTimes(3);
  });

  it('records the window main reports, which raises the missed-runs notice', () => {
    seedFleetTriageStore(Date.now(), {
      automations: [{ id: 'a1' } as never],
      automationRuns: [{
        id: 'm1', automationId: 'a1', revision: 1, effectiveMode: 'approval', scheduledFor: 20_000,
        trigger: 'scheduled', state: 'skipped', reason: 'missed',
      }],
    });
    const { power, sleep } = fakePower();
    const dispose = installSleepPreventionBridge(useStore, power);
    expect(selectMissedWhileAsleep(useStore.getState()).count).toBe(0);
    sleep({ suspendedAt: 10_000, resumedAt: 90_000 });
    expect(selectMissedWhileAsleep(useStore.getState()).count).toBe(1);
    dispose();
  });

  it('does nothing without a power API (browser build, old preload)', () => {
    expect(() => installSleepPreventionBridge(useStore, undefined)()).not.toThrow();
  });
});
