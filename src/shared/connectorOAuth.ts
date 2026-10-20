/** OAuth status only. Tokens and authorization codes never cross renderer IPC. */
export const CONNECTOR_OAUTH_IPC = 'connectors:oauth';
export type ConnectorOAuthAction = 'status' | 'approve' | 'connect' | 'disconnect' | 'cancel';
export type ConnectorOAuthStatus = 'signed-out' | 'confirm' | 'authorizing' | 'authorized' | 'expired' | 'failed' | 'unavailable' | 'busy';
export interface ConnectorOAuthResult { status: ConnectorOAuthStatus; consent?: { id: string; resource: string; issuer: string; authorizationOrigin: string } }

/** Sent only on explicit sign-in. Persisted only in the encrypted OAuth record. */
export interface ConnectorOAuthClient {
  clientId: string;
  clientSecret?: string;
  issuer: string;
  tokenEndpoint: string;
  callbackPort: number;
  scope?: string;
  offlineAccess?: boolean;
  tokenAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
}
export function parseConnectorOAuthClient(value: unknown): ConnectorOAuthClient | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const text = (x: unknown, max: number) => typeof x === 'string' && x.length > 0 && x.length <= max && ![...x].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  const https = (x: unknown) => {
    if (!text(x, 2048)) return false;
    try { const u = new URL(x as string); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search; } catch { return false; }
  };
  if (!text(v.clientId, 2048) || !https(v.issuer) || !https(v.tokenEndpoint)
    || !Number.isInteger(v.callbackPort) || (v.callbackPort as number) < 1024 || (v.callbackPort as number) > 65535
    || (v.scope !== undefined && v.scope !== '' && !text(v.scope, 4096))
    || (v.offlineAccess !== undefined && typeof v.offlineAccess !== 'boolean')
    || !['none', 'client_secret_post', 'client_secret_basic'].includes(v.tokenAuthMethod as string)
    || (v.clientSecret !== undefined && v.clientSecret !== '' && !text(v.clientSecret, 4096))
    || (v.tokenAuthMethod !== 'none' && !v.clientSecret)) return undefined;
  return {
    clientId: v.clientId as string, issuer: v.issuer as string, tokenEndpoint: v.tokenEndpoint as string,
    callbackPort: v.callbackPort as number, tokenAuthMethod: v.tokenAuthMethod as ConnectorOAuthClient['tokenAuthMethod'],
    ...(v.clientSecret ? { clientSecret: v.clientSecret as string } : {}),
    ...(v.scope ? { scope: v.scope as string } : {}), offlineAccess: v.offlineAccess === true,
  };
}
