// The wiring says, as it registers, that a worker lifecycle host comes, so a
// row that ends before the host is up ends no worker run (workerRunEnds.ts).

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' }, BrowserWindow: class {}, ipcMain: { handle: () => undefined, on: () => undefined } }));

import { createFactoryWiring } from '../factoryWiring';
import { setWorkerStopsConfirmed, workerStopsConfirmed } from '../workerRunEnds';
import { emptyUsage, recordWorkerStart, type BotUsage } from '../budget';
import { setBotStore, type BotStore } from '../botStore';
import { setTaskLedgerForTests } from '../../deck/taskLedgerHost';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';

afterEach(() => {
  setWorkerStopsConfirmed(false);
  setBotStore(null);
  setTaskLedgerForTests(null);
});

describe('the wiring and the bots\' worker runs', () => {
  it('a host to come is known from the register on, before any module starts; none without a daemon', () => {
    expect(workerStopsConfirmed()).toBe(false);
    const withDaemon = createFactoryWiring({ wmuxDir: () => '/nonexistent', getDaemonClient: () => null });
    expect(workerStopsConfirmed()).toBe(true);
    withDaemon.dispose?.();
    expect(workerStopsConfirmed()).toBe(false);
    createFactoryWiring({ wmuxDir: () => '/nonexistent' });
    expect(workerStopsConfirmed()).toBe(false);
  });

  it('a start that fails before the lifecycle host is on its way hands the runs back to row ends', () => {
    let failing = false;
    const wiring = createFactoryWiring({
      wmuxDir: () => {
        if (failing) throw new Error('no data folder');
        return '/nonexistent';
      },
      getDaemonClient: () => null,
    });
    expect(workerStopsConfirmed()).toBe(true);
    failing = true;
    expect(() => wiring.start?.()).toThrow('no data folder');
    expect(workerStopsConfirmed()).toBe(false);
    wiring.dispose?.();
  });

  it('a task that reached review while the host was coming ends its run when the start fails', () => {
    const usage: BotUsage = emptyUsage();
    recordWorkerStart(usage, 'reviewed', Date.now() - 60_000);
    recordWorkerStart(usage, 'working', Date.now() - 60_000);
    setBotStore({
      list: () => [{ id: 'bot-1' }],
      usageOf: () => usage,
      mutateUsage: (_botId: string, fn: (u: BotUsage) => void) => fn(usage),
    } as unknown as BotStore);
    const statuses: Record<string, string> = { reviewed: 'review_requested', working: 'in_progress' };
    setTaskLedgerForTests({ get: (id: string) => ({ id, status: statuses[id] }) } as unknown as TaskLedger);
    let failing = false;
    const wiring = createFactoryWiring({
      wmuxDir: () => {
        if (failing) throw new Error('no data folder');
        return '/nonexistent';
      },
      getDaemonClient: () => null,
    });
    failing = true;
    expect(() => wiring.start?.()).toThrow('no data folder');
    expect(usage.workers.map((w) => [w.taskId, w.endedAt !== undefined])).toEqual([['reviewed', true], ['working', false]]);
    wiring.dispose?.();
  });
});
