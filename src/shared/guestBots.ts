// === Guest bots — an outside agent in one Bots conversation ===
//
// The owner adds a guest bot on the Bots page: a name, the one conversation
// it may join (a bot's 1:1, a group chat, or a room's General) and a token,
// shown once. An HTTP-capable agent outside wmux (a cloud assistant, a script)
// then reads that conversation and posts to it through the daemon web
// server:
//
//   GET  /api/guest/v1/me                       who the token is, its scope
//   GET  /api/guest/v1/messages?sinceSeq=&limit= the conversation's cards
//   POST /api/guest/v1/messages                 {clientMessageId, text, mentions?}
//
// Security invariants this file pins:
//   - A guest credential is its own credential type (`wmuxguest~<id>~<secret>`):
//     never a web device, never an A2A peer, never the operator. It
//     authenticates `/api/guest/*` and nothing else, and `/api/guest/*`
//     accepts nothing else. It contains no '.', so the device-credential
//     parser fails closed on it, and its prefix is not the peer prefix.
//   - The conversation is NEVER read off the wire: every route acts on the
//     scope stored with the token.
//   - A guest's card is always marked external (kind `guest`, actor system,
//     the guest's name in the title) and a bot it wakes runs a `guest` wake,
//     which is tainted: the merge lane and remembered rules never merge what
//     that wake starts, and its approval cards say "started from outside text".
//   - A guest has no engine, no merge lane, no approvals, no workers and no
//     connectors: these routes are the whole of what it can do.
//   - Off by default: the owner's switch, the server's transcript grant (and
//     input grant to post), and an encrypted or loopback-only listener.
//
// Pure module: no node:* imports (the renderer imports these types).

import { GENERAL_THREAD, dmThreadBot, groupThreadGroup, parseThreadId, type ThreadId } from './room';
import { isPhoneRoomWorkspaceId } from './phoneRooms';

export const GUEST_RECORD_V = 1;

// ─── Routes ─────────────────────────────────────────────────────────────────

export const GUEST_ROUTE_PREFIX = '/api/guest/';
export const GUEST_ROUTES = Object.freeze({
  me: '/api/guest/v1/me',
  messages: '/api/guest/v1/messages',
} as const);

/** True iff `pathname` is a guest route (prefix match on the raw path). */
export function isGuestRoute(pathname: string): boolean {
  return pathname.startsWith(GUEST_ROUTE_PREFIX);
}

/** The desktop bridge command a guest post rides (main answers it). The read
 *  side reuses the phone's `workspaces.roomCards` with the stored scope. */
export const GUEST_ROOM_POST_COMMAND = 'workspaces.guestPost';

// ─── Limits ─────────────────────────────────────────────────────────────────

export const GUEST_LIMITS = Object.freeze({
  /** Live (unrevoked) guests at once. */
  liveMax: 8,
  /** Request body of a post. */
  bodyMaxBytes: 16 * 1024,
  /** Characters of a post's text. */
  textMax: 4000,
  /** Bots one post may wake (each must belong to the conversation). */
  mentionsMax: 4,
  /** Posts per guest per minute. */
  postsPerMinute: 10,
  /** Reads (`me`, `messages`) per guest per minute. */
  readsPerMinute: 60,
  /** Cards one read returns at most. */
  pageMax: 50,
  /** Wrong secrets per guest id before its window refuses without deriving. */
  failuresPerWindow: 5,
  failureWindowMs: 1000,
} as const);

export const GUEST_RATE_WINDOW_MS = 60_000;

/** A post's idempotency key: 1–64 of [A-Za-z0-9_-]. */
export const GUEST_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ─── Credential ─────────────────────────────────────────────────────────────

export const GUEST_CREDENTIAL_PREFIX = 'wmuxguest';
export const GUEST_CREDENTIAL_SEP = '~';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/;

export interface GuestCredential {
  guestId: string;
  secret: string;
}

export function isGuestId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function formatGuestCredential(c: GuestCredential): string {
  return [GUEST_CREDENTIAL_PREFIX, c.guestId, c.secret].join(GUEST_CREDENTIAL_SEP);
}

/** Parse a Bearer value; null unless it is exactly a well-formed guest credential. */
export function parseGuestCredential(bearer: unknown): GuestCredential | null {
  if (typeof bearer !== 'string') return null;
  const parts = bearer.split(GUEST_CREDENTIAL_SEP);
  if (parts.length !== 3 || parts[0] !== GUEST_CREDENTIAL_PREFIX) return null;
  const [, guestId, secret] = parts;
  if (!UUID_RE.test(guestId) || !SECRET_RE.test(secret)) return null;
  return { guestId, secret };
}

/** Whether a Bearer value is meant as a guest credential (well-formed or not). */
export function looksLikeGuestCredential(bearer: unknown): boolean {
  return typeof bearer === 'string' && bearer.startsWith(GUEST_CREDENTIAL_PREFIX + GUEST_CREDENTIAL_SEP);
}

// ─── Scope ──────────────────────────────────────────────────────────────────

/** The one conversation a guest may read and post to. */
export interface GuestScope {
  workspaceId: string;
  threadId: ThreadId;
}

/** A conversation thread of the Bots page: a bot's 1:1, a group chat's
 *  thread, or General (a group made from the room). Nothing else (a PR's or
 *  a task's thread is not a conversation a guest joins). */
export function parseGuestScope(raw: unknown): GuestScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isPhoneRoomWorkspaceId(r.workspaceId)) return null;
  const threadId = parseThreadId(r.threadId);
  if (!threadId || !(threadId === GENERAL_THREAD || dmThreadBot(threadId) || groupThreadGroup(threadId))) return null;
  return { workspaceId: r.workspaceId, threadId };
}

// ─── Records and management (owner side) ────────────────────────────────────

/** A guest as the owner sees it. Never carries secret material. */
export interface GuestBotView {
  v: 1;
  guestId: string;
  name: string;
  scope: GuestScope;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export const GUEST_NAME_MAX = 64;

/** A display name: control characters dropped, whitespace collapsed, bounded. */
export function sanitizeGuestName(name: unknown): string {
  const cleaned = (typeof name === 'string' ? name : '')
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > GUEST_NAME_MAX ? cleaned.slice(0, GUEST_NAME_MAX) : cleaned;
}

/** What the owner's surfaces know about the gates, so the page can say why a
 *  guest cannot connect yet. */
export interface GuestBotGates {
  /** The owner's switch for the whole feature (off by default). */
  enabled: boolean;
  /** The web server is running. */
  serverRunning: boolean;
  /** `--allow-transcript`: needed to read. */
  transcript: boolean;
  /** `--allow-input`: needed to post. */
  input: boolean;
  /** The listener is TLS or loopback-only (a tunnel such as `tailscale
   *  serve` in front): a guest token never crosses a network in clear. */
  secureTransport: boolean;
}

export type GuestBotListResult =
  | { ok: true; guests: GuestBotView[]; gates: GuestBotGates }
  | { ok: false; code: GuestBotErrorCode };

export type GuestBotCreateResult =
  | { ok: true; guest: GuestBotView; token: string }
  | { ok: false; code: GuestBotErrorCode };

export type GuestBotSimpleResult = { ok: true } | { ok: false; code: GuestBotErrorCode };

export type GuestBotErrorCode = 'unavailable' | 'invalid' | 'too-many' | 'not-found' | 'persist-failed';

export const GUEST_BOT_IPC = Object.freeze({
  list: 'factory:guestBots:list',
  create: 'factory:guestBots:create',
  revoke: 'factory:guestBots:revoke',
  setEnabled: 'factory:guestBots:setEnabled',
} as const);

export const GUEST_BOT_RPC = Object.freeze({
  list: 'daemon.web.guestBots.list',
  create: 'daemon.web.guestBots.create',
  revoke: 'daemon.web.guestBots.revoke',
  setEnabled: 'daemon.web.guestBots.setEnabled',
} as const);

// ─── The post, daemon → main ────────────────────────────────────────────────

/** What the daemon asks main to post. The scope is the token's, never the wire's. */
export interface GuestPostPayload {
  guestId: string;
  guestName: string;
  workspaceId: string;
  threadId: string;
  clientMessageId: string;
  /** Already redacted by the daemon; main redacts stored secrets again. */
  text: string;
  mentions: string[];
}

export type GuestPostRefusal = 'factory_off' | 'scope_gone' | 'mention_refused' | 'busy' | 'id_reused' | 'invalid';

export type GuestPostResult =
  | { ok: true; cardId: string; seq: number; duplicate?: true; woke: string[] }
  | { ok: false; code: GuestPostRefusal };

/** Parse main's answer; null for any other shape. */
export function parseGuestPostResult(raw: unknown): GuestPostResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.ok === true) {
    if (typeof r.cardId !== 'string' || r.cardId.length === 0 || r.cardId.length > 64) return null;
    if (typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq) || r.seq < 1) return null;
    if (!Array.isArray(r.woke) || !r.woke.every((id) => typeof id === 'string')) return null;
    return { ok: true, cardId: r.cardId, seq: r.seq, ...(r.duplicate === true ? { duplicate: true as const } : {}), woke: [...(r.woke as string[])] };
  }
  if (r.ok === false) {
    const codes: readonly string[] = ['factory_off', 'scope_gone', 'mention_refused', 'busy', 'id_reused', 'invalid'];
    return typeof r.code === 'string' && codes.includes(r.code) ? { ok: false, code: r.code as GuestPostRefusal } : null;
  }
  return null;
}

/** The title every guest card carries, so any reader (the phone, a bot's
 *  prompt, an older desktop) sees it is external even without the `guest`
 *  field. */
export function guestCardTitle(name: string): string {
  return `External guest: ${sanitizeGuestName(name) || 'Guest'}`;
}
