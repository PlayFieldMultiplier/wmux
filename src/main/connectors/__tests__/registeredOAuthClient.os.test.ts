import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ConnectorOAuth } from '../connectorOAuth';
import { ConnectorOAuthStore } from '../oauthStore';
import type { Connector } from '../../../shared/botConnector';
import type { ConnectorOAuthClient } from '../../../shared/connectorOAuth';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(changedDestination = false) {
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-registered-oauth-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const connector: Connector = { id: 'con-12345678', name: 'test-service', transport: 'http', remote: { url: 'https://resource.example/mcp', headers: {} }, secrets: [], tools: { mode: 'listed', allowed: [] }, scope: { kind: 'bots', botIds: [] }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1 };
  const supplied: ConnectorOAuthClient = { clientId: 'registered-app', clientSecret: 'registered-secret', issuer: 'https://issuer.example', tokenEndpoint: 'https://issuer.example/token', callbackPort: port, scope: 'read', offlineAccess: true, tokenAuthMethod: 'client_secret_post' };
  const store = new ConnectorOAuthStore(dir, { state: () => 'ok', encrypt: (s) => Buffer.from(Buffer.from(s).toString('base64')), decrypt: (b) => Buffer.from(b.toString(), 'base64').toString() });
  const requests: Array<{ url: string; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); requests.push({ url, body: String(init?.body ?? '') });
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    if (url.includes('oauth-protected-resource')) return json({ resource: connector.remote!.url, authorization_servers: [supplied.issuer], scopes_supported: ['read'] });
    if (url.includes('oauth-authorization-server')) return json({ issuer: supplied.issuer, authorization_endpoint: 'https://issuer.example/authorize', token_endpoint: changedDestination ? 'https://other.example/token' : supplied.tokenEndpoint, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'], authorization_response_iss_parameter_supported: true });
    if (url === supplied.tokenEndpoint) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_id')).toBe(supplied.clientId);
      expect(body.get('client_secret')).toBe(supplied.clientSecret);
      if (body.get('grant_type') === 'authorization_code') expect(body.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/oauth/callback`);
      return json({ access_token: 'account-token', refresh_token: 'refresh-token', token_type: 'Bearer', expires_in: 3600 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  let opened = 0;
  const manager = new ConnectorOAuth({ store, getConnector: () => connector, fetch: fetcher, timeoutMs: 3000, openBrowser: async (raw) => {
    opened++;
    const url = new URL(raw);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe('read');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(raw).not.toContain(supplied.clientSecret);
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'test-code', iss: supplied.issuer }).toString();
    expect((await fetch(callback)).status).toBe(200);
  } });
  const timer = setInterval(() => { const pending = manager.status(connector.id); if (pending.consent) manager.approve(connector.id, pending.consent.id); }, 5);
  cleanup.push(() => { clearInterval(timer); manager.dispose(); });
  return { manager, store, supplied, connector, requests, dir, opened: () => opened };
}
it('uses a registered confidential client without DCR, keeps its secret encrypted and refreshes with the same pin', async () => {
  const f = await fixture();
  expect(await f.manager.connect(f.connector.id, f.supplied)).toEqual({ status: 'authorized' });
  expect(f.opened()).toBe(1);
  expect(f.requests.some((r) => r.url.includes('register'))).toBe(false);
  expect(fs.readFileSync(path.join(f.dir, `${f.connector.id}.json`), 'utf8')).not.toContain('registered-secret');
  const saved = f.store.read(f.connector.id, f.connector.remote!.url)!;
  expect(saved.suppliedClient).toEqual(f.supplied);
  f.store.write(f.connector.id, { ...saved, expiresAt: 0 });
  expect(await f.manager.accessToken(f.connector.id)).toBe('account-token');
  expect(f.opened()).toBe(1);
});
it('refuses changed token destinations before opening a browser or sending client credentials', async () => {
  const f = await fixture(true);
  expect(await f.manager.connect(f.connector.id, f.supplied)).toEqual({ status: 'failed' });
  expect(f.opened()).toBe(0);
  expect(f.requests.every((r) => !r.body.includes('registered-secret'))).toBe(true);
  expect(f.store.read(f.connector.id, f.connector.remote!.url)).toBeUndefined();
});
