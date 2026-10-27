import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendDaemonStringRequestMock } = vi.hoisted(() => ({
  sendDaemonStringRequestMock: vi.fn(),
}));

vi.mock('../client', () => ({
  sendDaemonStringRequest: sendDaemonStringRequestMock,
}));

import { handleWeb } from '../commands/web';

let lines: string[];

beforeEach(() => {
  lines = [];
  sendDaemonStringRequestMock.mockReset();
  for (const stream of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const proxy = { header: 'x-auth-request-email', user: 'me@example.com', from: ['10.0.0.2', 'fd00::2'] };
const response = (extra: Record<string, unknown> = {}) => ({
  id: 'web',
  ok: true as const,
  result: {
    running: true, port: 7681, host: '0.0.0.0', allowInput: false, allowUpload: false, allowTranscript: false,
    tls: false, token: 'token-for-test', urls: ['http://192.168.1.10:7681/?token=token-for-test'], ...extra,
  },
});
const startParams = () =>
  sendDaemonStringRequestMock.mock.calls.find((c) => c[0] === 'daemon.web.start')?.[1] as Record<string, unknown> | undefined;

describe('wmux web --trust-proxy-*', () => {
  it('sends the settings normalized and says sign-in is on', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response({ trustedProxy: proxy }));
    await handleWeb([
      '--expose',
      '--trust-proxy-header', 'X-Auth-Request-Email',
      '--trust-proxy-user', 'Me@Example.com',
      '--trust-proxy-from', '::ffff:10.0.0.2, FD00:0:0::2',
    ], false);
    expect(startParams()?.trustedProxy).toEqual(proxy);
    expect(lines.join('\n')).toContain('trusted proxy sign-in: me@example.com in x-auth-request-email from 10.0.0.2, fd00::2');
  });

  it('refuses a partial or invalid set before starting anything', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response());
    await expect(handleWeb(['--expose', '--trust-proxy-header', 'X-Auth-Request-Email', '--trust-proxy-user', 'me@example.com'], false))
      .rejects.toThrow('exit 1');
    await expect(handleWeb(['--expose', '--trust-proxy-header', 'Cookie', '--trust-proxy-user', 'me@example.com', '--trust-proxy-from', '10.0.0.2'], false))
      .rejects.toThrow('exit 1');
    expect(startParams()).toBeUndefined();
    expect(lines.join('\n')).toContain('missing: --trust-proxy-from');
  });

  it('does not keep it on a re-run without the flags', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response({ trustedProxy: proxy }));
    await handleWeb(['--allow-input'], false);
    expect(startParams()).toBeDefined();
    expect(startParams()).not.toHaveProperty('trustedProxy');
  });
});
