// The wiring says, as it registers, that a worker lifecycle host comes, so a
// row that ends before the host is up ends no worker run (workerRunEnds.ts).

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' }, BrowserWindow: class {}, ipcMain: { handle: () => undefined, on: () => undefined } }));

import { createFactoryWiring } from '../factoryWiring';
import { setWorkerStopsConfirmed, workerStopsConfirmed } from '../workerRunEnds';

afterEach(() => setWorkerStopsConfirmed(false));

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
});
