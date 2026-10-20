import { expect, it, vi } from 'vitest';
import { registerPluginManagementHandlers } from '../pluginManagement.handler';
import { PLUGIN_MANAGEMENT_IPC } from '../../../../shared/pluginManagement';

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
vi.mock('electron', () => ({ ipcMain: {
  removeHandler: vi.fn(), handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler),
} }));

it('limits listing and lifecycle mutations to the owner top frame', async () => {
  const frame = {};
  const contents = { mainFrame: frame };
  const owner = { isDestroyed: () => false, webContents: contents };
  const manager = { inventory: vi.fn(), install: vi.fn(), setEnabled: vi.fn(), remove: vi.fn() };
  registerPluginManagementHandlers(() => owner as never, () => manager as never);
  for (const channel of [PLUGIN_MANAGEMENT_IPC.list, PLUGIN_MANAGEMENT_IPC.install, PLUGIN_MANAGEMENT_IPC.enabled, PLUGIN_MANAGEMENT_IPC.remove]) {
    const handler = handlers.get(channel)!;
    await expect(handler({ sender: contents, senderFrame: {} }, 'agent-state-page', true)).rejects.toThrow('Permission denied');
    await expect(handler({ sender: {}, senderFrame: frame }, 'agent-state-page', true)).rejects.toThrow('Permission denied');
    await handler({ sender: contents, senderFrame: frame }, 'agent-state-page', true);
  }
  expect(manager.inventory).toHaveBeenCalledOnce();
  expect(manager.install).toHaveBeenCalledExactlyOnceWith('agent-state-page');
  expect(manager.setEnabled).toHaveBeenCalledExactlyOnceWith('agent-state-page', true);
  expect(manager.remove).toHaveBeenCalledExactlyOnceWith('agent-state-page');
});
