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
