import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RetryableRpcError } from '../../RetryableRpcError';
import { sendToRenderer } from '../_bridge';
const ipc = vi.hoisted(() => ({ once: vi.fn(), removeAllListeners: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: ipc }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it('returns a retryable timeout and removes the response listener when no responder is registered', async () => {
  vi.useFakeTimers();
  const window = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  const failure = new RetryableRpcError('Responder not ready');
  const result = sendToRenderer(() => window, 'agent.state', {}, { timeoutError: failure });
  const rejected = expect(result).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(ipc.removeAllListeners).toHaveBeenCalledWith(ipc.once.mock.calls[0][0]);
});
it('preserves ordinary timeout errors for callers that do not opt into retry', async () => {
  vi.useFakeTimers();
  const window = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  const result = sendToRenderer(() => window, 'pane.list');
  const rejected = expect(result).rejects.toThrow('RPC timeout: pane.list (5000ms)');
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
});
