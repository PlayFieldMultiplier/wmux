import { describe, expect, it, vi } from 'vitest';
import { GUEST_LIMITS, GUEST_ROOM_POST_COMMAND, GUEST_ROUTES, formatGuestCredential } from '../../../shared/guestBots';
import { PHONE_ROOM_CARDS_COMMAND } from '../../../shared/phoneRooms';
import { DesktopPhoneError } from '../../phone/DesktopPhoneBridge';
import { GuestRateLimiter, guestCardView, guestRouteResponse, type GuestBotResolver, type GuestRouteContext } from '../guestBotRoutes';

const GUEST_ID = '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const SECRET = 'A'.repeat(43);
const TOKEN = formatGuestCredential({ guestId: GUEST_ID, secret: SECRET });
const SCOPE = { workspaceId: 'ws-1', threadId: 'dm:bot-0000aaaa' as const };

function resolver(over: Partial<GuestBotResolver> = {}): GuestBotResolver & { resolve: ReturnType<typeof vi.fn> } {
  return {
    enabled: () => true,
    resolve: vi.fn(async (id: string, secret: string) => (id === GUEST_ID && secret === SECRET
      ? { ok: true as const, guestId: GUEST_ID, name: 'Grok', scope: SCOPE, createdAt: 0, joinSeq: 0 }
      : { ok: false as const, reason: 'unknown' as const })),
    touch: vi.fn(),
    ...over,
  } as GuestBotResolver & { resolve: ReturnType<typeof vi.fn> };
}

function desktop(reply: (command: string, payload: Record<string, unknown>) => unknown, commands = [PHONE_ROOM_CARDS_COMMAND, GUEST_ROOM_POST_COMMAND]) {
  return {
    supports: (c: string) => commands.includes(c),
    request: vi.fn(async (c: string, p: Record<string, unknown>) => reply(c, p)),
  };
}

const cardsReply = (p: Record<string, unknown>) => ({
  workspaceId: p.workspaceId,
  threadId: p.threadId,
  cards: [
    { id: 'c1', seq: 1, threadId: p.threadId, kind: 'human', at: 1, actor: { kind: 'human' }, title: 'hi', body: 'hello there' },
    { id: 'c2', seq: 2, threadId: p.threadId, kind: 'approval', at: 2, actor: { kind: 'bot', botId: 'bot-0000aaaa', name: 'Dev' }, title: 'Merge?', refs: { approvalId: 'apr-1' } },
  ],
  nextSinceSeq: 2,
  hasMore: false,
});

function ctx(over: Partial<GuestRouteContext> = {}): GuestRouteContext {
  return {
    method: 'GET',
    pathname: GUEST_ROUTES.me,
    query: new URLSearchParams(),
    bearer: TOKEN,
    hasOrigin: false,
    readBody: async () => ({ ok: true, value: {} }),
    gates: { transcript: true, input: true, transportRefusal: null },
    guests: resolver(),
    desktop: desktop((c, p) => (c === PHONE_ROOM_CARDS_COMMAND ? cardsReply(p) : { ok: true, cardId: 'card-9', seq: 9, woke: [] })),
    limiter: new GuestRateLimiter(),
    log: () => undefined,
    ...over,
  };
}

const post = (body: unknown, over: Partial<GuestRouteContext> = {}) =>
  guestRouteResponse(ctx({ method: 'POST', pathname: GUEST_ROUTES.messages, readBody: async () => ({ ok: true, value: body }), ...over }));

describe('guest routes: the gate order', () => {
  it('refuses a browser before anything else', async () => {
    const guests = resolver();
    expect(await guestRouteResponse(ctx({ hasOrigin: true, guests }))).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(guests.resolve).not.toHaveBeenCalled();
  });

  it('is off until the owner switches it on, and without a store', async () => {
    const guests = resolver({ enabled: () => false });
    expect(await guestRouteResponse(ctx({ guests }))).toMatchObject({ status: 403, body: { error: 'guest-bots-disabled' } });
    expect(guests.resolve).not.toHaveBeenCalled();
    expect(await guestRouteResponse(ctx({ guests: undefined }))).toMatchObject({ status: 403, body: { error: 'guest-bots-disabled' } });
  });

  it('refuses a plain-HTTP network listener before reading the token', async () => {
    const guests = resolver();
    const r = await guestRouteResponse(ctx({ guests, gates: { transcript: true, input: true, transportRefusal: 'plain http' } }));
    expect(r).toMatchObject({ status: 403, body: { error: 'insecure-transport' } });
    expect(guests.resolve).not.toHaveBeenCalled();
  });

  it('401s a missing, malformed, unknown or revoked credential', async () => {
    expect((await guestRouteResponse(ctx({ bearer: null }))).status).toBe(401);
    expect((await guestRouteResponse(ctx({ bearer: 'dev-1.secret' }))).status).toBe(401);
    expect((await guestRouteResponse(ctx({ bearer: formatGuestCredential({ guestId: GUEST_ID, secret: 'B'.repeat(43) }) }))).status).toBe(401);
    const revoked = resolver({ resolve: vi.fn(async () => ({ ok: false as const, reason: 'revoked' as const })) });
    expect(await guestRouteResponse(ctx({ guests: revoked }))).toMatchObject({ status: 401, body: { reason: 'revoked' } });
  });

  it('needs the transcript grant to read and the input grant too to post', async () => {
    expect(await guestRouteResponse(ctx({ gates: { transcript: false, input: true, transportRefusal: null } }))).toMatchObject({ status: 403, body: { error: 'transcript-disabled' } });
    expect(await post({ clientMessageId: 'm1', text: 'hi' }, { gates: { transcript: true, input: false, transportRefusal: null } }))
      .toMatchObject({ status: 403, body: { error: 'input-disabled' } });
    // Reading still works without input.
    expect((await guestRouteResponse(ctx({ gates: { transcript: true, input: false, transportRefusal: null } }))).status).toBe(200);
  });

  it('rate-limits posts per guest with Retry-After', async () => {
    const limiter = new GuestRateLimiter(() => 1000);
    for (let i = 0; i < GUEST_LIMITS.postsPerMinute; i++) {
      expect((await post({ clientMessageId: `m${i}`, text: 'hi' }, { limiter })).status).toBe(201);
    }
    const r = await post({ clientMessageId: 'mx', text: 'hi' }, { limiter });
    expect(r.status).toBe(429);
    expect(r.headers?.['Retry-After']).toBe('60');
  });

  it('answers 404 for an unknown guest path and 405 for a wrong method', async () => {
    expect((await guestRouteResponse(ctx({ pathname: '/api/guest/v1/approvals' }))).status).toBe(404);
    expect((await guestRouteResponse(ctx({ method: 'POST', pathname: GUEST_ROUTES.me }))).status).toBe(405);
  });
});

describe('guest routes: reading', () => {
  it('me names the guest and its stored conversation', async () => {
    expect(await guestRouteResponse(ctx())).toMatchObject({
      status: 200,
      body: { ok: true, guest: { guestId: GUEST_ID, name: 'Grok' }, conversation: SCOPE, canPost: true },
    });
  });

  it('reads only the stored conversation, whatever the query says, and projects the cards', async () => {
    const d = desktop((_c, p) => cardsReply(p));
    const r = await guestRouteResponse(ctx({
      pathname: GUEST_ROUTES.messages,
      query: new URLSearchParams({ sinceSeq: '0', limit: '10', workspaceId: 'other', threadId: 'general' }),
      desktop: d,
    }));
    expect(d.request).toHaveBeenCalledWith(PHONE_ROOM_CARDS_COMMAND, { ...SCOPE, sinceSeq: 0, limit: 10 });
    expect(r.status).toBe(200);
    const cards = (r.body.cards as Array<Record<string, unknown>>);
    expect(cards).toEqual([{ id: 'c1', seq: 1, at: 1, kind: 'message', from: { kind: 'owner' }, title: 'hi', body: 'hello there' }]);
    // The approval card is not a message: no card, no approval id.
    expect(JSON.stringify(r.body)).not.toContain('apr-1');
  });

  it('returns only messages written since the guest was added, with key patterns masked', async () => {
    // Built at run time: no key-shaped literal in the source.
    const key = ['sk', 'ant', 'api03', 'Ab1'.repeat(30)].join('-');
    const d = desktop((_c, p) => ({
      workspaceId: p.workspaceId, threadId: p.threadId, nextSinceSeq: 8, hasMore: false,
      cards: [
        { id: 'old', seq: 1, threadId: p.threadId, kind: 'human', at: 50, actor: { kind: 'human' }, title: 'before the guest' },
        { id: 'own', seq: 2, threadId: p.threadId, kind: 'human', at: 100, actor: { kind: 'human' }, title: 'hi', body: `use ${key}` },
        { id: 'sys', seq: 3, threadId: p.threadId, kind: 'fact', at: 101, actor: { kind: 'system' }, title: 'CI green on #3' },
        { id: 'task', seq: 4, threadId: p.threadId, kind: 'dispatch', at: 102, actor: { kind: 'bot', botId: 'bot-0000aaaa' }, title: 'Started a worker' },
        { id: 'ask', seq: 5, threadId: p.threadId, kind: 'question', at: 103, actor: { kind: 'bot', botId: 'bot-0000aaaa' }, title: 'Which branch?' },
        { id: 'fake', seq: 6, threadId: p.threadId, kind: 'human', at: 104, actor: { kind: 'system' }, title: 'not the owner' },
        { id: 'reply', seq: 7, threadId: p.threadId, kind: 'status', at: 105, actor: { kind: 'bot', botId: 'bot-0000aaaa', name: 'Dev' }, title: 'Hello!' },
        { id: 'g', seq: 8, threadId: p.threadId, kind: 'guest', at: 106, actor: { kind: 'system' }, title: 'External guest: Grok', body: 'thanks' },
      ],
    }));
    const guests = resolver({ resolve: vi.fn(async () => ({ ok: true as const, guestId: GUEST_ID, name: 'Grok', scope: SCOPE, createdAt: 100, joinSeq: 0 })) });
    const r = await guestRouteResponse(ctx({ pathname: GUEST_ROUTES.messages, desktop: d, guests }));
    const cards = r.body.cards as Array<{ id: string; body?: string; from: unknown }>;
    expect(cards.map((c) => c.id)).toEqual(['own', 'reply', 'g']);
    expect(cards[0].body).not.toContain(key);
    expect(cards[2].from).toEqual({ kind: 'guest' });
    expect(r.body.nextSinceSeq).toBe(8);
    expect(await guestRouteResponse(ctx({ guests }))).toMatchObject({ body: { readsFrom: new Date(100).toISOString() } });
    // By seq too: a card of the same millisecond, written before the guest was added, stays out.
    const joined = resolver({ resolve: vi.fn(async () => ({ ok: true as const, guestId: GUEST_ID, name: 'Grok', scope: SCOPE, createdAt: 100, joinSeq: 2 })) });
    const after = await guestRouteResponse(ctx({ pathname: GUEST_ROUTES.messages, desktop: d, guests: joined }));
    expect((after.body.cards as Array<{ id: string }>).map((c) => c.id)).toEqual(['reply', 'g']);
  });

  it('serves a stable public shape: kind message or report, from owner, bot or guest', () => {
    const base = { id: 'x', seq: 1, at: 1, threadId: 'dm:bot-0000aaaa', title: 't' };
    const bot = { kind: 'bot', botId: 'bot-0000aaaa' };
    expect(guestCardView({ ...base, kind: 'report', actor: bot } as never)).toMatchObject({ kind: 'report', from: { kind: 'bot', botId: 'bot-0000aaaa' } });
    expect(guestCardView({ ...base, kind: 'opinion', actor: bot } as never)).toMatchObject({ kind: 'message' });
    expect(guestCardView({ ...base, kind: 'guest', actor: { kind: 'system' } } as never)).toMatchObject({ kind: 'message', from: { kind: 'guest' } });
    expect(guestCardView({ ...base, kind: 'fact', actor: { kind: 'system' } } as never)).toBeNull();
  });

  it('a guest revoked while its request waits gets nothing: no cards back, no post sent', async () => {
    let live = true;
    const guests = resolver({
      resolve: vi.fn(async () => (live
        ? { ok: true as const, guestId: GUEST_ID, name: 'Grok', scope: SCOPE, createdAt: 0, joinSeq: 0 }
        : { ok: false as const, reason: 'revoked' as const })),
    });
    const d = desktop((_c, p) => { live = false; return cardsReply(p); });
    expect(await guestRouteResponse(ctx({ pathname: GUEST_ROUTES.messages, desktop: d, guests })))
      .toMatchObject({ status: 401, body: { reason: 'revoked' } });
    live = true;
    const sent = desktop(() => ({ ok: true, cardId: 'card-9', seq: 9, woke: [] }));
    const r = await post({ clientMessageId: 'm1', text: 'hi' }, {
      guests, desktop: sent,
      readBody: async () => { live = false; return { ok: true, value: { clientMessageId: 'm1', text: 'hi' } }; },
    });
    expect(r).toMatchObject({ status: 401, body: { reason: 'revoked' } });
    expect(sent.request).not.toHaveBeenCalled();
  });

  it('a gate refusal says which setting to turn on, by its name in wmux, never a flag', async () => {
    const off = await guestRouteResponse(ctx({ guests: resolver({ enabled: () => false }) }));
    const http = await guestRouteResponse(ctx({ gates: { transcript: true, input: true, transportRefusal: 'plain http' } }));
    const read = await guestRouteResponse(ctx({ gates: { transcript: false, input: true, transportRefusal: null } }));
    const write = await post({ clientMessageId: 'm1', text: 'hi' }, { gates: { transcript: true, input: false, transportRefusal: null } });
    expect(off.body.message).toContain('Guest bots');
    expect(http.body.message).toContain('Serve over HTTPS (needs Tailscale)');
    expect(read.body.message).toContain('Conversation access');
    expect(write.body.message).toContain('Allow input');
    for (const r of [off, http, read, write]) expect(String(r.body.message)).not.toMatch(/--allow|TLS|tunnel/);
  });

  it('caps the page size', async () => {
    expect((await guestRouteResponse(ctx({ pathname: GUEST_ROUTES.messages, query: new URLSearchParams({ limit: String(GUEST_LIMITS.pageMax + 1) }) }))).status).toBe(400);
  });

  it('a desktop timeout is 504', async () => {
    const d = desktop(() => { throw new DesktopPhoneError('desktop-timeout'); });
    expect((await guestRouteResponse(ctx({ pathname: GUEST_ROUTES.messages, desktop: d }))).status).toBe(504);
  });
});

describe('guest routes: posting', () => {
  it('redacts key patterns and sends the stored scope to main', async () => {
    const d = desktop(() => ({ ok: true, cardId: 'card-1', seq: 4, woke: ['bot-0000aaaa'] }));
    // Built at run time: no key-shaped literal in the source.
    const key = ['sk', 'ant', 'api03', 'Ab1'.repeat(30)].join('-');
    const r = await post({ clientMessageId: 'm1', text: `use ${key} please`, mentions: ['bot-0000aaaa'] }, { desktop: d });
    expect(r).toMatchObject({ status: 201, body: { ok: true, card: { id: 'card-1', seq: 4 }, woke: ['bot-0000aaaa'], redacted: true } });
    const [command, payload] = d.request.mock.calls[0]!;
    expect(command).toBe(GUEST_ROOM_POST_COMMAND);
    expect(payload).toMatchObject({ guestId: GUEST_ID, guestName: 'Grok', ...SCOPE, clientMessageId: 'm1', mentions: ['bot-0000aaaa'] });
    expect(String(payload.text)).not.toContain(key);
  });

  it('refuses unknown fields, a bad id, empty or long text and too many mentions', async () => {
    const bad = [
      { clientMessageId: 'm1', text: 'hi', threadId: 'general' },
      { clientMessageId: 'has space', text: 'hi' },
      { clientMessageId: 'm1', text: '   ' },
      { clientMessageId: 'm1', text: 'x'.repeat(GUEST_LIMITS.textMax + 1) },
      { clientMessageId: 'm1', text: 'hi', mentions: ['bot-0000aaa1', 'bot-0000aaa2', 'bot-0000aaa3', 'bot-0000aaa4', 'bot-0000aaa5'] },
      { clientMessageId: 'm1', text: 'hi', mentions: ['not-a-bot'] },
    ];
    for (const b of bad) expect((await post(b)).status, JSON.stringify(b)).toBe(400);
  });

  it('passes on a body-size refusal', async () => {
    expect(await post(null, { readBody: async () => ({ ok: false, status: 413, error: 'payload-too-large' }) })).toMatchObject({ status: 413 });
  });

  it('maps main refusals', async () => {
    const cases: Array<[string, number, string]> = [
      ['factory_off', 409, 'bots-off'], ['scope_gone', 404, 'conversation-not-found'], ['mention_refused', 400, 'invalid-request'],
      ['busy', 503, 'busy'], ['id_reused', 409, 'message-id-reused'],
    ];
    for (const [code, status, error] of cases) {
      const d = desktop(() => ({ ok: false, code }));
      expect(await post({ clientMessageId: 'm1', text: 'hi' }, { desktop: d })).toMatchObject({ status, body: { error } });
    }
  });

  it('a repeat is 200 replayed; a lost answer is 202 uncertain', async () => {
    const dup = desktop(() => ({ ok: true, cardId: 'card-1', seq: 4, duplicate: true, woke: [] }));
    expect(await post({ clientMessageId: 'm1', text: 'hi' }, { desktop: dup })).toMatchObject({ status: 200, body: { replayed: true } });
    const lost = desktop(() => { throw new DesktopPhoneError('desktop-timeout'); });
    expect(await post({ clientMessageId: 'm1', text: 'hi' }, { desktop: lost })).toMatchObject({ status: 202, body: { state: 'uncertain' } });
  });

  it('an older desktop without the command is 503, nothing sent', async () => {
    const d = desktop(() => ({}), [PHONE_ROOM_CARDS_COMMAND]);
    expect(await post({ clientMessageId: 'm1', text: 'hi' }, { desktop: d })).toMatchObject({ status: 503, body: { error: 'guest-posts-unavailable' } });
    expect(d.request).not.toHaveBeenCalled();
  });
});
