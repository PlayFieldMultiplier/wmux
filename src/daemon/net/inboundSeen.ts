// === "Another PC reached this one" ===
//
// The host cannot prove from itself that another machine can connect: a
// connect to its own LAN address takes the loopback path, which the firewall
// does not filter. What it can see is a connection that really arrived from
// elsewhere. A listener counts those (A2A: a finished TLS handshake; the
// exposed web server: an authenticated request, so a scanner's connect does
// not count) so the UI can say "Another PC
// reached this one at 14:02" after a Fix. Loopback and this machine's own
// addresses never count. The counter is per listener start.
//
// Imports node builtins only.

import os from 'node:os';

function readOwnAddresses(): Set<string> {
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

/** How long a read of this machine's addresses is trusted before an unknown address reads them again. */
export const OWN_ADDRESSES_TTL_MS = 5_000;

/** Whether an address belongs to this machine, from a cached read of its interfaces. */
export class OwnAddresses {
  private mine: Set<string> | null = null;
  private mineAt = 0;

  /**
   * `read` lists this machine's addresses (GetAdaptersAddresses, on the event
   * loop). It is read once, then again only for an address the last read did
   * not hold once that read is older than OWN_ADDRESSES_TTL_MS: an address
   * that came up after the listener started is still recognized as this
   * machine, and a scanner sweeping an exposed port costs one read per TTL,
   * not one per connection.
   */
  constructor(
    private readonly read: () => Set<string> = readOwnAddresses,
    private readonly now: () => number = Date.now,
  ) {}

  has(ip: string): boolean {
    if (!this.mine || (!this.mine.has(ip) && this.now() - this.mineAt >= OWN_ADDRESSES_TTL_MS)) {
      this.mine = this.read();
      this.mineAt = this.now();
    }
    return this.mine.has(ip);
  }
}

export class InboundCounter {
  private seenAt: number | null = null;
  private count = 0;
  private readonly own: OwnAddresses;

  constructor(
    own: () => Set<string> = readOwnAddresses,
    private readonly now: () => number = Date.now,
  ) {
    this.own = new OwnAddresses(own, now);
  }

  note(remoteAddress: string | undefined | null): void {
    if (!remoteAddress) return;
    const ip = normalizeRemote(remoteAddress);
    if (isLoopback(ip) || this.own.has(ip)) return;
    this.count += 1;
    this.seenAt = this.now();
  }

  snapshot(): { inboundSeenAt: number | null; inboundCount: number } {
    return { inboundSeenAt: this.seenAt, inboundCount: this.count };
  }
}
