import { A2A_REMOTE_RPC, type A2aRemoteTarget } from '../../shared/a2aRemoteDelivery';
import type { A2aLinkRecordV1 } from '../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../shared/rpc';
import type { A2aRemotePeerHint, RemoteA2aRpcDeps } from '../pipe/handlers/a2a.rpc';

type DaemonRpc = { rpc: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown> };

/** The cap on each local daemon read behind the paired-PC hints. */
export const PEER_HINT_RPC_TIMEOUT_MS = 1_500;
/** How long a joined PC's answer to "what do you show me" is reused before it is asked again. */
export const PEER_EXPOSED_TTL_MS = 30_000;

/** What a joined PC last said it shows this one. */
interface ExposedSeen { panes: number; brain: boolean; at: number }

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
  // Asking a joined PC what it shows goes over the network, so a2a.discover
  // never waits for it: it reads the last answer and, when that is missing or
  // old, starts a read in the background for the next call: at most one per
  // PC per TTL, answered or not.
  const exposedSeen = new Map<string, ExposedSeen>();
  const exposedAskedAt = new Map<string, number>();
  function exposedOf(dc: DaemonRpc, hostId: string): ExposedSeen | null {
    const seen = exposedSeen.get(hostId) ?? null;
    const now = Date.now();
    const askedAt = exposedAskedAt.get(hostId);
    if ((!seen || now - seen.at > PEER_EXPOSED_TTL_MS) && (askedAt === undefined || now - askedAt > PEER_EXPOSED_TTL_MS)) {
      exposedAskedAt.set(hostId, now);
      void dc.rpc('a2a.remote.hosts.exposed', { hostId })
        .then((res) => {
          if (!isRecord(res) || res.ok !== true || !Array.isArray(res.panes)) return;
          const panes = (res.panes as unknown[]).filter(isRecord);
          exposedSeen.set(hostId, {
            panes: panes.filter((p) => p.kind === 'pane').length,
            brain: panes.some((p) => p.kind === 'brain'),
            at: Date.now(),
          });
        })
        .catch(() => undefined);
    }
    return seen;
  }
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
    listPeers: async (workspaceId, panesOf) => {
      const dc = getDaemonClient();
      return dc ? listPeerHints(dc, workspaceId, (hostId) => exposedOf(dc, hostId), panesOf) : [];
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
async function listPeerHints(
  dc: DaemonRpc,
  workspaceId: string | undefined,
  exposedOf: (hostId: string) => ExposedSeen | null,
  panesOf: Promise<(workspaceId: string) => number>,
): Promise<A2aRemotePeerHint[]> {
  const [status, list] = await Promise.all([
    dc.rpc('a2a.remote.hosts.status', {}, { timeoutMs: PEER_HINT_RPC_TIMEOUT_MS }),
    dc.rpc('a2a.remote.links.list', {}, { timeoutMs: PEER_HINT_RPC_TIMEOUT_MS }),
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
    const exposed = h.role === 'joiner' && connected ? exposedOf(h.hostId) : null;
    const exposedPanes = exposed ? exposed.panes : null;
    let shown: number | null = null;
    if (h.role === 'server') {
      try {
        const res = await dc.rpc('a2a.remote.exposure.get', { hostId: h.hostId }, { timeoutMs: PEER_HINT_RPC_TIMEOUT_MS });
        const exp = isRecord(res) && isRecord(res.exposure) ? res.exposure : null;
        const ids = exp && Array.isArray(exp.workspaceIds) ? (exp.workspaceIds as string[]) : [];
        const panes = exp && isRecord(exp.paneIds) ? exp.paneIds : {};
        // A workspace with no pane list shows every pane it has now. Discover
        // lists only terminal panes, so a whole workspace it counts as empty
        // is unknown here, never "nothing shown".
        const whole = ids.filter((ws) => !Array.isArray(panes[ws]));
        const count = whole.length ? await panesOf : () => 0;
        shown = whole.some((ws) => count(ws) === 0)
          ? null
          : ids.reduce((n, ws) => n + (Array.isArray(panes[ws]) ? (panes[ws] as unknown[]).length : count(ws)), 0);
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
    } else if (exposedPanes === 0 && exposed?.brain) {
      hint = 'paired; that PC shows its Moa but no pane to this one (a person can link Moa from the Remote page, or its owner ticks panes in Settings › LAN)';
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
