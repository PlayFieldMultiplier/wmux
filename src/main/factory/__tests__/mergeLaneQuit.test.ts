// Quit never waits on the merge lane beyond LANE_QUIT_WAIT_MS: a lane merge
// still in flight (a slow gh call) cannot hold the factory's dispose.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' } }));
vi.mock('../../deck/taskLedgerHost', () => ({ getTaskLedger: () => ({ list: () => [], get: () => null, onTransition: () => () => undefined }) }));

import { MoaMergeExecutor } from '../../deck/moaMergeExecutor';
import { createFactLog, setFactLog, type FactLog } from '../factLog';
import { LANE_QUIT_WAIT_MS, createMergeLaneModule } from '../mergeLaneHost';
import type { FactoryHostDeps } from '../factoryHost';

let dir = '';
let log: FactLog;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp14-lane-quit-'));
  log = createFactLog(path.join(dir, 'factory'), { log: () => undefined });
  log.start();
  setFactLog(log);
});

afterEach(() => {
  vi.restoreAllMocks();
  setFactLog(null);
  log.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('merge lane module dispose', () => {
  it('returns within its bound while a lane run never finishes', async () => {
    vi.spyOn(MoaMergeExecutor.prototype, 'reconcileAll').mockResolvedValue(undefined);
    vi.spyOn(MoaMergeExecutor.prototype, 'idle').mockReturnValue(new Promise<void>(() => undefined));
    const mod = createMergeLaneModule({ wmuxDir: () => dir, getDaemonClient: () => null } as unknown as FactoryHostDeps);
    await mod.start?.();
    expect(MoaMergeExecutor.prototype.reconcileAll).toHaveBeenCalled();
    const at = Date.now();
    await mod.dispose?.();
    const took = Date.now() - at;
    expect(took).toBeGreaterThanOrEqual(LANE_QUIT_WAIT_MS - 50);
    expect(took).toBeLessThan(LANE_QUIT_WAIT_MS + 1_000);
  });
});
