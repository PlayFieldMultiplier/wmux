import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectorOAuth } from '../connectorOAuth';
import { ConnectorOAuthStore } from '../oauthStore';
import type { Connector } from '../../../shared/botConnector';
import type { SecretCrypto } from '../../factory/secretStore';

const resources: Array<() => void> = [];
afterEach(() => { for (const clean of resources.splice(0).reverse()) clean(); });
const crypto: SecretCrypto = { state: () => 'ok', encrypt: (s) => Buffer.from(Buffer.from(s).toString('base64')), decrypt: (b) => Buffer.from(b.toString(), 'base64').toString() };
async function fixture(timeoutMs?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-oauth-'));
  resources.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let origin = '';
  let challenge = '';
  let redirect = '';
  let refreshes = 0;
  let registrations = 0;
  let registrationExtra: Record<string, unknown> = {};
  let mode: 'ok' | 'invalid-grant' | 'delay' = 'ok';
  let finishToken: (() => void) | undefined;
  let tokenStarted!: () => void;
  const tokenRequest = new Promise<void>((r) => { tokenStarted = r; });
  const server: Server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const send = (body: unknown) => res.end(JSON.stringify(body));
    if (req.url?.startsWith('/.well-known/oauth-protected-resource')) return send({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read'] });
    if (req.url?.startsWith('/.well-known/oauth-authorization-server')) return send({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true });
    let body = ''; for await (const b of req) body += b;
    if (req.url === '/register') { registrations++; const metadata = JSON.parse(body); redirect = metadata.redirect_uris[0]; return send({ ...metadata, client_id: 'test-client', ...registrationExtra }); }
    if (req.url === '/token') {
      tokenStarted();
      const params = new URLSearchParams(body);
      if (params.get('resource') !== `${origin}/mcp`) { res.statusCode = 400; return send({ error: 'invalid_target' }); }
      if (params.get('grant_type') === 'authorization_code') {
        if (params.get('code') !== 'test-code' || createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url') !== challenge || params.get('redirect_uri') !== redirect) { res.statusCode = 400; return send({ error: 'invalid_grant' }); }
      } else refreshes++;
      if (mode === 'invalid-grant') { res.statusCode = 400; return send({ error: 'invalid_grant' }); }
      const finish = () => send({ access_token: `access-token-${refreshes}`, token_type: 'Bearer', refresh_token: `refresh-token-${refreshes}`, expires_in: 3600 });
      if (mode === 'delay') { finishToken = finish; return; }
      finish(); return;
    }
    res.statusCode = 404; send({});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  resources.push(() => { server.closeAllConnections(); server.close(); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let connector: Connector | undefined = { id: 'con-12345678', name: 'test-service', transport: 'http', remote: { url: `${origin}/mcp`, headers: {} }, secrets: [], tools: { mode: 'listed', allowed: [] }, scope: { kind: 'bots', botIds: [] }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1 };
  let opened!: (url: URL) => Promise<void>;
  const store = new ConnectorOAuthStore(dir, crypto);
  const manager = new ConnectorOAuth({ timeoutMs, store, getConnector: () => connector, openBrowser: async (raw) => {
    const url = new URL(raw); challenge = url.searchParams.get('code_challenge') ?? '';
    await opened(url);
  } });
  let approve = true;
  const approval = setInterval(() => { if (approve && manager.status('con-12345678').status === 'confirm') manager.approve('con-12345678', manager.status('con-12345678').consent!.id); }, 5);
  resources.push(() => { clearInterval(approval); manager.dispose(); });
  const callback = async (url: URL, overrides: Record<string, string> = {}) => {
    const target = new URL(url.searchParams.get('redirect_uri') ?? '');
    target.search = new URLSearchParams({ state: url.searchParams.get('state') ?? '', code: 'test-code', iss: origin, ...overrides }).toString();
    return fetch(target);
  };
  opened = async (url) => { await callback(url); };
  return { manager, store, setApprove: (value: boolean) => { approve = value; }, dir, origin, callback, tokenRequest, id: 'con-12345678', setOpen: (fn: typeof opened) => { opened = fn; }, setMode: (value: typeof mode) => { mode = value; }, setRegistration: (value: Record<string, unknown>) => { registrationExtra = value; }, release: () => finishToken?.(), remove: () => { connector = undefined; }, getConnector: () => connector, refreshes: () => refreshes, registrations: () => registrations };
}
it('authorizes with state and PKCE, persists encrypted credentials and refreshes after restart', async () => {
  const f = await fixture();
  expect(await f.manager.connect(f.id)).toEqual({ status: 'authorized' });
  expect(f.manager.status(f.id)).toEqual({ status: 'authorized' });
  expect(fs.readFileSync(path.join(f.dir, `${f.id}.json`), 'utf8')).not.toContain('access-token');
  const saved = f.store.read(f.id, `${f.origin}/mcp`)!;
  f.store.write(f.id, { ...saved, expiresAt: 0 });
  const restarted = new ConnectorOAuth({ store: new ConnectorOAuthStore(f.dir, crypto), getConnector: f.getConnector, openBrowser: async () => { throw new Error('Must not open browser for refresh'); } });
  expect(await restarted.accessToken(f.id)).toBe('access-token-1');
  expect(f.refreshes()).toBe(1);
  expect(restarted.disconnect(f.id)).toEqual({ status: 'signed-out' });
  expect(f.store.read(f.id, `${f.origin}/mcp`)).toBeUndefined();
});
it('ignores wrong state and issuer before accepting the one valid callback', async () => {
  const f = await fixture();
  f.setOpen(async (url) => {
    expect((await f.callback(url, { state: 'wrong' })).status).toBe(400);
    expect((await f.callback(url, { iss: 'https://wrong.example' })).status).toBe(400);
    expect((await f.callback(url)).status).toBe(200);
    expect((await f.callback(url)).status).toBe(400);
  });
  expect(await f.manager.connect(f.id)).toEqual({ status: 'authorized' });
});
it('does not persist a late token after disconnect or deletion', async () => {
  for (const remove of [false, true]) {
    const f = await fixture(); f.setMode('delay');
    const pending = f.manager.connect(f.id);
    await f.tokenRequest;
    if (remove) f.remove(); else f.manager.disconnect(f.id);
    f.release();
    expect(await pending).toEqual({ status: 'failed' });
    expect(f.store.read(f.id, `${f.origin}/mcp`)).toBeUndefined();
  }
});
it('cancels browser waiting without storing a token and refuses overlapping attempts', async () => {
  const f = await fixture();
  f.setOpen(async () => {
    expect(await f.manager.connect(f.id)).toEqual({ status: 'busy' });
    f.manager.cancel(f.id);
  });
  expect(await f.manager.connect(f.id)).toEqual({ status: 'failed' });
  expect(f.store.read(f.id, `${f.origin}/mcp`)).toBeUndefined();
});
it('never uses an expired token after refresh refusal or silently opens a browser', async () => {
  const f = await fixture(); await f.manager.connect(f.id);
  const saved = f.store.read(f.id, `${f.origin}/mcp`)!;
  f.store.write(f.id, { ...saved, expiresAt: 0 }); f.setMode('invalid-grant');
  f.setOpen(async () => { throw new Error('Unexpected browser'); });
  await expect(f.manager.accessToken(f.id)).rejects.toThrow();
  expect(f.manager.status(f.id)).toEqual({ status: 'expired' });
});
it('refuses plaintext storage and binds records to their saved endpoint', async () => {
  const f = await fixture(); await f.manager.connect(f.id);
  expect(f.store.read(f.id, 'https://different.example/mcp')).toBeUndefined();
  const locked = new ConnectorOAuthStore(f.dir, { ...crypto, state: () => 'basic_text' });
  expect(() => locked.read(f.id, `${f.origin}/mcp`)).toThrow();
});

it('expires an abandoned authorization and reports persistence failure without claiming success', async () => {
  const timed = await fixture(1000);
  timed.setOpen(async () => undefined);
  expect(await timed.manager.connect(timed.id)).toEqual({ status: 'failed' });
  expect(timed.store.read(timed.id, `${timed.origin}/mcp`)).toBeUndefined();
  const broken = await fixture();
  broken.setOpen(async (url) => {
    fs.rmSync(broken.dir, { recursive: true }); fs.writeFileSync(broken.dir, 'not a directory');
    await broken.callback(url);
  });
  expect(await broken.manager.connect(broken.id)).toEqual({ status: 'failed' });
});

it('does not let a registration response weaken mandatory callback issuer validation', async () => {
  const f = await fixture();
  f.setRegistration({ issuer: f.origin, authorization_endpoint: `${f.origin}/authorize`, authorization_response_iss_parameter_supported: false });
  f.setOpen(async (url) => {
    const target = new URL(url.searchParams.get('redirect_uri') ?? '');
    target.search = new URLSearchParams({ state: url.searchParams.get('state') ?? '', code: 'test-code' }).toString();
    expect((await fetch(target)).status).toBe(400);
    await f.callback(url);
  });
  expect(await f.manager.connect(f.id)).toEqual({ status: 'authorized' });
});

it('requires consent before registration or browser launch and binds it to the resource and issuer', async () => {
  const f = await fixture(); f.setApprove(false);
  const opened = vi.fn(); f.setOpen(opened);
  const pending = f.manager.connect(f.id);
  await vi.waitFor(() => expect(f.manager.status(f.id)).toEqual({ status: 'confirm', consent: { id: expect.any(String), resource: `${f.origin}/mcp`, issuer: f.origin, authorizationOrigin: f.origin } }), { timeout: 5000 });
  f.manager.approve(f.id, 'stale-confirmation');
  expect(f.manager.status(f.id).status).toBe('confirm');
  expect(opened).not.toHaveBeenCalled();
  expect(f.registrations()).toBe(0);
  f.manager.cancel(f.id);
  expect(await pending).toEqual({ status: 'failed' });
  expect(f.store.read(f.id, `${f.origin}/mcp`)).toBeUndefined();
});
it('purges removed and changed endpoints, including orphaned records after restart', async () => {
  for (const removed of [false, true]) {
    const f = await fixture(); await f.manager.connect(f.id);
    const original = f.getConnector()!.remote!.url;
    if (removed) f.remove(); else f.getConnector()!.remote!.url += '/changed';
    const revision = f.manager.revision(f.id);
    f.manager.reconcile();
    expect(f.manager.revision(f.id)).toBeGreaterThan(revision);
    expect(f.store.ids()).toEqual([]);
    if (!removed) { f.getConnector()!.remote!.url = original; expect(await f.manager.accessToken(f.id)).toBeUndefined(); }
  }
  const f = await fixture(); await f.manager.connect(f.id); f.remove();
  const restarted = new ConnectorOAuth({ store: f.store, getConnector: f.getConnector, openBrowser: async () => undefined });
  restarted.reconcile(); expect(f.store.ids()).toEqual([]);
});

it('revokes persisted OAuth when the library switches to static credentials', async () => {
  const f = await fixture(); await f.manager.connect(f.id);
  f.getConnector()!.remote!.headers.Authorization = 'Bearer static';
  f.manager.reconcile();
  expect(f.store.ids()).toEqual([]);
  delete f.getConnector()!.remote!.headers.Authorization;
  expect(await f.manager.accessToken(f.id)).toBeUndefined();
});

it('preserves encrypted records on transient keychain and decryption failures, but still revokes definitive edits', async () => {
  const f = await fixture(); await f.manager.connect(f.id);
  let locked = true; let broken = false;
  const store = new ConnectorOAuthStore(f.dir, { ...crypto, state: () => locked ? 'unavailable' : 'ok', decrypt: (value) => { if (broken) throw new Error('Keychain denied'); return crypto.decrypt(value); } });
  const restarted = new ConnectorOAuth({ store, getConnector: f.getConnector, openBrowser: async () => undefined });
  restarted.reconcile(); expect(store.ids()).toEqual([f.id]);
  locked = false; broken = true;
  restarted.reconcile(); expect(store.ids()).toEqual([f.id]);
  await expect(restarted.accessToken(f.id)).rejects.toThrow();
  broken = false;
  expect(await restarted.accessToken(f.id)).toBe('access-token-0');
  locked = true;
  f.getConnector()!.remote!.url += '/changed';
  restarted.reconcile(); expect(store.ids()).toEqual([]);
});

it('still revokes known endpoint changes when the credential directory cannot be listed', async () => {
  const f = await fixture(); await f.manager.connect(f.id);
  const listing = vi.spyOn(f.store, 'ids').mockImplementation(() => { throw new Error('Temporary directory read failure'); });
  f.manager.reconcile();
  expect(await f.manager.accessToken(f.id)).toBe('access-token-0');
  f.getConnector()!.remote!.url += '/changed';
  f.manager.reconcile();
  listing.mockRestore(); expect(f.store.ids()).toEqual([]);
});

it('shares one refresh between concurrent callers, never opening a browser for it', async () => {
  const f = await fixture(); await f.manager.connect(f.id);
  const saved = f.store.read(f.id, `${f.origin}/mcp`)!;
  f.store.write(f.id, { ...saved, expiresAt: 0 }); f.setMode('delay');
  f.setOpen(async () => { throw new Error('Unexpected browser'); });
  const first = f.manager.accessToken(f.id);
  const second = f.manager.accessToken(f.id);
  await vi.waitFor(() => expect(f.refreshes()).toBe(1), { timeout: 10_000 });
  f.release();
  expect(await first).toBe('access-token-1');
  expect(await second).toBe('access-token-1');
  expect(f.refreshes()).toBe(1);
});

it('says whether a sign-in is stored and tells listeners when one is replaced or removed', async () => {
  const f = await fixture();
  const bumped: string[] = [];
  const off = f.manager.onRevision((id) => bumped.push(id));
  expect(f.manager.hasRecord(f.id)).toBe(false);
  await f.manager.connect(f.id);
  expect(f.manager.hasRecord(f.id)).toBe(true);
  expect(bumped).toEqual([f.id]);
  f.manager.disconnect(f.id);
  expect(f.manager.hasRecord(f.id)).toBe(false);
  expect(bumped).toEqual([f.id, f.id]);
  off();
  await f.manager.connect(f.id);
  expect(bumped).toHaveLength(2);
  const unavailable = vi.spyOn(f.store, 'available').mockReturnValue(false);
  expect(f.manager.hasRecord(f.id)).toBe('unknown');
  unavailable.mockRestore();
});
