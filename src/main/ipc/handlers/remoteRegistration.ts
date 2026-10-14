// The remote-host IPC surfaces, registered together over ONE pair of stores:
// the attach handlers (remote.handler.ts) and the PC rail feeds
// (pcRail.handler.ts). Sharing the instances is what keeps a host paired,
// re-paired or removed on one surface current on the other.

import { registerRemoteHandlers } from './remote.handler';
import { registerPcRailHandlers } from './pcRail.handler';
import { RemoteHostsStore } from '../../remote/RemoteHostsStore';
import { RemoteAttachmentsStore } from '../../remote/RemoteAttachmentsStore';
import * as path from 'path';
import { getWmuxDir } from '../../../daemon/config';
import { createSshAwareFetch, getSshTunnelRegistry } from '../../remote/SshTunnelSupervisor';
import { reviveHost } from '../../remote/SshBootstrap';
import { runSsh } from '../../remote/sshCommand';

export interface RemoteRegistrationDeps {
  registerRemote: typeof registerRemoteHandlers;
  registerPcRail: typeof registerPcRailHandlers;
}

export function registerRemoteSurfaces(
  stores: { store: RemoteHostsStore; attachments: RemoteAttachmentsStore },
  deps: RemoteRegistrationDeps = { registerRemote: registerRemoteHandlers, registerPcRail: registerPcRailHandlers },
): () => void {
  // One fetch for both surfaces: SSH hosts (wmux-ssh://<id>) go through their tunnel.
  // Each tunnel start first brings the host's daemon (and with it web) back if it idled out.
  const sshTunnels = getSshTunnelRegistry(path.join(getWmuxDir(), 'ssh'), (_id, binding) =>
    reviveHost(runSsh, binding.alias, binding.remotePort));
  const fetchImpl = createSshAwareFetch(fetch, sshTunnels, (id) => stores.store.get(id));
  const disposeRemote = deps.registerRemote({ store: stores.store, attachments: stores.attachments, fetchImpl, sshTunnels });
  const disposePcRail = deps.registerPcRail({ store: stores.store, attachments: stores.attachments, fetchImpl });
  return () => {
    disposePcRail();
    disposeRemote();
  };
}
