import { describe, expect, it, vi } from 'vitest';
import { botsStopPort, stopAllSummary, stopBotSummary, stopTaskSummary, stoppedWorkOf, toastStoppedWork } from '../botsStop';
import type { FactoryBotPort } from '../../Room/factoryPorts';

const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`;

describe('stopped work on Off', () => {
  it('reads the report only when main sends a well-formed one', () => {
    expect(stoppedWorkOf({ enabled: false })).toBeNull();
    expect(stoppedWorkOf(null)).toBeNull();
    expect(stoppedWorkOf({ stoppedWork: { workers: '2', tasks: 0, ok: true } })).toBeNull();
    expect(stoppedWorkOf({ stoppedWork: { workers: 2, tasks: 1, ok: true } })).toEqual({ workers: 2, tasks: 1, ok: true });
  });

  it('toasts the count, nothing when no worker ran or main sent no report', () => {
    const pushToast = vi.fn();
    toastStoppedWork({ enabled: false }, t, { pushToast }, {});
    toastStoppedWork({ stoppedWork: { workers: 0, tasks: 0, ok: true } }, t, { pushToast }, {});
    expect(pushToast).not.toHaveBeenCalled();
    toastStoppedWork({ stoppedWork: { workers: 1, tasks: 1, ok: true } }, t, { pushToast }, {});
    expect(pushToast).toHaveBeenLastCalledWith({ message: 'settings.factory.offStoppedOne{"count":1}', level: 'info' });
  });

  it('a failed stop offers Try again through Stop all', async () => {
    const pushToast = vi.fn();
    const stopAll = vi.fn(async () => ({ ok: true, botsInterrupted: 0, workersStopped: 2, gatesCancelled: 0 }));
    toastStoppedWork({ stoppedWork: { workers: 0, tasks: 0, ok: false } }, t, { pushToast }, { stopAll });
    const toast = pushToast.mock.calls[0][0];
    expect(toast).toMatchObject({ message: 'settings.factory.offStopFailed', level: 'error', persist: true });
    toast.action.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledTimes(2);
  });
});

// #2388: a partial stop that left a pane running (its process identity is
// unknown) says why on Stop all, a bot's Stop and "Run bots" off, not only on
// Stop worker.
describe('a partial stop carries main\'s reason', () => {
  const why = 'Some work could not be stopped: this pane\'s process identity isn\'t known yet, so it was left running and its folder is kept; the owner can close the task with Close and keep folder, which keeps the folder.';

  it('Stop all and a bot\'s Stop append it', () => {
    expect(stopAllSummary({ ok: false, botsInterrupted: 0, workersStopped: 0, gatesCancelled: 0, message: why }, t)).toBe(`botsPage.stop.failed ${why}`);
    expect(stopBotSummary('Lead', { ok: false, workersStopped: 0, message: why }, t)).toBe(`botsPage.stop.failed ${why}`);
    expect(stopAllSummary({ ok: false, botsInterrupted: 0, workersStopped: 0, gatesCancelled: 0 }, t)).toBe('botsPage.stop.failed');
  });

  it('"Run bots" off appends it to its failure toast', () => {
    const pushToast = vi.fn();
    expect(stoppedWorkOf({ stoppedWork: { workers: 0, tasks: 1, ok: false, message: why } })).toEqual({ workers: 0, tasks: 1, ok: false, message: why });
    toastStoppedWork({ stoppedWork: { workers: 0, tasks: 1, ok: false, message: why } }, t, { pushToast }, {});
    expect(pushToast.mock.calls[0][0]).toMatchObject({ message: `settings.factory.offStopFailed ${why}`, level: 'error' });
  });
});

describe('one worker\'s stop (Stop worker)', () => {
  it('says the worker stopped, that its task had already ended, or that the stop failed', () => {
    expect(stopTaskSummary('fix login', { ok: true, workersStopped: 1, tasksCancelled: 1 }, t)).toBe('botsPage.stop.workerStopped{"task":"fix login"}');
    // A cancelled task whose agent had already exited is still a stop.
    expect(stopTaskSummary('fix login', { ok: true, workersStopped: 0, tasksCancelled: 1 }, t)).toBe('botsPage.stop.workerStopped{"task":"fix login"}');
    expect(stopTaskSummary('fix login', { ok: true, workersStopped: 0, tasksCancelled: 0 }, t)).toBe('botsPage.stop.workerAlreadyStopped{"task":"fix login"}');
    // A failure names the worker, not the bots, and keeps main's reason.
    expect(stopTaskSummary('fix login', { ok: false, workersStopped: 0 }, t)).toBe('botsPage.stop.workerFailed{"task":"fix login"}');
    expect(stopTaskSummary('fix login', { ok: false, workersStopped: 0, code: 'partial', message: 'Stop again to retry.' }, t))
      .toBe('botsPage.stop.workerFailed{"task":"fix login"} Stop again to retry.');
  });

  it('the verb comes from the port when it has it, else from the bridge', async () => {
    const base: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }) };
    const fromPort = vi.fn(async () => ({ ok: true, botsInterrupted: 0, workersStopped: 1, gatesCancelled: 0 }));
    await botsStopPort({ ...base, stopTask: fromPort }).stopTask?.('wtask-a-00000001');
    expect(fromPort).toHaveBeenCalledWith('wtask-a-00000001');
    const fromBridge = vi.fn(async () => ({ ok: true, workersStopped: 1 }));
    vi.stubGlobal('electronAPI', { factory: { stopTask: fromBridge } });
    try {
      await botsStopPort(base).stopTask?.('wtask-b-00000002');
      expect(fromBridge).toHaveBeenCalledWith('wtask-b-00000002');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(botsStopPort(base).stopTask).toBeUndefined();
  });
});
