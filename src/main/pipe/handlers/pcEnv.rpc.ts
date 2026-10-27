// pc.envDiff — this PC's agent environment beside every paired PC's, and
// where they differ (main/pcdiff/agentEnv.ts). Read-only and first-party:
// it reads the paired PCs with their stored credentials, and answers names,
// versions and hashes only.

import type { RpcRouter } from '../RpcRouter';
import { cachedAgentEnvSummary, pcEnvDiff } from '../../pcdiff/agentEnv';
import { remoteHostsAccess } from '../../ipc/handlers/remoteRegistration';

export function registerPcEnvRpc(router: RpcRouter, deps: { wmuxVersion: string }): void {
  router.register('pc.envDiff', async () => {
    const access = remoteHostsAccess();
    return pcEnvDiff({
      local: () => cachedAgentEnvSummary({ wmuxVersion: deps.wmuxVersion }),
      hosts: () => access?.store.list().map((h) => ({ id: h.id, label: h.label })) ?? [],
      host: (id) => access?.store.get(id) ?? null,
      fetchImpl: access?.fetchImpl ?? fetch,
    });
  });
}
