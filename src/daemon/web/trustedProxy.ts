// === Trusted proxy sign-in ===
//
// A self-hosted wmux behind a signing-in reverse proxy (Traefik +
// oauth2-proxy) already knows who the browser is: the proxy forwards the
// signed-in email in a header. This decides when a request that carries no
// wmux credential is the operator because the proxy says so.
//
// A header is a claim anyone can type, so the claim counts only on a
// connection whose peer IS one of the named proxies, and never from this
// machine itself (any local process could connect and type it). A request
// that presents a wmux credential is judged by that credential alone.
//
// Pure: the caller hands over the request facts and the own-address check.

import net from 'node:net';
import { isLoopback } from '../net/inboundSeen';

/** An IP literal in one spelling: IPv4-mapped unwrapped, IPv6 lowercased and compressed. */
export type NormalizedIp = string & { readonly __brand: 'NormalizedIp' };
/** A lowercased HTTP header name. */
export type LowerHeaderName = string & { readonly __brand: 'LowerHeaderName' };

export interface TrustedProxyConfig {
  header: LowerHeaderName;
  /** Trimmed and lowercased. */
  user: string;
  from: ReadonlySet<NormalizedIp>;
  /** Lets a loopback peer stand in for the proxy. Tests only; no CLI or RPC path sets it. */
  localPeerForTests: boolean;
}

export const TRUSTED_PROXY_REFUSALS = [
  'peer-is-local',
  'identity-missing',
  'identity-duplicated',
  'identity-mismatch',
  'cross-site',
  'origin-missing',
  'origin-not-allowed',
] as const;
export type TrustedProxyRefusal = (typeof TRUSTED_PROXY_REFUSALS)[number];

export type TrustedProxyDecision =
  | { kind: 'accepted'; user: string }
  | { kind: 'not-applicable'; why: 'off' | 'credential-presented' | 'untrusted-peer' }
  | { kind: 'refused'; reason: TrustedProxyRefusal };

export interface TrustedProxyRequest {
  remoteAddress: string | undefined;
  /** Node's `req.rawHeaders`: every copy, as sent. `req.headers` drops or joins duplicates. */
  rawHeaders: readonly string[];
  method: string | undefined;
  hostHeader: string | undefined;
  /** Whether the URL carries a `token` or `ticket` parameter at all, even empty. */
  queryCredential: boolean;
}

const FLAGS = { header: '--trust-proxy-header', user: '--trust-proxy-user', from: '--trust-proxy-from' } as const;

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
/** Headers a proxy or browser owns, or that carry another credential. */
const RESERVED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'origin',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);
const EMAIL = /^[^\s@,]+@[^\s@,]+$/;

/** `raw` in its one comparable spelling, or null when it is not a plain IP literal. */
export function normalizeIp(raw: string): NormalizedIp | null {
  const ip = raw.trim();
  if (net.isIPv4(ip)) return ip as NormalizedIp;
  if (ip.includes('%') || !net.isIPv6(ip)) return null;
  const compressed = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(compressed);
  if (!mapped) return compressed as NormalizedIp;
  const hi = parseInt(mapped[1], 16);
  const lo = parseInt(mapped[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}` as NormalizedIp;
}

/** Every value sent under `name` (case-insensitive), in order. */
export function rawHeaderValues(rawHeaders: readonly string[], name: string): string[] {
  const want = name.toLowerCase();
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === want) out.push(rawHeaders[i + 1]);
  }
  return out;
}

/**
 * Parse the operator's trusted proxy settings. Undefined or null is "off";
 * anything else is all three settings or an error that says what to fix.
 */
export function parseTrustedProxyConfig(
  raw: unknown,
  opts: { localPeerForTests?: true } = {},
): TrustedProxyConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${FLAGS.header}, ${FLAGS.user} and ${FLAGS.from} must be given together`);
  }
  const r = raw as Record<string, unknown>;
  const missing = (Object.keys(FLAGS) as Array<keyof typeof FLAGS>).filter((k) => r[k] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${FLAGS.header}, ${FLAGS.user} and ${FLAGS.from} must be given together (missing: ${missing.map((k) => FLAGS[k]).join(', ')})`,
    );
  }
  const localPeerForTests = opts.localPeerForTests === true;
  return {
    header: parseHeaderName(r.header),
    user: parseUser(r.user),
    from: parseFrom(r.from, localPeerForTests),
    localPeerForTests,
  };
}

function parseHeaderName(raw: unknown): LowerHeaderName {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!HEADER_TOKEN.test(name)) {
    throw new Error(`${FLAGS.header} must be an HTTP header name, such as X-Auth-Request-Email`);
  }
  if (RESERVED_HEADERS.has(name) || name.startsWith('sec-')) {
    throw new Error(
      `${FLAGS.header} cannot be ${name}: that header carries a credential or belongs to the browser or the connection. Use the header your proxy sets for the signed-in user, such as X-Auth-Request-Email`,
    );
  }
  return name as LowerHeaderName;
}

function parseUser(raw: unknown): string {
  const user = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!EMAIL.test(user)) {
    throw new Error(`${FLAGS.user} must be the signed-in email your proxy forwards, such as you@example.com`);
  }
  return user;
}

function parseFrom(raw: unknown, localPeerForTests: boolean): ReadonlySet<NormalizedIp> {
  if (!Array.isArray(raw) || raw.some((e) => typeof e !== 'string')) {
    throw new Error(`${FLAGS.from} must list the proxy's IP addresses, separated by commas`);
  }
  const entries = (raw as string[]).map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`${FLAGS.from} must name at least one proxy IP address`);
  }
  const out = new Set<NormalizedIp>();
  for (const entry of entries) {
    const slash = entry.indexOf('/');
    const addr = slash === -1 ? entry : entry.slice(0, slash);
    if (addr.includes('%')) {
      throw new Error(`${FLAGS.from}: ${entry} has a zone id; name the proxy by an address without one`);
    }
    const ip = normalizeIp(addr);
    if (!ip) throw new Error(`${FLAGS.from}: ${entry} is not an IP address`);
    if (slash !== -1 && entry.slice(slash + 1) !== (net.isIPv4(addr.trim()) ? '32' : '128')) {
      throw new Error(`${FLAGS.from}: ${entry} is a range; list each proxy address on its own`);
    }
    if (ip === '0.0.0.0' || ip === '::') {
      throw new Error(`${FLAGS.from}: ${entry} is the unspecified address, not a proxy`);
    }
    if (isLoopback(ip) && !localPeerForTests) {
      throw new Error(
        `${FLAGS.from}: ${entry} is this machine; any local program could claim to be the proxy. Name the proxy's own address`,
      );
    }
    out.add(ip);
  }
  return out;
}

/**
 * Whether this request is the operator by the proxy's word. Order matters:
 * a presented credential and an unknown peer are not proxy requests at all
 * (not-applicable); a proxy request with a bad identity or a cross-site
 * shape is refused.
 */
export function decideTrustedProxy(
  config: TrustedProxyConfig | undefined,
  req: TrustedProxyRequest,
  deps: { isOwnAddress: (ip: NormalizedIp) => boolean },
): TrustedProxyDecision {
  if (!config) return { kind: 'not-applicable', why: 'off' };
  if (req.queryCredential || rawHeaderValues(req.rawHeaders, 'authorization').length > 0) {
    return { kind: 'not-applicable', why: 'credential-presented' };
  }
  const peer = req.remoteAddress === undefined ? null : normalizeIp(req.remoteAddress);
  if (!peer || !config.from.has(peer)) return { kind: 'not-applicable', why: 'untrusted-peer' };
  const refused = (reason: TrustedProxyRefusal): TrustedProxyDecision => ({ kind: 'refused', reason });
  if (!config.localPeerForTests && (isLoopback(peer) || deps.isOwnAddress(peer))) return refused('peer-is-local');

  const identity = rawHeaderValues(req.rawHeaders, config.header);
  if (identity.length === 0) return refused('identity-missing');
  if (identity.length > 1) return refused('identity-duplicated');
  if (identity[0].trim().toLowerCase() !== config.user) return refused('identity-mismatch');

  const site = rawHeaderValues(req.rawHeaders, 'sec-fetch-site');
  if (site.length > 1 || (site.length === 1 && site[0] !== 'same-origin' && site[0] !== 'none')) {
    return refused('cross-site');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = rawHeaderValues(req.rawHeaders, 'origin');
    if (origin.length === 0) return refused('origin-missing');
    if (origin.length > 1 || !originMatchesHost(origin[0], req.hostHeader)) return refused('origin-not-allowed');
    // A write must prove it came from this page. Origin alone cannot: a
    // browser without Fetch Metadata may send a cross-scheme form post whose
    // Origin names this host over http. Every browser that runs the app sends it.
    if (site.length !== 1 || site[0] !== 'same-origin') return refused('cross-site');
  }
  return { kind: 'accepted', user: config.user };
}

/** `null`, an unparseable origin, and a non-HTTP scheme all fail to parse or to match. */
function originMatchesHost(origin: string, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.host === hostHeader.toLowerCase();
}
