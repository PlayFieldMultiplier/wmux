import { describe, it, expect, vi } from 'vitest';
import { createLeave, startingSession, WEB_TOKEN_KEY, type LeaveEnv, type WebSession } from '../webCredential';
import { CLASSIC_PATH } from '../webElectronApi';

// What a fetch with `redirect: 'manual'` gets when a sign-in proxy answers 302
// to its identity provider. Node's Response cannot be built with status 0.
const opaqueRedirect = () => ({ type: 'opaqueredirect', status: 0, ok: false }) as Response;

function memoryStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

function env(seed: Record<string, string> = {}) {
  return {
    location: { reload: vi.fn(), replace: vi.fn() },
    localStorage: memoryStorage(seed),
    sessionStorage: memoryStorage(),
  } satisfies LeaveEnv;
}

describe('the session a load starts with', () => {
  it('uses a token from the URL or storage as is, without asking the daemon', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(startingSession({ fromUrl: 'secret', stored: 'secret' }, fetchImpl)).resolves.toEqual({
      credential: { kind: 'operator', token: 'secret' },
      storedToken: false,
    });
    await expect(startingSession({ fromUrl: '', stored: 'dev1.secret' }, fetchImpl)).resolves.toEqual({
      credential: { kind: 'device', token: 'dev1.secret' },
      storedToken: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with no token, a 200 from /api/config means a sign-in proxy vouches for this browser', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(startingSession({ fromUrl: '', stored: '' }, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      credential: { kind: 'proxy' },
      storedToken: false,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/config');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(init.redirect).toBe('manual');
    expect(init.cache).toBe('no-store');
  });

  it('with no token, a 401, a redirect to the sign-in provider or no answer sends the page to the classic client', async () => {
    const answers: Array<() => Promise<Response>> = [
      async () => new Response('', { status: 401 }),
      async () => opaqueRedirect(),
      async () => { throw new TypeError('down'); },
    ];
    for (const answer of answers) {
      await expect(startingSession({ fromUrl: '', stored: '' }, answer as unknown as typeof fetch)).resolves.toBeNull();
    }
  });
});

describe('leaving after the daemon refuses the page', () => {
  it('a proxy session reloads, so the navigation goes through the sign-in, once', () => {
    const e = env();
    const leave = createLeave({ credential: { kind: 'proxy' }, storedToken: false }, e);
    leave();
    leave();
    expect(e.location.reload).toHaveBeenCalledTimes(1);
    expect(e.location.replace).not.toHaveBeenCalled();
  });

  it('a refused stored token is dropped and the page boots again from /, and never twice in a tab', () => {
    const e = env({ [WEB_TOKEN_KEY]: 'old' });
    const session: WebSession = { credential: { kind: 'operator', token: 'old' }, storedToken: true };
    createLeave(session, e)();
    expect(e.location.replace.mock.calls).toEqual([['/']]);
    expect(e.localStorage.getItem(WEB_TOKEN_KEY)).toBeNull();

    // The reloaded page finds a refused stored token again (another tab wrote it back).
    e.localStorage.setItem(WEB_TOKEN_KEY, 'old');
    e.location.replace.mockClear();
    createLeave(session, e)();
    expect(e.location.replace.mock.calls).toEqual([[CLASSIC_PATH]]);
    expect(e.location.reload).not.toHaveBeenCalled();
  });

  it('a refused token from this load\'s URL goes to the classic page', () => {
    const e = env({ [WEB_TOKEN_KEY]: 'typo' });
    createLeave({ credential: { kind: 'operator', token: 'typo' }, storedToken: false }, e)();
    expect(e.location.replace.mock.calls).toEqual([[CLASSIC_PATH]]);
  });
});
