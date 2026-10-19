// The owner's guest bots (shared/guestBots.ts), through the preload bridge
// `electronAPI.factory.guestBots` (main-window IPC). A token arrives once,
// from `create`; nothing here reads one back.

import type {
  GuestBotCreateResult,
  GuestBotListResult,
  GuestBotSimpleResult,
  GuestScope,
} from '../../../shared/guestBots';

export interface GuestBotPort {
  readonly available: boolean;
  list(): Promise<GuestBotListResult>;
  create(req: { name: string; scope: GuestScope }): Promise<GuestBotCreateResult>;
  revoke(guestId: string): Promise<GuestBotSimpleResult>;
  setEnabled(enabled: boolean): Promise<GuestBotSimpleResult>;
}

type Bridge = Partial<GuestBotPort>;

const UNAVAILABLE = { ok: false as const, code: 'unavailable' as const };

function bridgePort(): GuestBotPort {
  const api = (globalThis as { electronAPI?: { factory?: { guestBots?: Bridge } } }).electronAPI;
  const b = api?.factory?.guestBots;
  return {
    available: !!b?.list && !!b.create && !!b.revoke,
    list: () => b?.list?.() ?? Promise.resolve(UNAVAILABLE),
    create: (req) => b?.create?.(req) ?? Promise.resolve(UNAVAILABLE),
    revoke: (id) => b?.revoke?.(id) ?? Promise.resolve(UNAVAILABLE),
    setEnabled: (on) => b?.setEnabled?.(on) ?? Promise.resolve(UNAVAILABLE),
  };
}

let port: GuestBotPort | null = null;

export function getGuestBotPort(): GuestBotPort {
  port ??= bridgePort();
  return port;
}

/** Tests, or a host that wires it another way. */
export function setGuestBotPort(next: GuestBotPort | null): void {
  port = next;
}

// ── Revocations in flight ───────────────────────────────────────────────────
//
// A revoke outlives the dialog that asked for it: the owner may close Guest
// bots before the daemon answers. The pending set and the outcome live here,
// not in the dialog. An open dialog shows both (Revoking…, its error line);
// a failure no open dialog took is reported through `onUnseenFailure`, so the
// owner always learns that a token still works.

export type GuestRevokeListener = (ev: { guestId: string; result: GuestBotSimpleResult }) => boolean | void;

export class GuestRevocations {
  private readonly inFlight = new Set<string>();
  private readonly listeners = new Set<GuestRevokeListener>();
  private readonly changes = new Set<() => void>();

  pending(): ReadonlySet<string> {
    return new Set(this.inFlight);
  }

  isPending(guestId: string): boolean {
    return this.inFlight.has(guestId);
  }

  /** Told of each outcome; returning true means it was shown to the owner. */
  onOutcome(fn: GuestRevokeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onChange(fn: () => void): () => void {
    this.changes.add(fn);
    return () => this.changes.delete(fn);
  }

  /** Revoke once per guest at a time; a second ask while one is in flight
   *  returns null and sends nothing. */
  async revoke(port: GuestBotPort, guestId: string, onUnseenFailure: (result: Extract<GuestBotSimpleResult, { ok: false }>) => void): Promise<GuestBotSimpleResult | null> {
    if (this.inFlight.has(guestId)) return null;
    this.inFlight.add(guestId);
    this.changed();
    let result: GuestBotSimpleResult;
    try {
      result = await port.revoke(guestId);
    } catch {
      result = { ok: false, code: 'unavailable' };
    }
    this.inFlight.delete(guestId);
    this.changed();
    let seen = false;
    for (const fn of [...this.listeners]) {
      try {
        if (fn({ guestId, result }) === true) seen = true;
      } catch {
        /* a listener's failure is not the revoke's */
      }
    }
    if (!result.ok && !seen) onUnseenFailure(result);
    return result;
  }

  private changed(): void {
    for (const fn of [...this.changes]) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }
}

let revocations: GuestRevocations | null = null;

export function getGuestRevocations(): GuestRevocations {
  revocations ??= new GuestRevocations();
  return revocations;
}

/** Tests. */
export function setGuestRevocations(next: GuestRevocations | null): void {
  revocations = next;
}
