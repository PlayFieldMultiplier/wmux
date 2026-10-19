// The guest bot routes (shared/guestBots.ts):
//
//   GET  /api/guest/v1/me
//   GET  /api/guest/v1/messages?sinceSeq=&limit=
//   POST /api/guest/v1/messages   {clientMessageId, text, mentions?}
//
// Reached only through the guest gate in WebTerminalServer.handle, which
// runs right after the Host guard and before every other branch, so a guest
// credential reaches nothing else and these routes accept nothing else. The
// order of the checks below is the contract:
//
//   1. a browser (`Origin` present) is refused: guests are server-to-server
//   2. the owner's switch is off → 403 guest-bots-disabled
//   3. the listener is plain HTTP on a non-loopback bind → 403 insecure-transport
//   4. the credential: malformed / unknown / revoked → 401
//   5. the server's grants: `--allow-transcript` to read or post, and
//      `--allow-input` as well to post → 403
//   6. the guest's rate budget → 429 with Retry-After
//   7. the route
//
// The conversation is the token's stored scope; nothing in a request names
// one. A read is the phone's `workspaces.roomCards` for that one thread,
// projected again to the fields a guest needs. A post is redacted here
// (shared/redactSecrets.ts) and handed to main as `workspaces.guestPost`,
// which writes an external `guest` card and wakes only bots of that
// conversation the post names, with a tainted `guest` wake.

import type http from 'node:http';
import { redactSecrets } from '../../shared/redactSecrets';
import {
  GUEST_LIMITS,
  GUEST_MESSAGE_ID_RE,
  GUEST_RATE_WINDOW_MS,
  GUEST_ROOM_POST_COMMAND,
  GUEST_ROUTES,
  parseGuestCredential,
  parseGuestPostResult,
  type GuestPostPayload,
  type GuestScope,
} from '../../shared/guestBots';
import { BOT_ID_RE } from '../../shared/bot';
import { PHONE_ROOM_CARDS_COMMAND, parsePhoneRoomCardsReply, type PhoneRoomCard } from '../../shared/phoneRooms';
import { DesktopPhoneError } from '../phone/DesktopPhoneBridge';
import type { RoomsDesktop } from './rooms';
import type { GuestAuthResult } from './GuestBotStore';

/** The part of GuestBotStore the routes use. */
export interface GuestBotResolver {
  enabled(): boolean;
  resolve(guestId: string, secret: string): Promise<GuestAuthResult>;
  touch?(guestId: string): void;
}

export interface GuestRouteResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export type GuestBodyRead = { ok: true; value: unknown } | { ok: false; status: number; error: string };

export interface GuestRouteContext {
  method: string;
  pathname: string;
  query: URLSearchParams;
  bearer: string | null;
  hasOrigin: boolean;
  /** Read the JSON body (bounded by GUEST_LIMITS.bodyMaxBytes). Called only
   *  once the caller is authenticated and allowed to post. */
  readBody: () => Promise<GuestBodyRead>;
  /** The server's grants, read on this request. */
  gates: { transcript: boolean; input: boolean; transportRefusal: string | null };
  guests: GuestBotResolver | undefined;
  desktop: RoomsDesktop | null;
  limiter: GuestRateLimiter;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): GuestRouteResponse =>
  ({ status, body: { ok: false, error, ...extra }, ...(headers ? { headers } : {}) });

/**
 * Per-guest sliding-window budgets (posts and reads apart), in memory. A
 * restart resets them; the post budget is also what bounds the wakes a
 * guest can cause.
 */
export class GuestRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Spend one unit; null when allowed, else the seconds to wait. */
  take(guestId: string, kind: 'post' | 'read'): number | null {
    const max = kind === 'post' ? GUEST_LIMITS.postsPerMinute : GUEST_LIMITS.readsPerMinute;
    const key = `${kind}:${guestId}`;
    const at = this.now();
    const kept = (this.hits.get(key) ?? []).filter((t) => at - t < GUEST_RATE_WINDOW_MS);
    if (kept.length >= max) {
      this.hits.set(key, kept);
      return Math.max(1, Math.ceil((GUEST_RATE_WINDOW_MS - (at - kept[0]!)) / 1000));
    }
    kept.push(at);
    this.hits.set(key, kept);
    return null;
  }

  /** Forget a guest (revoked). */
  forget(guestId: string): void {
    this.hits.delete(`post:${guestId}`);
    this.hits.delete(`read:${guestId}`);
  }
}

/** A query integer in [min, max], `undefined` when absent, null when malformed. */
function queryInt(value: string | null, min: number, max: number): number | undefined | null {
  if (value === null) return undefined;
  if (!/^[0-9]{1,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

async function ask(desktop: RoomsDesktop, command: string, payload: Record<string, unknown>): Promise<{ reply: unknown } | GuestRouteResponse> {
  try {
    return { reply: await desktop.request(command, payload) };
  } catch (error) {
    return error instanceof DesktopPhoneError && error.tag === 'desktop-timeout'
      ? refuse(504, 'desktop-timeout')
      : refuse(503, 'desktop-unavailable');
  }
}

/** A card as a guest sees it: who wrote it, what it says, nothing else (no
 *  refs, approval ids, photos or idempotency keys). */
export interface GuestCardView {
  id: string;
  seq: number;
  at: number;
  kind: string;
  from: { kind: 'owner' } | { kind: 'bot'; botId: string; name?: string } | { kind: 'guest' } | { kind: 'system' };
  title: string;
  body?: string;
  replyTo?: string;
}

export function guestCardView(c: PhoneRoomCard): GuestCardView {
  const from: GuestCardView['from'] = c.kind === 'guest' ? { kind: 'guest' }
    : c.actor.kind === 'human' ? { kind: 'owner' }
    : c.actor.kind === 'bot' ? { kind: 'bot', botId: c.actor.botId, ...(c.actor.name ? { name: c.actor.name } : {}) }
    : { kind: 'system' };
  return {
    id: c.id,
    seq: c.seq,
    at: c.at,
    kind: c.kind,
    from,
    title: c.title,
    ...(c.body ? { body: c.body } : {}),
    ...(c.replyTo ? { replyTo: c.replyTo } : {}),
  };
}

/** `POST` body: `{clientMessageId, text, mentions?}`, nothing else. */
function parsePostBody(value: unknown): { clientMessageId: string; text: string; mentions: string[] } | { detail: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { detail: 'body' };
  const b = value as Record<string, unknown>;
  for (const key of Object.keys(b)) if (key !== 'clientMessageId' && key !== 'text' && key !== 'mentions') return { detail: key };
  if (typeof b.clientMessageId !== 'string' || !GUEST_MESSAGE_ID_RE.test(b.clientMessageId)) return { detail: 'clientMessageId' };
  if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > GUEST_LIMITS.textMax) return { detail: 'text' };
  let mentions: string[] = [];
  if (b.mentions !== undefined) {
    if (!Array.isArray(b.mentions) || b.mentions.length > GUEST_LIMITS.mentionsMax ||
        !b.mentions.every((id) => typeof id === 'string' && BOT_ID_RE.test(id))) return { detail: 'mentions' };
    mentions = [...new Set(b.mentions as string[])];
  }
  return { clientMessageId: b.clientMessageId, text: b.text, mentions };
}

/** One guest request, gate to answer. Never throws. */
export async function guestRouteResponse(ctx: GuestRouteContext): Promise<GuestRouteResponse> {
  // 1. Server-to-server only: a page in a browser never holds a guest token.
  if (ctx.hasOrigin) return refuse(403, 'forbidden');
  // 2. The owner's switch.
  let on = false;
  try {
    on = ctx.guests?.enabled() === true;
  } catch {
    on = false;
  }
  if (!ctx.guests || !on) return refuse(403, 'guest-bots-disabled');
  // 3. A durable token never crosses a network in clear.
  if (ctx.gates.transportRefusal) return refuse(403, 'insecure-transport');
  // 4. The credential.
  const cred = parseGuestCredential(ctx.bearer);
  if (!cred) return refuse(401, 'unauthorized');
  let who: GuestAuthResult;
  try {
    who = await ctx.guests.resolve(cred.guestId, cred.secret);
  } catch (err) {
    ctx.log('warn', `[web] guest auth failed: ${err instanceof Error ? err.message : String(err)}`);
    return refuse(401, 'unauthorized');
  }
  if (!who.ok) return refuse(401, 'unauthorized', { reason: who.reason });
  const route = ctx.pathname === GUEST_ROUTES.me ? 'me' : ctx.pathname === GUEST_ROUTES.messages ? 'messages' : null;
  if (!route) return refuse(404, 'not-found');
  const posting = route === 'messages' && ctx.method === 'POST';
  if (!posting && ctx.method !== 'GET') return refuse(405, 'method-not-allowed');
  // 5. The server's grants, as for the phone's room routes.
  if (!ctx.gates.transcript) return refuse(403, 'transcript-disabled');
  if (posting && !ctx.gates.input) return refuse(403, 'input-disabled');
  // 6. The guest's budget.
  const wait = ctx.limiter.take(who.guestId, posting ? 'post' : 'read');
  if (wait !== null) return refuse(429, 'rate-limited', { retryAfterSeconds: wait }, { 'Retry-After': String(wait) });
  try {
    ctx.guests.touch?.(who.guestId);
  } catch {
    /* bookkeeping */
  }
  const scope = who.scope;
  if (route === 'me') {
    return {
      status: 200,
      body: {
        ok: true,
        guest: { guestId: who.guestId, name: who.name },
        conversation: { workspaceId: scope.workspaceId, threadId: scope.threadId },
        canPost: ctx.gates.input,
        limits: {
          textMax: GUEST_LIMITS.textMax, mentionsMax: GUEST_LIMITS.mentionsMax, pageMax: GUEST_LIMITS.pageMax,
          postsPerMinute: GUEST_LIMITS.postsPerMinute, readsPerMinute: GUEST_LIMITS.readsPerMinute,
        },
      },
    };
  }
  return posting ? post(ctx, who, scope) : read(ctx, scope);
}

async function read(ctx: GuestRouteContext, scope: GuestScope): Promise<GuestRouteResponse> {
  const sinceSeq = queryInt(ctx.query.get('sinceSeq'), 0, Number.MAX_SAFE_INTEGER);
  if (sinceSeq === null) return refuse(400, 'invalid-request', { detail: 'sinceSeq' });
  const limit = queryInt(ctx.query.get('limit'), 1, GUEST_LIMITS.pageMax);
  if (limit === null) return refuse(400, 'invalid-request', { detail: 'limit' });
  const desktop = ctx.desktop;
  if (!desktop) return refuse(503, 'desktop-unavailable');
  if (!desktop.supports(PHONE_ROOM_CARDS_COMMAND)) return refuse(503, 'rooms-unavailable');
  const answered = await ask(desktop, PHONE_ROOM_CARDS_COMMAND, {
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    limit: limit ?? GUEST_LIMITS.pageMax,
  });
  if (!('reply' in answered)) return answered;
  const r = answered.reply !== null && typeof answered.reply === 'object' ? answered.reply as Record<string, unknown> : {};
  if (r.unavailable === true) return refuse(503, 'rooms-unavailable');
  if (r.notFound === true) return refuse(404, 'conversation-not-found');
  if (r.invalid === true) return refuse(400, 'invalid-request');
  const page = parsePhoneRoomCardsReply(answered.reply, scope.workspaceId, scope.threadId);
  if (!page) return refuse(502, 'desktop-bad-reply');
  return {
    status: 200,
    body: { ok: true, cards: page.cards.map(guestCardView), nextSinceSeq: page.nextSinceSeq, hasMore: page.hasMore },
  };
}

async function post(ctx: GuestRouteContext, who: Extract<GuestAuthResult, { ok: true }>, scope: GuestScope): Promise<GuestRouteResponse> {
  const body = await ctx.readBody();
  if (!body.ok) return refuse(body.status, body.error);
  const parsed = parsePostBody(body.value);
  if ('detail' in parsed) return refuse(400, 'invalid-request', { detail: parsed.detail });
  const desktop = ctx.desktop;
  if (!desktop) return refuse(503, 'desktop-unavailable');
  if (!desktop.supports(GUEST_ROOM_POST_COMMAND)) return refuse(503, 'guest-posts-unavailable');
  // Key patterns go before anything leaves the daemon; main redacts the
  // owner's stored secret values again when it writes the card.
  const text = redactSecrets(parsed.text);
  const payload: GuestPostPayload = {
    guestId: who.guestId,
    guestName: who.name,
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    clientMessageId: parsed.clientMessageId,
    text,
    mentions: parsed.mentions,
  };
  const answered = await ask(desktop, GUEST_ROOM_POST_COMMAND, { ...payload });
  if (!('reply' in answered)) {
    // Sent with no answer: main may have written the card. The same
    // clientMessageId again is safe (main returns the first card).
    return answered.status === 504
      ? { status: 202, body: { ok: true, state: 'uncertain', clientMessageId: parsed.clientMessageId } }
      : answered;
  }
  const result = parseGuestPostResult(answered.reply);
  if (!result) return refuse(502, 'desktop-bad-reply');
  if (!result.ok) {
    switch (result.code) {
      case 'factory_off': return refuse(409, 'bots-off');
      case 'scope_gone': return refuse(404, 'conversation-not-found');
      case 'mention_refused': return refuse(400, 'invalid-request', { detail: 'mentions' });
      case 'busy': return refuse(503, 'busy', {}, { 'Retry-After': '5' });
      case 'id_reused': return refuse(409, 'message-id-reused');
      default: return refuse(400, 'invalid-request');
    }
  }
  ctx.log('info', `[web] guest ${who.guestId} posted card ${result.cardId}`);
  return {
    status: result.duplicate ? 200 : 201,
    body: {
      ok: true,
      card: { id: result.cardId, seq: result.seq },
      ...(result.duplicate ? { replayed: true } : {}),
      woke: result.woke,
      redacted: text !== parsed.text,
    },
  };
}

/** Read a bounded JSON body from a request. */
export function readGuestBody(req: http.IncomingMessage, maxBytes: number = GUEST_LIMITS.bodyMaxBytes): Promise<GuestBodyRead> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      resolve({ ok: false, status: 413, error: 'payload-too-large' });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (r: GuestBodyRead) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        finish({ ok: false, status: 413, error: 'payload-too-large' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
      } catch {
        finish({ ok: false, status: 400, error: 'invalid-json' });
      }
    });
    req.on('error', () => finish({ ok: false, status: 400, error: 'invalid-request' }));
  });
}
