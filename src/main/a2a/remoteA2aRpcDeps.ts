import { A2A_REMOTE_RPC, type A2aRemoteTarget } from '../../shared/a2aRemoteDelivery';
import type { A2aLinkRecordV1 } from '../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../shared/rpc';
import type { A2aRemotePeerHint, RemoteA2aRpcDeps } from '../pipe/handlers/a2a.rpc';

type DaemonRpc = { rpc: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown> };

/** How long a2a.discover waits for a joined PC to say how many panes it shows this one. */
export const PEER_EXPOSED_TIMEOUT_MS = 1_500;

/**
 * The cross-host hooks of the a2a pipe handlers, backed by daemon RPCs
 * (`A2A_REMOTE_RPC`). No daemon: no targets (every alias takes the local
 * path), and every operation answers `unavailable`.
 */
export function daemonRemoteA2aRpcDeps(
  getDaemonClient: () => DaemonRpc | null,
): RemoteA2aRpcDeps {
  const op = async (method: string, params: object): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> => {
    const dc = getDaemonClient();
    if (!dc) return { ok: false, error: 'unavailable' };
    const res = await dc.rpc(method, { ...params });
    if (isRecord(res) && res.ok === true && typeof res.taskId === 'string') return { ok: true, taskId: res.taskId };
    return { ok: false, error: isRecord(res) && typeof res.error === 'string' ? res.error : 'unavailable' };
  };
  return {
    listTargets: async () => {
      const dc = getDaemonClient();
      if (!dc) return [];
      const res = await dc.rpc(A2A_REMOTE_RPC.targets, {});
      return isRecord(res) && Array.isArray(res.targets) ? (res.targets as A2aRemoteTarget[]) : [];
    },
    sendTask: (input) => op(A2A_REMOTE_RPC.sendTask, input),
    reply: (input) => op(A2A_REMOTE_RPC.reply, input),
    state: (input) => op(A2A_REMOTE_RPC.state, input),
    read: async (input) => getDaemonClient()?.rpc(A2A_REMOTE_RPC.read, { ...input }),
    listPeers: async (workspaceId) => {
      const dc = getDaemonClient();
      return dc ? listPeerHints(dc, workspaceId) : [];
    },
  };
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Every paired PC with no active link in the workspace, and the step still
 * missing: this tells "not paired" (absent), "paired, nothing shown" and
 * "shown, not linked" apart for an agent. Counts only — a pane the other PC
 * shows is never named here, and nothing about a pane it does not show
 * reaches this PC at all (the other PC filters `/api/a2a/exposed`).
 */
async function listPeerHints(dc: DaemonRpc, workspaceId?: string): Promise<A2aRemotePeerHint[]> {
  const [status, list] = await Promise.all([
    dc.rpc('a2a.remote.hosts.status', {}),
    dc.rpc('a2a.remote.links.list', {}),
  ]);
  const hosts = isRecord(status) && Array.isArray(status.hosts) ? (status.hosts as A2aRemoteHostStatus[]) : [];
  const links = (isRecord(list) && Array.isArray(list.links) ? (list.links as A2aLinkRecordV1[]) : [])
    .filter((l) => !workspaceId || l.local.workspaceId === workspaceId);
  const out = await Promise.all(hosts.map(async (h): Promise<A2aRemotePeerHint | null> => {
    const own = links.filter((l) => l.remote.hostId === h.hostId);
    if (own.some((l) => l.state === 'active')) return null;
    const asked = own.filter((l) => l.state === 'proposed-in').length;
    const asking = own.filter((l) => l.state === 'proposed-out').length;
    const connected = h.state === 'connected';
    // Only a PC this one joined shows panes to it; asked only while its stream is up.
    let exposedPanes: number | null = null;
    if (h.role === 'joiner' && connected) {
      try {
        const res = await dc.rpc('a2a.remote.hosts.exposed', { hostId: h.hostId }, { timeoutMs: PEER_EXPOSED_TIMEOUT_MS });
        if (isRecord(res) && res.ok === true && Array.isArray(res.panes)) {
          exposedPanes = (res.panes as Array<{ kind?: unknown }>).filter((p) => isRecord(p) && p.kind === 'pane').length;
        }
      } catch { /* away or slow: the count stays unknown */ }
    }
    let shown: number | null = null;
    if (h.role === 'server') {
      try {
        const res = await dc.rpc('a2a.remote.exposure.get', { hostId: h.hostId });
        const exp = isRecord(res) && isRecord(res.exposure) ? res.exposure : null;
        const ids = exp && Array.isArray(exp.workspaceIds) ? (exp.workspaceIds as string[]) : [];
        const panes = exp && isRecord(exp.paneIds) ? exp.paneIds : {};
        // a2a.remote.exposure.set always writes each workspace's pane list.
        shown = ids.reduce((n, ws) => n + (Array.isArray(panes[ws]) ? (panes[ws] as unknown[]).length : 0), 0);
      } catch { /* the hint falls back to the general line */ }
    }
    let hint: string;
    if (h.state === 'identity-changed') hint = 'paired, but its certificate changed; a person must remove it or pair again on the Remote page';
    else if (asked > 0) hint = 'paired; a link request from that PC waits for a person on this PC (Remote page)';
    else if (asking > 0) hint = 'paired; a link request waits for a person on that PC to accept it';
    else if (!connected) hint = 'paired but not connected right now; no pane linked yet';
    else if (h.role === 'server') {
      hint = shown === 0
        ? 'paired (it joined this PC); this PC shows it no pane yet (a person picks them on the Remote page), then a person on that PC requests the link'
        : `paired (it joined this PC); ${shown === null ? 'no pane linked yet' : `this PC shows it ${plural(shown, 'pane')}, none linked yet`} (a person on that PC requests the link)`;
    } else if (exposedPanes === 0) hint = 'paired; that PC shows no pane to this one yet (its owner ticks panes in Settings › LAN)';
    else if (exposedPanes !== null) hint = `paired; that PC shows ${plural(exposedPanes, 'pane')}, none linked yet (a person links one from a pane menu: Link with a pane on another PC)`;
    else hint = 'paired; no pane linked yet';
    return { name: h.name, paired: true, connected, exposedPanes, pendingLinks: asked + asking, hint };
  }));
  return out.filter((p): p is A2aRemotePeerHint => p !== null);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
