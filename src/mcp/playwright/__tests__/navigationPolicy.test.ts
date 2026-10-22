import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The MCP server's half of the private-network switch: main owns the setting,
// and this process learns it over the RPC channel on every navigation.

const mockSendRpc = vi.fn();
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { readNavigationPolicy } from '../navigationPolicy';
import { ALLOW_PRIVATE_NETWORK_ENV } from '../../../shared/types';

describe('readNavigationPolicy', () => {
  beforeEach(() => {
    mockSendRpc.mockReset();
    delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
  });
  afterEach(() => {
    delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
  });

  it('asks main and takes its answer', async () => {
    mockSendRpc.mockResolvedValue({ allowPrivateNetwork: true });
    await expect(readNavigationPolicy()).resolves.toEqual({ allowPrivateNetwork: true });
    expect(mockSendRpc).toHaveBeenCalledWith('browser.navigationPolicy.get');

    mockSendRpc.mockResolvedValue({ allowPrivateNetwork: false });
    await expect(readNavigationPolicy()).resolves.toEqual({ allowPrivateNetwork: false });
  });

  it('asks again on every call, so a toggle is never served stale', async () => {
    mockSendRpc
      .mockResolvedValueOnce({ allowPrivateNetwork: true })
      .mockResolvedValueOnce({ allowPrivateNetwork: false });
    expect((await readNavigationPolicy()).allowPrivateNetwork).toBe(true);
    expect((await readNavigationPolicy()).allowPrivateNetwork).toBe(false);
    expect(mockSendRpc).toHaveBeenCalledTimes(2);
  });

  it('reads only a literal true as on', async () => {
    for (const reply of [{ allowPrivateNetwork: 'true' }, { allowPrivateNetwork: 1 }, {}, null, 'yes']) {
      mockSendRpc.mockResolvedValue(reply);
      expect((await readNavigationPolicy()).allowPrivateNetwork, JSON.stringify(reply)).toBe(false);
    }
  });

  it('falls back to the environment variable alone when main cannot answer', async () => {
    mockSendRpc.mockRejectedValue(new Error('wmux is not running. Start the app first.'));
    await expect(readNavigationPolicy()).resolves.toEqual({ allowPrivateNetwork: false });

    process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
    await expect(readNavigationPolicy()).resolves.toEqual({ allowPrivateNetwork: true });
  });

  it('still honours the environment variable while main reports the setting off', async () => {
    process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
    mockSendRpc.mockResolvedValue({ allowPrivateNetwork: false });
    await expect(readNavigationPolicy()).resolves.toEqual({ allowPrivateNetwork: true });
  });
});
