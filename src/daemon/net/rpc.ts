// === `net.*` control-pipe RPCs: firewall and port diagnosis for the three listeners ===
//
// Machine-local control-pipe methods (like `daemon.web.*`, deliberately not
// in the RpcMethod union, so they add no API-reference surface). Main calls
// them for the Remote page, Settings › LAN and Share & pair; nothing here
// changes the firewall. The elevated Fix runs in main.
//
//   net.inboundStatus  { listener, fresh? } → InboundStatus (the read-only probe)
//   net.listenProblem  { listener }       → ListenProblemReport | null
//   net.firewallTarget { listener }       → what main needs to build the Fix
//   net.firewallRecord { listener, op }   → record (set) or forget (clear) a confirmed rule
//
// Concurrent asks for the same listener share one probe while the listener's
// facts (port, addresses) are what that probe was started with. `fresh` asks
// for a probe that starts now: after a Fix, a probe that began before the
// rules existed must not answer for them.

import { isFirewallListener, type FirewallListener, type InboundStatus } from '../../shared/netFirewall';
import { firewallRuleIds, type RuleScope } from '../../shared/netFirewallScripts';
import { canonicalExePath } from '../../shared/netWinPaths';
import type { ListenProblemReport } from '../../shared/netListen';
import type { FirewallRecordStore } from './firewallRecord';
import { probeInbound, type ProbeDeps, type ProbeTarget } from './inboundProbe';
import { diagnoseListenProblem, type ListenFailure, type ListenProblemDeps } from './portProblem';

export interface NetRpcDeps {
  /** The listener's facts right now. */
  target: (listener: FirewallListener) => ProbeTarget;
  /** The listener's last bind failure, or null when it did not fail to bind. */
  failure: (listener: FirewallListener) => ListenFailure | null;
  records: FirewallRecordStore;
  scope: RuleScope;
  exe?: string;
  platform?: NodeJS.Platform;
  probe?: Partial<Omit<ProbeDeps, 'scope' | 'record'>>;
  lookup?: ListenProblemDeps;
  now?: () => number;
}

export interface FirewallTarget {
  listener: FirewallListener;
  platform: NodeJS.Platform;
  exe: string;
  applicable: boolean;
  port: number | null;
  tailnet: boolean;
}

/** What a probe was started for: a probe for other facts never answers for these. */
function targetKey(t: ProbeTarget): string {
  return `${t.applicable}|${t.port ?? ''}|${t.ips.join(',')}|${t.tailnet}`;
}

function listenerOf(params: Record<string, unknown>, method: string): FirewallListener {
  const l = params['listener'];
  if (!isFirewallListener(l)) throw new Error(`${method}: listener must be one of a2a, web, lanlink`);
  return l;
}

export function registerNetRpc(onRpc: (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => void, deps: NetRpcDeps): void {
  // The long form: the rule, its IDs, the probe and the record all name this string.
  const exe = deps.exe ?? canonicalExePath(process.execPath);
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const inFlight = new Map<FirewallListener, { key: string; probe: Promise<InboundStatus> }>();

  onRpc('net.inboundStatus', async (params) => {
    const listener = listenerOf(params, 'net.inboundStatus');
    const target = deps.target(listener);
    const key = targetKey(target);
    const running = inFlight.get(listener);
    if (running && running.key === key && params['fresh'] !== true) return running.probe;
    const entry = {
      key,
      probe: probeInbound(target, {
        ...deps.probe,
        platform,
        exe,
        now,
        scope: deps.scope,
        record: (l) => deps.records.get(l),
      }).finally(() => {
        // A later probe may have taken the slot; leave it.
        if (inFlight.get(listener) === entry) inFlight.delete(listener);
      }),
    };
    inFlight.set(listener, entry);
    return entry.probe;
  });

  onRpc('net.listenProblem', async (params): Promise<ListenProblemReport | null> => {
    const failure = deps.failure(listenerOf(params, 'net.listenProblem'));
    if (!failure) return null;
    return diagnoseListenProblem(failure, { platform, ...deps.lookup });
  });

  onRpc('net.firewallTarget', async (params): Promise<FirewallTarget> => {
    const listener = listenerOf(params, 'net.firewallTarget');
    const t = deps.target(listener);
    return { listener, platform, exe, applicable: t.applicable, port: t.port, tailnet: t.tailnet };
  });

  onRpc('net.firewallRecord', async (params) => {
    const listener = listenerOf(params, 'net.firewallRecord');
    const op = params['op'];
    if (op === 'clear') return { ok: deps.records.clear(listener) };
    if (op !== 'set') throw new Error("net.firewallRecord: op must be 'set' or 'clear'");
    // The record names what this daemon serves now, never what the caller says.
    const t = deps.target(listener);
    if (!t.applicable || t.port === null) return { ok: false };
    const id = firewallRuleIds(listener, exe, deps.scope).base;
    return { ok: deps.records.set({ listener, id, port: t.port, exe, createdAt: now() }) };
  });
}
