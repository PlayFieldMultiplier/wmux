import { describe, expect, it, vi } from 'vitest';

const { getAppMetrics } = vi.hoisted(() => ({ getAppMetrics: vi.fn(() => [
  { pid: 123, type: 'Browser', memory: { workingSetSize: 1024 } },
]) }));
vi.mock('electron', () => ({ app: { getAppMetrics } }));
import { registerPerfRpc } from '../perf.rpc';
import { RpcRouter } from '../../RpcRouter';

describe('perf.status memory diagnostics', () => {
  it('samples Electron memory only on explicit request', async () => {
    const router = new RpcRouter();
    registerPerfRpc(router);
    getAppMetrics.mockClear();
    const normal = await router.dispatch({ id: 'normal', method: 'perf.status', params: {} });
    expect(normal.ok).toBe(true);
    expect(getAppMetrics).not.toHaveBeenCalled();
    const diagnostic = await router.dispatch({ id: 'memory', method: 'perf.status', params: { includeMemory: true } });
    expect(diagnostic).toMatchObject({ ok: true, result: { memory: {
      mainPid: process.pid, processes: [{ pid: 123, type: 'Browser', workingSetBytes: 1024 * 1024 }],
    } } });
    expect(getAppMetrics).toHaveBeenCalledTimes(1);
  });
});
