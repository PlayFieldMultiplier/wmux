// === "Another PC reached this one" ===
//
// The host cannot prove from itself that another machine can connect: a
// connect to its own LAN address takes the loopback path, which the firewall
// does not filter. What it can see is a connection that really arrived from
// elsewhere. A listener counts those (A2A: a finished TLS handshake; the
// exposed web server: an accepted socket) so the UI can say "Another PC
// reached this one at 14:02" after a Fix. Loopback and this machine's own
// addresses never count. The counter is per listener start.
//
// Imports node builtins only.

import os from 'node:os';

function ownAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) out.add(a.address.toLowerCase());
  return out;
}

/** `::ffff:10.0.0.5` → `10.0.0.5`; anything else lowercased as is. */
export function normalizeRemote(addr: string): string {
  const a = addr.toLowerCase();
  return a.startsWith('::ffff:') && a.includes('.') ? a.slice(7) : a;
}

export function isLoopback(addr: string): boolean {
  return addr === '::1' || addr.startsWith('127.');
}

/** A bind address only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || isLoopback(normalizeRemote(h.replace(/^\[|\]$/g, '')));
}

export class InboundCounter {
  private seenAt: number | null = null;
  private count = 0;

  /**
   * `own` lists this machine's addresses. The default reads the interfaces
   * again on every connection, so an address that came up after the listener
   * started is still recognized as this machine.
   */
  constructor(
    private readonly own: () => Set<string> = ownAddresses,
    private readonly now: () => number = Date.now,
  ) {}

  note(remoteAddress: string | undefined | null): void {
    if (!remoteAddress) return;
    const ip = normalizeRemote(remoteAddress);
    if (isLoopback(ip) || this.own().has(ip)) return;
    this.count += 1;
    this.seenAt = this.now();
  }

  snapshot(): { inboundSeenAt: number | null; inboundCount: number } {
    return { inboundSeenAt: this.seenAt, inboundCount: this.count };
  }
}
