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
