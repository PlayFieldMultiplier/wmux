import { expect, it, vi } from 'vitest';
import { RpcRouter } from '../RpcRouter';
import { ApprovalQueue } from '../../mcp/ApprovalQueue';
import type { PluginTrustStore } from '../../mcp/PluginTrustStore';
import type { PluginIdentityRecord } from '../../../shared/rpc';

it('does not create an approval or invoke a handler after the plugin retires during trust lookup', async () => {
  const router = new RpcRouter();
  let resolveTrust!: (record: PluginIdentityRecord) => void;
  const lookup = vi.fn(() => new Promise<PluginIdentityRecord>((resolve) => { resolveTrust = resolve; }));
  router.setTrustLookup(lookup);
  router.setEnforcementMode('enforce');
  const openPrompt = vi.fn();
  const queue = new ApprovalQueue({} as PluginTrustStore, { openPrompt });
  router.setApprovalQueue(queue);
  const handler = vi.fn(async () => ({ panes: [] }));
  router.register('pane.list', handler);
  let current = true;
  const response = router.dispatch({ id: 'old', method: 'pane.list', clientName: 'page', params: {} }, {
    firstParty: true, hostedWorkspace: 'ws-1', isCurrent: () => current,
  });
  expect(lookup).toHaveBeenCalled();
  current = false;
  resolveTrust({ name: 'page', status: 'unconfirmed', declaredCapabilities: ['pane.read'], firstSeen: 1, lastSeen: 1 });
  expect(await response).toMatchObject({ ok: false, error: expect.stringContaining('session changed') });
  expect(handler).not.toHaveBeenCalled();
  expect(openPrompt).not.toHaveBeenCalled();
});
