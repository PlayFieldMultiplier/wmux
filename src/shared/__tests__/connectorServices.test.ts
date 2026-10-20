import { expect, it } from 'vitest';
import { CONNECTOR_SERVICES, serviceConnectorDraft } from '../connectorServices';
import { parseConnectorOAuthClient } from '../connectorOAuth';

it('ships distinct reviewed HTTPS recipes without automatic access', () => {
  expect(CONNECTOR_SERVICES).toHaveLength(24);
  expect(new Set(CONNECTOR_SERVICES.map((s) => s.id)).size).toBe(24);
  expect(CONNECTOR_SERVICES.filter((s) => s.setup === 'google')).toHaveLength(9);
  for (const service of CONNECTOR_SERVICES) {
    expect(new URL(service.url).protocol).toBe('https:');
    expect(new URL(service.documentation).protocol).toBe('https:');
    const draft = serviceConnectorDraft(service);
    expect(draft.enabled).toBe(false);
    expect(draft.scope).toEqual({ kind: 'bots', botIds: [] });
    expect(draft.tools).toEqual({ mode: 'listed', allowed: [] });
    draft.remote!.headers.extra = 'changed';
    expect(serviceConnectorDraft(service).remote!.headers).toEqual({});
  }
});
it('keeps PayPal on sandbox and Supabase read-only by default', () => {
  expect(CONNECTOR_SERVICES.find((s) => s.id === 'paypal')?.url).toBe('https://mcp.sandbox.paypal.com');
  expect(CONNECTOR_SERVICES.find((s) => s.id === 'supabase')?.url).toContain('read_only=true');
});
const client = { clientId: 'app', clientSecret: 'secret', issuer: 'https://issuer.example', tokenEndpoint: 'https://tokens.example/token', callbackPort: 42813, tokenAuthMethod: 'client_secret_post' };
it('validates manual clients before any authentication side effect', () => {
  expect(parseConnectorOAuthClient(client)).toMatchObject(client);
  for (const invalid of [
    { clientId: '' }, { clientSecret: '' }, { issuer: 'http://issuer.example' },
    { tokenEndpoint: 'https://u:p@issuer.example/token' }, { tokenEndpoint: 'https://issuer.example/token?secret=x' },
    { callbackPort: 0 }, { callbackPort: 65536 }, { callbackPort: 1.5 },
    { scope: 'read\nwrite' }, { clientSecret: 'secret\r\nheader' }, { tokenAuthMethod: 'unknown' },
  ]) expect(parseConnectorOAuthClient({ ...client, ...invalid })).toBeUndefined();
  expect(parseConnectorOAuthClient({ ...client, clientSecret: '', tokenAuthMethod: 'none', scope: '' })).not.toHaveProperty('clientSecret');
});
