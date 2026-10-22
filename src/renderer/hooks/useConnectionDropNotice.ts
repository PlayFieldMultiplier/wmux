import { useEffect } from 'react';
import { useStore, type StoreState } from '../stores';
import { t } from '../i18n';
import type { TailscaleChecklist } from '../../shared/web';
import { blockingFailure, describeTailnetFailure, hostOfUrl, isTailnetHost, readTailscale } from '../components/Remote/tailnetCheck';

// ─── Drop notice ─────────────────────────────────────────────────────────────
//
// While a connection to another PC is IN USE, a real drop gets one toast; a
// blip that comes back on its own gets none. "In use" is narrow on purpose:
//
//   A2A PC            connected AND at least one active pane link with it
//   workspace share   at least one of its workspaces attached here
//
// Phones are out: a phone's stream drops every time its screen locks, which is
// exactly the false alarm this must never raise.
//
// A drop is reported only once it has lasted its source's grace window:
//
//   A2A stream  12 s  A closed stream is seen at once and a silent one after
//                     the daemon's 45 s liveness; the joiner redials after
//                     1, 2, 4 and 8 s, so a blip is back inside 12 s, and the
//                     slowest real drop is reported by 45 + 12 = 57 s.
//   share       25 s  The host poll runs every 10 s with a 10 s request
//                     timeout, and retries a failure 20 s later. 25 s lets
//                     that one retry heal a blip; the slowest real drop is
//                     seen at 20 s and reported by 45 s.
//
// The Tailscale check that says WHY starts at the drop (one read-only status
// read, nothing on the steady state), so its answer is in by the time the
// grace ends. Tailscale is named only when the connection's own address is on
// the tailnet; otherwise the toast just says the PC was lost.

export const A2A_DROP_GRACE_MS = 12_000;
export const SHARE_DROP_GRACE_MS = 25_000;
/** How often the drops are swept, besides on every change of the state they come from. */
export const DROP_SWEEP_MS = 2_000;

interface Track {
  up: boolean;
  downSince: number | null;
  notified: boolean;
}

export type DropEdge = 'dropped' | 'healed' | 'recovered' | null;

/**
 * Per connection: when it went down, and whether that was reported. Pure and
 * clock-free, so a test drives it with any `now`.
 */
export class ConnectionDropWatch {
  private readonly tracks = new Map<string, Track>();

  /**
   * Feed one connection's current state. `up` null means no answer either way
   * (a changed identity, a refused credential): those have their own notices
   * and are not drops. A connection first seen down is never tracked, so
   * nothing already down when wmux started raises a notice.
   */
  observe(key: string, up: boolean | null, now: number): DropEdge {
    if (up === null) return null;
    const prev = this.tracks.get(key);
    if (!prev) {
      if (up) this.tracks.set(key, { up: true, downSince: null, notified: false });
      return null;
    }
    if (up) {
      if (prev.up) return null;
      this.tracks.set(key, { up: true, downSince: null, notified: false });
      return prev.notified ? 'recovered' : 'healed';
    }
    if (!prev.up) return null;
    this.tracks.set(key, { up: false, downSince: now, notified: false });
    return 'dropped';
  }

  /** Drops that have outlasted their grace and were not reported yet; marks them reported. */
  due(now: number, graceOf: (key: string) => number): string[] {
    const out: string[] = [];
    for (const [key, tr] of this.tracks) {
      if (tr.up || tr.notified || tr.downSince === null || now - tr.downSince < graceOf(key)) continue;
      tr.notified = true;
      out.push(key);
    }
    return out;
  }

  /** Down and already reported (a notice for it is due or showing). */
  isReported(key: string): boolean {
    const tr = this.tracks.get(key);
    return !!tr && !tr.up && tr.notified;
  }

  /** Stop tracking connections no longer in use; returns those whose notice is showing. */
  retain(keys: ReadonlySet<string>): string[] {
    const shown: string[] = [];
    for (const [key, tr] of this.tracks) {
      if (keys.has(key)) continue;
      if (tr.notified) shown.push(key);
      this.tracks.delete(key);
    }
    return shown;
  }
}

export interface ConnectionInUse {
  key: string;
  name: string;
  up: boolean | null;
  /** The tailnet host it connects through, when that is known; null otherwise. */
  tailnetHost: string | null;
  /** A workspace share's host id, whose address is looked up only after a drop. */
  shareHostId?: string;
}

export type DropSource = Pick<StoreState, 'a2aRemote' | 'remoteWorkspaces' | 'pcRailHostStatus' | 'pcRailHosts'>;

/** The connections a drop of which is worth a notice, with their state now. */
export function connectionsInUse(s: DropSource): ConnectionInUse[] {
  const out: ConnectionInUse[] = [];
  for (const h of s.a2aRemote.hosts) {
    if (!s.a2aRemote.links.some((l) => l.state === 'active' && l.remote.hostId === h.hostId)) continue;
    // The session moves the address that got through to the front.
    const address = s.a2aRemote.joined.find((j) => j.hostId === h.hostId)?.addresses[0] ?? '';
    out.push({
      key: `a2a:${h.hostId}`,
      name: h.name,
      up: h.state === 'connected' ? true : h.state === 'identity-changed' ? null : false,
      tailnetHost: address && isTailnetHost(address) ? address : null,
    });
  }
  const shareIds = [...new Set(s.remoteWorkspaces.map((w) => w.hostId))];
  for (const hostId of shareIds) {
    const status = s.pcRailHostStatus[hostId];
    out.push({
      key: `share:${hostId}`,
      name: s.pcRailHosts.find((h) => h.id === hostId)?.label
        ?? s.remoteWorkspaces.find((w) => w.hostId === hostId)?.hostLabel
        ?? hostId.slice(0, 6),
      up: status === 'reachable' || status === 'connected' ? true : status === 'unreachable' ? false : null,
      tailnetHost: null,
      shareHostId: hostId,
    });
  }
  return out;
}

/** The toast for a drop, from what the Tailscale check found (null: not over the tailnet, or no answer). */
export function dropToastText(name: string, check: TailscaleChecklist | null, tailnetHost: string | null): string {
  const failed = blockingFailure(check);
  if (!failed || !tailnetHost) return t('tailscale.drop.lost', { name });
  return t('tailscale.drop.lostBecause', { name, reason: describeTailnetFailure(failed, name) });
}

const graceOf = (key: string): number => (key.startsWith('share:') ? SHARE_DROP_GRACE_MS : A2A_DROP_GRACE_MS);

/** Mounted once in AppLayout: watches the A2A and workspace-share connections for real drops. */
export function useConnectionDropNotice(): void {
  useEffect(() => {
    const watch = new ConnectionDropWatch();
    const known = new Map<string, ConnectionInUse>();
    const checks = new Map<string, Promise<{ check: TailscaleChecklist | null; host: string | null }>>();
    const toasts = new Map<string, string>();

    const dismiss = (key: string): void => {
      const id = toasts.get(key);
      if (id) useStore.getState().dismissToast(id);
      toasts.delete(key);
    };

    const startCheck = (c: ConnectionInUse): void => {
      checks.set(c.key, (async () => {
        let host = c.tailnetHost;
        if (!host && c.shareHostId) {
          const hosts = await window.electronAPI?.remote?.hostsList?.().catch(() => null);
          const origin = hosts?.find((h) => h.id === c.shareHostId)?.origin ?? '';
          const h = hostOfUrl(origin);
          host = h && isTailnetHost(h) ? h : null;
        }
        return { check: host ? await readTailscale(host) : null, host };
      })());
    };

    const notify = async (key: string): Promise<void> => {
      const c = known.get(key);
      if (!c) return;
      const found = await (checks.get(key) ?? Promise.resolve({ check: null, host: null }));
      // Came back (or stopped being used) while the check ran: nothing to say.
      if (!watch.isReported(key) || toasts.has(key)) return;
      const failed = found.host ? blockingFailure(found.check) : null;
      const openApp = failed?.fix === 'open-app' || failed?.fix === 'sign-in';
      const id = useStore.getState().pushToast({
        level: 'warn',
        message: dropToastText(c.name, found.check, found.host),
        // A drop someone has to act on stays until it heals or is dismissed.
        persist: true,
        action: openApp
          ? { label: t('tailscale.fix.open'), onClick: () => { void window.electronAPI?.web?.tailscaleOpen?.('app'); } }
          : { label: t('tailscale.drop.show'), onClick: () => useStore.getState().setAppRoute('remote') },
      });
      toasts.set(key, id);
    };

    const evaluate = (): void => {
      const now = Date.now();
      const current = connectionsInUse(useStore.getState());
      const keys = new Set(current.map((c) => c.key));
      for (const key of watch.retain(keys)) dismiss(key);
      for (const key of [...known.keys()]) if (!keys.has(key)) { known.delete(key); checks.delete(key); }
      for (const c of current) {
        known.set(c.key, c);
        const edge = watch.observe(c.key, c.up, now);
        if (edge === 'dropped') startCheck(c);
        else if (edge === 'healed') checks.delete(c.key);
        else if (edge === 'recovered') { checks.delete(c.key); dismiss(c.key); }
      }
      for (const key of watch.due(now, graceOf)) void notify(key);
    };

    evaluate();
    let last: DropSource = useStore.getState();
    const off = useStore.subscribe((s) => {
      if (s.a2aRemote === last.a2aRemote && s.remoteWorkspaces === last.remoteWorkspaces
        && s.pcRailHostStatus === last.pcRailHostStatus && s.pcRailHosts === last.pcRailHosts) return;
      last = s;
      evaluate();
    });
    const sweep = window.setInterval(evaluate, DROP_SWEEP_MS);
    return () => {
      off();
      window.clearInterval(sweep);
    };
  }, []);
}
