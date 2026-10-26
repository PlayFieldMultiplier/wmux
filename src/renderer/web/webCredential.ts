/**
 * How the browser app proves who it is to the daemon, shared by boot.ts (the
 * es2017 first script) and the bundle (main.tsx, webPty, webSync).
 *
 *  - operator / device: a bearer token, from `?token=` or local storage.
 *  - proxy: no token at all. A sign-in proxy in front of the daemon (wmux web
 *    --trust-proxy-*) vouches for the caller; the page sends no Authorization
 *    header and its cookies ride along. When that sign-in expires the proxy
 *    answers with a redirect to its identity provider, which a fetch with
 *    `redirect: 'manual'` sees as an `opaqueredirect`.
 */
import { CLASSIC_PATH } from './webElectronApi';

export const WEB_TOKEN_KEY = 'wmux-web-token';
const STALE_TOKEN_RELOAD_KEY = 'wmux-web-stale-token-reload';
const SIGN_IN_RELOAD_KEY = 'wmux-web-sign-in-reload-at';
/** A second refusal this soon after a sign-in reload means reloading does not help. */
const SIGN_IN_RELOAD_GAP_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

export type WebCredential =
  | { kind: 'operator'; token: string }
  | { kind: 'device'; token: string }
  | { kind: 'proxy' };

/** What boot hands the bundle. `storedToken`: the token came from storage, not this load's URL. */
export interface WebSession {
  credential: WebCredential;
  storedToken: boolean;
}

/** A device credential is `<deviceId>.<secret>`; the operator token has no dot. */
export function credentialOf(token: string): WebCredential {
  return token.includes('.') ? { kind: 'device', token } : { kind: 'operator', token };
}

/** The headers and redirect policy every API request carries for this credential. */
export function requestInitFor(credential: WebCredential, headers: Record<string, string> = {}): RequestInit {
  if (credential.kind === 'proxy') return { headers, redirect: 'manual' };
  return { headers: { ...headers, Authorization: `Bearer ${credential.token}` } };
}

/** The daemon refused the caller, or the sign-in proxy sent it back to its provider. */
export function isRefused(res: Response): boolean {
  return res.status === 401 || res.type === 'opaqueredirect';
}

/** Whether the daemon admits this page with no token at all (a trusted sign-in proxy). */
export async function probeProxySession(fetchImpl: typeof fetch): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl('/api/config', { cache: 'no-store', redirect: 'manual', signal: ctl.signal });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The session this load starts with, or null when it has none (→ the classic page). */
export async function startingSession(
  tokens: { fromUrl: string; stored: string },
  fetchImpl: typeof fetch,
): Promise<WebSession | null> {
  const token = tokens.fromUrl || tokens.stored;
  if (token) return { credential: credentialOf(token), storedToken: !tokens.fromUrl };
  return (await probeProxySession(fetchImpl)) ? { credential: { kind: 'proxy' }, storedToken: false } : null;
}

export interface LeaveEnv {
  location: { reload(): void; replace(url: string): void };
  localStorage: Pick<Storage, 'removeItem'>;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
  fetch: typeof fetch;
  now?: () => number;
}

/**
 * The one way out once the daemon refuses this page; runs at most once.
 *  - proxy: reload, so the navigation goes through the sign-in again, unless
 *    the last such reload was moments ago (a reload loop).
 *  - a stored token that a sign-in proxy would replace: drop it and boot again
 *    from `/` (once per tab). Kept otherwise, so the classic page can still
 *    say why it was refused (a revoked device, a new operator token).
 *  - otherwise: the classic page, which owns the token form and pairing.
 */
export function createLeave(session: WebSession, env: LeaveEnv): () => void {
  let left = false;
  return () => {
    if (left) return;
    left = true;
    if (session.credential.kind === 'proxy') {
      if (mayReloadForSignIn(env)) env.location.reload();
      else env.location.replace(CLASSIC_PATH);
      return;
    }
    if (!session.storedToken) {
      env.location.replace(CLASSIC_PATH);
      return;
    }
    void probeProxySession(env.fetch).then((proxied) => {
      env.location.replace(proxied && dropStaleToken(env) ? '/' : CLASSIC_PATH);
    });
  };
}

function mayReloadForSignIn(env: LeaveEnv): boolean {
  const now = (env.now ?? Date.now)();
  try {
    const last = Number(env.sessionStorage.getItem(SIGN_IN_RELOAD_KEY));
    if (last && now - last < SIGN_IN_RELOAD_GAP_MS) return false;
    env.sessionStorage.setItem(SIGN_IN_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

function dropStaleToken(env: LeaveEnv): boolean {
  try {
    if (env.sessionStorage.getItem(STALE_TOKEN_RELOAD_KEY)) return false;
    env.sessionStorage.setItem(STALE_TOKEN_RELOAD_KEY, '1');
    env.localStorage.removeItem(WEB_TOKEN_KEY);
    return true;
  } catch {
    return false;
  }
}
