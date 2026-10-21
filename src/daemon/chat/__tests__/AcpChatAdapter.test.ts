import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnAgent = vi.fn();
vi.mock('../agentProcess', () => ({ spawnAgent: (...args: unknown[]) => spawnAgent(...args), stopAgent: vi.fn() }));

import { AcpChatAdapter } from '../AcpChatAdapter';

afterEach(() => { spawnAgent.mockReset(); });

describe('AcpChatAdapter', () => {
  it('spawns nothing when it is closed while the SDK is still loading', async () => {
    const adapter = new AcpChatAdapter('/bin/agent', []);
    const context = { cwd: '/tmp', env: {}, emit: vi.fn(), request: vi.fn(), disconnected: vi.fn() };
    const connecting = adapter.connect(context as never);
    adapter.close();
    await expect(connecting).rejects.toThrow('ACP adapter closed');
    expect(spawnAgent).not.toHaveBeenCalled();
  });
});
