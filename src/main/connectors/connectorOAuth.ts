import { randomBytes } from 'node:crypto';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { isConnectorUrl, type Connector } from '../../shared/botConnector';
import { parseConnectorOAuthClient, type ConnectorOAuthClient, type ConnectorOAuthResult } from '../../shared/connectorOAuth';
import { ConnectorOAuthStore, type OAuthRecord } from './oauthStore';
import { createOAuthFetch } from './oauthFetch';
import { createOAuthCallback } from './oauthCallback';

interface Options {
  store: ConnectorOAuthStore;
  getConnector: (id: string) => Connector | undefined;
  openBrowser: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
/** Main-only OAuth sessions. Interactive auth is always an explicit owner action. */
export class ConnectorOAuth {
  private consent = new Map<string, { view: NonNullable<ConnectorOAuthResult['consent']>; approve: () => void }>();
  private revoked = new Set<string>();
  private endpoints = new Map<string, string>();
  private revisions = new Map<string, number>();
  revision(id: string): number { return this.revisions.get(id) ?? 0; }
  private active = new Map<string, AbortController>();
  constructor(private options: Options) {}
  private connector(id: string): Connector {
    const c = this.options.getConnector(id);
    if (!c || c.transport !== 'http' || !c.remote || !isConnectorUrl(c.remote.url)
      || c.secrets.length || Object.keys(c.remote.headers).some((h) => /authorization|cookie/i.test(h))) throw new Error('OAuth unavailable');
    return c;
  }
  /** Called synchronously on library mutation and after library startup. */
  reconcile(): void {
    const ids = new Set(this.endpoints.keys());
    try { for (const id of this.options.store.ids()) ids.add(id); } catch { /* still reconcile known connections */ }
    for (const id of ids) {
      let c: Connector | undefined;
      try { c = this.options.getConnector(id); } catch { continue; }
      const endpoint = c?.transport === 'http' && c.remote && isConnectorUrl(c.remote.url)
        && !c.secrets.length && !Object.keys(c.remote.headers).some((h) => /authorization|cookie/i.test(h)) ? c.remote.url : undefined;
      // Definite library changes revoke even while the keychain is locked.
      if (!endpoint || (this.endpoints.has(id) && this.endpoints.get(id) !== endpoint)) {
        this.disconnect(id); continue;
      }
      this.endpoints.set(id, endpoint);
      // A transient read/decryption failure is not evidence of removal.
      // Keep the encrypted record; token access still fails closed in read().
      if (!this.options.store.available() || this.active.has(id)) continue;
      try {
        if (!this.options.store.read(id, endpoint)) this.disconnect(id);
      } catch { /* preserve credentials until secure storage is readable again */ }
    }
  }
  status(id: string): ConnectorOAuthResult {
    try {
      const c = this.connector(id);
      if (!this.options.store.available()) return { status: 'unavailable' };
      const consent = this.consent.get(id);
      if (consent) return { status: 'confirm', consent: consent.view };
      if (this.active.get(id) && !this.active.get(id)?.signal.aborted) return { status: 'authorizing' };
      const record = this.revoked.has(id) ? undefined : this.options.store.read(id, c.remote!.url);
      return { status: !record ? 'signed-out' : record.expiresAt > Date.now() ? 'authorized' : 'expired' };
    } catch { return { status: 'unavailable' }; }
  }
  approve(id: string, consentId: string): ConnectorOAuthResult {
    const pending = this.consent.get(id);
    if (pending?.view.id === consentId) pending.approve();
    return this.status(id);
  }
  cancel(id: string): ConnectorOAuthResult {
    this.active.get(id)?.abort();
    return this.status(id);
  }
  disconnect(id: string): ConnectorOAuthResult {
    this.revoked.add(id);
    this.endpoints.delete(id);
    this.revisions.set(id, this.revision(id) + 1);
    this.cancel(id);
    try { this.options.store.remove(id); return { status: 'signed-out' }; }
    catch { return { status: 'failed' }; }
  }
  dispose(): void { for (const controller of this.active.values()) controller.abort(); }
  async connect(id: string, suppliedClient?: ConnectorOAuthClient): Promise<ConnectorOAuthResult> {
    if (this.active.has(id) || this.active.size >= 4) return { status: 'busy' };
    if (suppliedClient !== undefined && !parseConnectorOAuthClient(suppliedClient)) return { status: 'failed' };
    try { await this.run(id, true, undefined, suppliedClient); return { status: 'authorized' }; }
    catch { return { status: 'failed' }; }
  }
  /** Caller must recheck the configuration after use. Never falls back to stale tokens. */
  async accessToken(id: string): Promise<string | undefined> {
    const c = this.connector(id);
    if (this.revoked.has(id)) return undefined;
    const saved = this.options.store.read(id, c.remote!.url);
    if (!saved) return undefined;
    if (saved.expiresAt > Date.now() + 30_000) return saved.tokens.access_token;
    if (this.active.has(id) || this.active.size >= 4) throw new Error('Authorization busy');
    return (await this.run(id, false, saved)).tokens.access_token;
  }
  private async run(id: string, interactive: boolean, saved?: OAuthRecord, suppliedClient = saved?.suppliedClient): Promise<OAuthRecord> {
    if (suppliedClient && !parseConnectorOAuthClient(suppliedClient)) throw new Error('Invalid OAuth client');
    const connector = this.connector(id);
    if (!this.options.store.available()) throw new Error('Secure storage unavailable');
    const endpoint = connector.remote!.url;
    this.endpoints.set(id, endpoint);
    const snapshot = JSON.stringify(connector);
    const controller = new AbortController();
    this.active.set(id, controller);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? (interactive ? 120_000 : 15_000));
    const valid = () => {
      if (controller.signal.aborted || this.active.get(id) !== controller || JSON.stringify(this.options.getConnector(id)) !== snapshot) throw new Error('Authorization changed');
    };
    let callback: Awaited<ReturnType<typeof createOAuthCallback>> | undefined;
    let client: OAuthClientInformationMixed | undefined = saved?.client ?? (suppliedClient ? {
      client_id: suppliedClient.clientId, client_secret: suppliedClient.clientSecret,
      issuer: suppliedClient.issuer, token_endpoint_auth_method: suppliedClient.tokenAuthMethod,
    } : undefined);
    let tokens: OAuthTokens | undefined = saved?.tokens;
    let expiresAt = saved?.expiresAt ?? 0;
    let verifier = '';
    let discovery: OAuthDiscoveryState | undefined;
    const issuerRequirements = new Map<string, boolean>();
    const state = randomBytes(32).toString('base64url');
    try {
      if (interactive) callback = await createOAuthCallback(state, controller.signal, (issuer) => {
        const metadata = discovery?.authorizationServerMetadata;
        if (!metadata?.issuer) return false;
        return issuer === null ? issuerRequirements.get(metadata.issuer) !== true : issuer === metadata.issuer;
      }, suppliedClient?.callbackPort);
      const redirectUrl = callback?.redirectUrl ?? saved?.redirectUrl;
      if (!redirectUrl) throw new Error('Missing redirect');
      const allowedUrl = (raw: string) => {
        if (!isConnectorUrl(raw)) throw new Error('Unsafe OAuth endpoint');
        const url = new URL(raw);
        // A remote server cannot use discovery to reach local HTTP services.
        if (url.protocol !== 'https:' && url.origin !== new URL(endpoint).origin) throw new Error('Unsafe OAuth endpoint');
        return url;
      };
      const provider: OAuthClientProvider = {
        redirectUrl,
        clientMetadata: { client_name: 'wmux', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: suppliedClient?.tokenAuthMethod ?? 'none' },
        state: () => state,
        clientInformation: () => client,
        saveClientInformation: (value) => { valid(); client = value; },
        tokens: () => tokens,
        saveTokens: (value) => {
          valid();
          if (!value.issuer || value.token_type.toLowerCase() !== 'bearer' || /[\r\n]/.test(value.access_token)) throw new Error('Invalid token');
          tokens = { ...value, ...(value.refresh_token ? {} : tokens?.issuer === value.issuer && tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}) };
          expiresAt = Date.now() + Math.max(0, value.expires_in ?? 300) * 1000;
          if (!Number.isFinite(expiresAt)) throw new Error('Invalid token expiry');
        },
        saveCodeVerifier: (value) => { valid(); verifier = value; },
        codeVerifier: () => { valid(); if (!verifier) throw new Error('Missing verifier'); return verifier; },
        redirectToAuthorization: async (url) => {
          valid(); if (!interactive) throw new Error('Sign in required');
          allowedUrl(url.href);
          if (url.searchParams.get('state') !== state || url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('Unsafe authorization');
          if (suppliedClient?.offlineAccess) { url.searchParams.set('access_type', 'offline'); url.searchParams.set('prompt', 'consent'); }
          await this.options.openBrowser(url.href);
        },
        discoveryState: () => discovery,
        saveDiscoveryState: async (value) => {
          valid();
          const metadata = value.authorizationServerMetadata;
          if (!metadata?.issuer || metadata.issuer !== value.authorizationServerUrl) throw new Error('Issuer mismatch');
          // A pre-registered secret belongs to this exact issuer/token endpoint.
          // A resource's discovery document cannot redirect it to another host.
          if (suppliedClient && (metadata.issuer !== suppliedClient.issuer || metadata.token_endpoint !== suppliedClient.tokenEndpoint)) throw new Error('OAuth client destination changed');
          allowedUrl(metadata.issuer);
          if (metadata.authorization_endpoint) allowedUrl(metadata.authorization_endpoint);
          if (metadata.token_endpoint) allowedUrl(metadata.token_endpoint);
          if (metadata.registration_endpoint) allowedUrl(metadata.registration_endpoint);
          if (!interactive && saved?.tokens.issuer !== metadata.issuer) throw new Error('Issuer changed');
          if (interactive && discovery?.authorizationServerMetadata?.issuer !== metadata.issuer) {
            if (!metadata.authorization_endpoint) throw new Error('Missing authorization endpoint');
            await new Promise<void>((resolve, reject) => {
              const abort = () => { this.consent.delete(id); reject(new Error('Authorization canceled')); };
              controller.signal.addEventListener('abort', abort, { once: true });
              this.consent.set(id, {
                view: { id: randomBytes(16).toString('hex'), resource: endpoint, issuer: metadata.issuer, authorizationOrigin: new URL(metadata.authorization_endpoint!).origin },
                approve: () => { controller.signal.removeEventListener('abort', abort); this.consent.delete(id); resolve(); },
              });
              if (controller.signal.aborted) abort();
            });
            valid();
          }
          discovery = value;
        },
        invalidateCredentials: (scope) => {
          valid();
          if (suppliedClient && (scope === 'all' || scope === 'client')) throw new Error('OAuth client rejected');
          if (scope === 'all' || scope === 'client') client = undefined;
          if (scope === 'all' || scope === 'tokens') tokens = undefined;
          if (scope === 'all' || scope === 'verifier') verifier = '';
          if (scope === 'all' || scope === 'discovery') discovery = undefined;
        },
      };
      const fetchFn: typeof fetch = async (input, init) => {
        valid(); allowedUrl(input instanceof Request ? input.url : String(input));
        const timeout = AbortSignal.timeout(10_000);
        const response = await (this.options.fetch ?? createOAuthFetch(endpoint))(input, { ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([controller.signal, timeout]) });
        if (!response.body) return response;
        let size = 0;
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, sink) {
          size += chunk.byteLength;
          if (size > 1024 * 1024) { sink.error(new Error('OAuth response too large')); return; }
          sink.enqueue(chunk);
        } }));
        const text = await new Response(body).text();
        try {
          const metadata = JSON.parse(text);
          // Only discovery documents may set callback issuer requirements;
          // registration/token responses must not weaken them.
          const source = new URL(input instanceof Request ? input.url : String(input));
          if ((init?.method ?? 'GET').toUpperCase() === 'GET' && source.pathname.includes('/.well-known/')
            && typeof metadata.issuer === 'string' && typeof metadata.authorization_endpoint === 'string') {
            issuerRequirements.set(metadata.issuer, metadata.authorization_response_iss_parameter_supported === true);
          }
        } catch { /* The SDK validates response formats. */ }
        return new Response(text || null, { status: response.status, statusText: response.statusText, headers: response.headers });
      };
      const result = await auth(provider, { serverUrl: endpoint, scope: suppliedClient?.scope, fetchFn });
      if (result === 'REDIRECT') {
        if (!callback) throw new Error('Sign in required');
        const code = await callback.code;
        valid();
        await auth(provider, { serverUrl: endpoint, authorizationCode: code, scope: suppliedClient?.scope, fetchFn });
      }
      valid();
      if (!client || !tokens || expiresAt <= Date.now()) throw new Error('Authorization incomplete');
      const record: OAuthRecord = { endpoint, redirectUrl, client, tokens, expiresAt, ...(suppliedClient ? { suppliedClient } : {}) };
      this.options.store.write(id, record);
      this.revoked.delete(id);
      if (interactive) this.revisions.set(id, this.revision(id) + 1);
      return record;
    } finally {
      this.consent.delete(id);
      clearTimeout(timer); controller.abort(); callback?.close();
      if (this.active.get(id) === controller) this.active.delete(id);
    }
  }
}
