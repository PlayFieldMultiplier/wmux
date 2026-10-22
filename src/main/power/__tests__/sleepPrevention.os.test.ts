// Keep the computer awake: the blocker the mode and the working verdict
// decide, and the sleep window reported after a resume. Electron's
// powerSaveBlocker and powerMonitor are mocked; the same behaviour is pinned
// under win32 and darwin, the two platforms wmux ships the setting on.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RELEASE_GRACE_MS, SleepPrevention, type PowerSaveBlockerLike } from '../sleepPrevention';

function fakeBlocker() {
  const started = new Set<number>();
  let next = 1;
  const blocker: PowerSaveBlockerLike & { started: Set<number> } = {
    started,
    start: vi.fn((type: 'prevent-app-suspension') => {
      expect(type).toBe('prevent-app-suspension');
      const id = next++;
      started.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => { started.delete(id); }),
    isStarted: vi.fn((id: number) => started.has(id)),
  };
  return blocker;
}

describe.each(['win32', 'darwin'] as const)('SleepPrevention on %s', (platform) => {
  const realPlatform = process.platform;
  let blocker: ReturnType<typeof fakeBlocker>;
  let power: EventEmitter;
  let clock: number;
  let slept: Array<{ suspendedAt: number; resumedAt: number }>;
  let sp: SleepPrevention;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    blocker = fakeBlocker();
    power = new EventEmitter();
    clock = 1_000;
    slept = [];
    sp = new SleepPrevention({ blocker, power, now: () => clock, onSlept: (w) => slept.push(w) });
  });

  afterEach(() => {
    sp.dispose();
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('defaults to "while working": holds one blocker while agents work, releases it when all are idle', () => {
    expect(blocker.start).not.toHaveBeenCalled();
    sp.setAgentsWorking(true);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    const id = sp.heldId as number;
    expect(blocker.started.has(id)).toBe(true);

    sp.setAgentsWorking(true); // no second blocker for the same state
    expect(blocker.start).toHaveBeenCalledTimes(1);

    sp.setAgentsWorking(false);
    // Held through the grace a hand-off between turns needs, then let go.
    vi.advanceTimersByTime(RELEASE_GRACE_MS - 1);
    expect(sp.heldId).toBe(id);
    vi.advanceTimersByTime(1);
    expect(blocker.stop).toHaveBeenCalledWith(id);
    expect(sp.heldId).toBeNull();
    expect(blocker.started.size).toBe(0);
  });

  it('an agent that starts within the grace keeps the same blocker', () => {
    sp.setAgentsWorking(true);
    const id = sp.heldId;
    sp.setAgentsWorking(false);
    vi.advanceTimersByTime(RELEASE_GRACE_MS / 2);
    sp.setAgentsWorking(true);
    vi.advanceTimersByTime(RELEASE_GRACE_MS * 2);
    expect(sp.heldId).toBe(id);
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });

  it('"always" holds with no agent working; "off" never holds', () => {
    sp.setMode('always');
    expect(sp.heldId).not.toBeNull();
    sp.setAgentsWorking(true);
    sp.setAgentsWorking(false);
    expect(blocker.start).toHaveBeenCalledTimes(1); // the same blocker throughout
    expect(sp.heldId).not.toBeNull();

    sp.setMode('off');
    expect(sp.heldId).toBeNull();
    sp.setAgentsWorking(true);
    expect(sp.heldId).toBeNull();
    expect(blocker.started.size).toBe(0);
  });

  it('switching modes while agents work starts and stops exactly one blocker', () => {
    sp.setAgentsWorking(true);
    const first = sp.heldId;
    sp.setMode('always');
    expect(sp.heldId).toBe(first);
    sp.setMode('off');
    expect(blocker.stop).toHaveBeenCalledWith(first);
    sp.setMode('working');
    expect(sp.heldId).not.toBeNull();
    expect(sp.heldId).not.toBe(first);
    expect(blocker.started.size).toBe(1);
  });

  it('ignores a mode it does not know', () => {
    sp.setAgentsWorking(true);
    sp.setMode('sometimes');
    sp.setMode(undefined);
    expect(sp.heldId).not.toBeNull();
  });

  it('starts again when the held blocker was stopped from elsewhere', () => {
    sp.setMode('always');
    const id = sp.heldId as number;
    blocker.started.delete(id);
    sp.setAgentsWorking(true); // any re-evaluation
    expect(sp.heldId).not.toBe(id);
    expect(blocker.started.has(sp.heldId as number)).toBe(true);
  });

  it('a gone renderer no longer keeps the computer awake', () => {
    sp.setAgentsWorking(true);
    sp.rendererGone();
    expect(sp.heldId).toBeNull();
  });

  it('dispose releases the blocker and stops listening to sleep', () => {
    sp.setMode('always');
    const id = sp.heldId;
    sp.dispose();
    expect(blocker.stop).toHaveBeenCalledWith(id);
    power.emit('suspend');
    power.emit('resume');
    expect(slept).toEqual([]);
  });

  it('reports the window slept through, once per suspend', () => {
    clock = 10_000;
    power.emit('suspend');
    clock = 70_000;
    power.emit('resume');
    expect(slept).toEqual([{ suspendedAt: 10_000, resumedAt: 70_000 }]);
    power.emit('resume'); // no suspend before it: nothing to report
    expect(slept).toHaveLength(1);
  });

  it('keeps the blocker across a sleep', () => {
    sp.setAgentsWorking(true);
    const id = sp.heldId;
    power.emit('suspend');
    power.emit('resume');
    expect(sp.heldId).toBe(id);
  });
});
