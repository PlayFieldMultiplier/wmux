// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import ConnectorAuthorization from '../ConnectorAuthorization';
import { en } from '../../../i18n/locales/en';
import type { ConnectorOAuthResult } from '../../../../shared/connectorOAuth';
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: keyof typeof en) => en[key] ?? key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });
it('opens registered-client settings for Google and refuses incomplete credentials without starting OAuth', async () => {
  const action = vi.fn(async () => ({ status: 'signed-out' }));
  vi.stubGlobal('electronAPI', { connectorOAuth: { action } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ConnectorAuthorization id="con-12345678" fingerprint="one" endpoint="https://gmailmcp.googleapis.com/mcp/v1" onChange={() => undefined} />));
  expect(host.querySelector('details')?.open).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
  expect(host.textContent).toContain('http://127.0.0.1:42813/oauth/callback');
  await act(async () => host.querySelector('button')?.click());
  expect(action).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledWith('status', 'con-12345678');
});
it('requires explicit sign-in and ignores late authorization after cancel', async () => {
  let finish!: (r: ConnectorOAuthResult) => void;
  const action = vi.fn((name: string) => name === 'connect' ? new Promise<ConnectorOAuthResult>((r) => { finish = r; }) : Promise.resolve({ status: 'signed-out' }));
  vi.stubGlobal('electronAPI', { connectorOAuth: { action } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ConnectorAuthorization id="con-12345678" fingerprint="one" onChange={() => undefined} />));
  expect(action).toHaveBeenCalledTimes(1); expect(action).toHaveBeenCalledWith('status', 'con-12345678');
  await act(async () => host.querySelector('button')?.click());
  expect(host.textContent).toContain('Waiting for browser authorization');
  await act(async () => host.querySelector('button')?.click());
  await act(async () => finish({ status: 'authorized' }));
  expect(host.textContent).toContain('Not signed in');
  expect(host.textContent).not.toContain('Account authorized');
});
it('shows the token recipient and issuer and approves only the displayed attempt', async () => {
  const action = vi.fn(async (name: string) => name === 'status' ? { status: 'confirm', consent: { id: 'attempt-one', resource: 'https://resource.example/mcp', issuer: 'https://issuer.example', authorizationOrigin: 'https://login.example' } } : { status: 'authorizing' });
  vi.stubGlobal('electronAPI', { connectorOAuth: { action } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ConnectorAuthorization id="con-12345678" fingerprint="one" onChange={() => undefined} />));
  expect(host.textContent).toContain('https://resource.example/mcp');
  expect(host.textContent).toContain('https://issuer.example');
  expect(host.textContent).toContain('https://login.example');
  expect(action).not.toHaveBeenCalledWith('approve', expect.anything(), expect.anything());
  await act(async () => host.querySelector('button')?.click());
  expect(action).toHaveBeenCalledWith('approve', 'con-12345678', 'attempt-one');
});
it('starts sign-in automatically for an explicitly selected expired connection', async () => {
  const action = vi.fn(async (value: string) => ({ status: value === 'status' ? 'expired' : 'authorized' }));
  vi.stubGlobal('electronAPI', { connectorOAuth: { action } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ConnectorAuthorization id="con-12345678" fingerprint="one" autoStart onChange={() => undefined} />));
  expect(action).toHaveBeenCalledWith('connect', 'con-12345678');
  expect(host.textContent).toContain(en['connectors.oauth.authorized']);
});
it('keeps a failed connect result after approving its recipient consent', async () => {
  vi.useFakeTimers();
  try {
    let finish!: (result: ConnectorOAuthResult) => void;
    let statuses = 0;
    const action = vi.fn((value: string): Promise<ConnectorOAuthResult> => {
      if (value === 'connect') return new Promise((resolve) => { finish = resolve; });
      if (value === 'approve') return Promise.resolve({ status: 'authorizing' });
      return Promise.resolve(++statuses === 1 ? { status: 'signed-out' } : { status: 'confirm', consent: { id: 'attempt', resource: 'https://example.com/mcp', issuer: 'https://example.com', authorizationOrigin: 'https://example.com' } });
    });
    vi.stubGlobal('electronAPI', { connectorOAuth: { action } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<ConnectorAuthorization id="con-12345678" fingerprint="one" autoStart onChange={() => undefined} />));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === en['connectors.oauth.approve'])!.click());
    await act(async () => finish({ status: 'failed' }));
    expect(host.textContent).toContain(en['connectors.oauth.failed']);
  } finally { vi.useRealTimers(); }
});
it('does not announce unavailable while the initial status is loading', async () => {
  let finish!: (result: ConnectorOAuthResult) => void;
  const action = vi.fn(() => new Promise<ConnectorOAuthResult>((resolve) => { finish = resolve; }));
  vi.stubGlobal('electronAPI', { connectorOAuth: { action } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ConnectorAuthorization id="con-12345678" fingerprint="one" autoStart onChange={() => undefined} />));
  expect(host.textContent).toBe('');
  await act(async () => finish({ status: 'unavailable' }));
  expect(host.textContent).toContain(en['connectors.quick.unavailable']);
});
it.each(['status', 'connect'])('retries an unavailable %s in place and still requires recipient approval', async (unavailableAt) => {
  let statuses = 0;
  let connects = 0;
  const consent = { id: 'retry-attempt', resource: 'https://resource.example/mcp', issuer: 'https://issuer.example', authorizationOrigin: 'https://login.example' };
  const action = vi.fn(async (value: string): Promise<ConnectorOAuthResult> => {
    if (value === 'status') return { status: ++statuses === 1 && unavailableAt === 'status' ? 'unavailable' : 'signed-out' };
    if (value === 'connect' && ++connects === 1 && unavailableAt === 'connect') return { status: 'unavailable' };
    return { status: 'confirm', consent };
  });
  vi.stubGlobal('electronAPI', { connectorOAuth: { action } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ConnectorAuthorization id="con-12345678" fingerprint="one" autoStart onChange={() => undefined} />));
  expect(host.textContent).toContain(en['connectors.quick.unavailable']);
  await act(async () => host.querySelector('button')?.click());
  expect(statuses).toBe(2);
  expect(action).toHaveBeenCalledWith('connect', 'con-12345678');
  expect(connects).toBe(unavailableAt === 'connect' ? 2 : 1);
  expect(host.textContent).toContain(consent.resource);
  expect(action.mock.calls.some(([value]) => value === 'approve')).toBe(false);
});
