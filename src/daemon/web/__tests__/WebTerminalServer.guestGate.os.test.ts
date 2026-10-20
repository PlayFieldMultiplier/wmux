import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { request as httpReq } from 'node:http';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import { formatGuestCredential, GUEST_ROUTES } from '../../../shared/guestBots';
import { formatPeerCredential } from '../../../shared/a2aRemote';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import type { GuestBotResolver } from '../guestBotRoutes';

/**
 * The guest bot gate: `/api/guest/*` takes a guest credential and nothing
 * else, and a guest credential is refused on every other route without
 * reaching `authenticate()`.
 */

const GUEST_ID = '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const SECRET = 'A'.repeat(43);
const GUEST = formatGuestCredential({ guestId: GUEST_ID, secret: SECRET });
const SCOPE = { workspaceId: 'ws-1', threadId: 'dm:bot-0000aaaa' as const };

type Res = { status: number; body: Record<string, unknown> | null };

describe('guest bot gate', () => {
  let servers: WebTerminalServer[];
  let guests: { enabled: Mock<() => boolean>; resolve: Mock<GuestBotResolver['resolve']>; touch: Mock<(id: string) => void> };
  let devices: { resolve: Mock<WebDeviceResolver['resolve']>; mint: Mock<WebDeviceResolver['mint']> };

  const start = async (opts: { host?: string; allowInput?: boolean; desktop?: unknown } = {}) => {
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    const s = new WebTerminalServer({ sessionManager, devices, guests, log: () => undefined, assetsDir: os.tmpdir(), ...(opts.desktop ? { desktop: () => opts.desktop as never } : {}) });
    servers.push(s);
    await s.start({ port: 0, host: opts.host ?? '127.0.0.1', allowInput: opts.allowInput ?? true, allowUpload: false, allowTranscript: true });
    return s;
  };

  const call = (s: WebTerminalServer, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      const req = httpReq({ host: '127.0.0.1', port: s.status().port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { text += c; });
        res.on('end', () => {
          let body: Record<string, unknown> | null = null;
          try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeEach(() => {
    servers = [];
    guests = {
      enabled: vi.fn(() => true),
      resolve: vi.fn<GuestBotResolver['resolve']>(async (id, secret) =>
        id === GUEST_ID && secret === SECRET ? { ok: true, guestId: id, name: 'Grok', scope: SCOPE, createdAt: 0, joinSeq: 0 } : { ok: false, reason: 'unknown' }),
      touch: vi.fn(),
    };
    devices = {
      resolve: vi.fn<WebDeviceResolver['resolve']>(async () => ({ ok: true, deviceId: 'dev-1', allowInput: true })),
      mint: vi.fn<WebDeviceResolver['mint']>(async () => ({ deviceId: 'dev-1', deviceSecret: 'devicesecret' })),
    };
  });

  afterEach(async () => {
    for (const s of servers) if (s.isRunning) await s.stop();
  });

  for (const path of ['/api/sessions', '/api/workspaces', '/api/config', '/api/rooms/ws-1/cards', '/api/bots', '/api/a2a/hello']) {
    it(`a guest credential is refused on ${path} without authenticating`, async () => {
      const s = await start();
      const out = await call(s, path, { headers: bearer(GUEST) });
      expect([401, 403]).toContain(out.status);
      expect(guests.resolve).not.toHaveBeenCalled();
      expect(devices.resolve).not.toHaveBeenCalled();
    });
  }

  it('a guest credential is refused on the Moa and room write routes', async () => {
    const s = await start();
    for (const path of ['/api/moa/messages', '/api/rooms/ws-1/messages']) {
      const out = await call(s, path, { method: 'POST', headers: { ...bearer(GUEST), 'Content-Type': 'application/json' }, body: '{"clientMessageId":"m","text":"x"}' });
      expect(out).toEqual({ status: 403, body: { ok: false, error: 'forbidden' } });
    }
    expect(devices.resolve).not.toHaveBeenCalled();
  });

  it('the guest route answers a guest credential with its scope', async () => {
    // Main answers for the conversation (an empty page past its end).
    const desktop = { available: true, supports: () => true, request: vi.fn(async () => ({ workspaceId: SCOPE.workspaceId, threadId: SCOPE.threadId, cards: [], nextSinceSeq: 0, hasMore: false })) };
    const s = await start({ desktop });
    const out = await call(s, GUEST_ROUTES.me, { headers: bearer(GUEST) });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, guest: { name: 'Grok' }, conversation: SCOPE });
    expect(guests.touch).toHaveBeenCalledWith(GUEST_ID);
    // Without the desktop, me is refused as a read would be.
    const alone = await start();
    expect((await call(alone, GUEST_ROUTES.me, { headers: bearer(GUEST) })).status).toBe(503);
  });

  it('the guest route takes no operator, device or peer credential', async () => {
    const s = await start();
    const peer = formatPeerCredential({ peerId: GUEST_ID, secret: SECRET });
    // A device credential is a failed guest login; a peer credential is
    // refused by the peer gate before the guest gate (403).
    expect((await call(s, GUEST_ROUTES.me, { headers: bearer('dev-1.devicesecret') })).status).toBe(401);
    expect((await call(s, GUEST_ROUTES.me, { headers: bearer(peer) })).status).toBe(403);
    expect(devices.resolve).not.toHaveBeenCalled();
  });

  it('refuses a browser, and is off when the owner switched it off', async () => {
    const s = await start();
    expect(await call(s, GUEST_ROUTES.me, { headers: { ...bearer(GUEST), Origin: 'https://evil.example' } }))
      .toMatchObject({ status: 403, body: { error: 'forbidden' } });
    guests.enabled.mockReturnValue(false);
    expect(await call(s, GUEST_ROUTES.me, { headers: bearer(GUEST) })).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(guests.resolve).not.toHaveBeenCalled();
  });

  it('a post without a desktop is 503 after the gates, and an oversize body is 413', async () => {
    const s = await start();
    const ok = await call(s, GUEST_ROUTES.messages, { method: 'POST', headers: { ...bearer(GUEST), 'Content-Type': 'application/json' }, body: '{"clientMessageId":"m1","text":"hello"}' });
    expect(ok).toMatchObject({ status: 503, body: { error: 'desktop-unavailable' } });
    const big = await call(s, GUEST_ROUTES.messages, { method: 'POST', headers: { ...bearer(GUEST), 'Content-Type': 'application/json' }, body: JSON.stringify({ clientMessageId: 'm2', text: 'x'.repeat(20_000) }) });
    expect(big.status).toBe(413);
  });

  it('reports its gates for the owner', async () => {
    const s = await start({ allowInput: false });
    expect(s.guestGates()).toEqual({ serverRunning: true, transcript: true, input: false, secureTransport: true });
  });
});
