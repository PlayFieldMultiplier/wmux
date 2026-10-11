import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayTransport } from '../RelayTransport';

describe('RelayTransport URL safety', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('refuses unsafe URLs before any secret-bearing fetch or retry', async () => {
    for (const relayUrl of [
      'http://relay.example', 'ftp://localhost', 'not a URL',
      'http://localhost.example', 'http://127.0.0.1.example',
      'http://[::ffff:192.0.2.1]',
    ]) {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const sleep = vi.fn(async () => undefined);
      const transport = new RelayTransport({ relayUrl, relaySecret: 'secret', fetchImpl, sleep });
      expect(transport.enabled).toBe(false);
      expect(await transport.post('/push', {})).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it('warns once about unsafe configuration without exposing the URL or secret', async () => {
    const log = vi.fn();
    const transport = new RelayTransport({ relayUrl: 'http://relay.example/private?token=hidden', relaySecret: 'sensitive-secret', log });
    await transport.post('/push', {});
    await transport.post('/push', {});
    expect(log).toHaveBeenCalledExactlyOnceWith('warn', '[push] relay disabled: URL must use HTTPS or HTTP loopback');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/relay\.example|hidden|sensitive-secret/);
  });

  it('does not fetch or retry without a secret or with the push kill switch', async () => {
    for (const disabled of ['no-secret', 'kill-switch']) {
      vi.stubEnv('WMUX_PUSH', disabled === 'kill-switch' ? '0' : '1');
      const fetchImpl = vi.fn();
      const sleep = vi.fn();
      const log = vi.fn();
      const transport = new RelayTransport({ relayUrl: 'https://relay.example', relaySecret: disabled === 'no-secret' ? undefined : 'secret', fetchImpl, sleep, log });
      expect(transport.enabled).toBe(false);
      expect(await transport.post('/push', {})).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    }
  });

  it('allows HTTPS and HTTP loopback while retaining manual redirects', async () => {
    for (const relayUrl of ['https://relay.example', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const transport = new RelayTransport({ relayUrl, relaySecret: 'secret', fetchImpl });
      expect(transport.enabled).toBe(true);
      expect(await transport.post('/push', {})).toBe(200);
      expect(fetchImpl).toHaveBeenCalledWith(`${relayUrl}/push`, expect.objectContaining({
        redirect: 'manual', headers: expect.objectContaining({ authorization: 'Bearer secret' }),
      }));
    }
  });
});

describe('RelayTransport refusal detail', () => {
  const STAGE = 'x-wmux-relay-stage';
  function refusal(status: number, body: string, stage?: string): Response {
    return new Response(body, { status, headers: stage ? { [STAGE]: stage } : {} });
  }
  function harness(replies: Response[]) {
    const log = vi.fn();
    let i = 0;
    const fetchImpl = vi.fn(async () => replies[Math.min(i++, replies.length - 1)]);
    const transport = new RelayTransport({ relayUrl: 'https://relay.example', relaySecret: 'secret', fetchImpl, sleep: async () => undefined, log });
    const warns = () => log.mock.calls.filter(([level]) => level === 'warn').map(([, m]) => m as string);
    return { transport, warns };
  }
  async function refuse(h: ReturnType<typeof harness>, subject = 'dev-1'): Promise<number | null> {
    const status = await h.transport.post('/push', { apnsDeviceToken: 'tok-secret' });
    h.transport.noteFailure(subject, status);
    return status;
  }

  it('logs the reason and the stage that refused', async () => {
    const h = harness([refusal(403, JSON.stringify({ ok: false, apnsStatus: 403, reason: 'InvalidProviderToken' }), 'apns')]);
    expect(await refuse(h)).toBe(403);
    expect(h.warns()).toEqual(['[push] relay answered 403 (apns: InvalidProviderToken) for dev-1']);
    expect(h.warns().join('')).not.toContain('tok-secret');
  });

  it('logs a relay-side reason and drops an unknown stage', async () => {
    const h = harness([refusal(400, JSON.stringify({ ok: false, reason: 'bad-json' }), 'elsewhere')]);
    await refuse(h);
    expect(h.warns()).toEqual(['[push] relay answered 400 (bad-json) for dev-1']);
  });

  it('never echoes a reason of the wrong shape', async () => {
    for (const reason of ['Bad Device', 'Bad\nInjected line', 'A'.repeat(65), '-leading', 42]) {
      const h = harness([refusal(403, JSON.stringify({ ok: false, reason }), 'apns')]);
      await refuse(h);
      expect(h.warns()).toEqual(['[push] relay answered 403 (apns) for dev-1']);
    }
  });

  it('logs the status alone for a body that is not JSON, too long, or absent', async () => {
    for (const body of ['<html>nope</html>', JSON.stringify({ reason: 'BadDeviceToken', pad: 'x'.repeat(2000) }), '']) {
      const h = harness([refusal(403, body)]);
      expect(await refuse(h)).toBe(403);
      expect(h.warns()).toEqual(['[push] relay answered 403 for dev-1']);
    }
  });

  it('logs again when the status repeats with a new reason, but not for a repeat of both', async () => {
    const h = harness([
      refusal(403, JSON.stringify({ reason: 'BadDeviceToken' }), 'apns'),
      refusal(403, JSON.stringify({ reason: 'BadDeviceToken' }), 'apns'),
      refusal(403, JSON.stringify({ reason: 'ExpiredProviderToken' }), 'apns'),
    ]);
    await refuse(h);
    await refuse(h);
    await refuse(h);
    expect(h.warns()).toEqual([
      '[push] relay answered 403 (apns: BadDeviceToken) for dev-1',
      '[push] relay answered 403 (apns: ExpiredProviderToken) for dev-1',
    ]);
  });

  it('keeps the detail of the attempt that was returned after a 5xx retry', async () => {
    const h = harness([
      refusal(502, JSON.stringify({ reason: 'apns-timeout' }), 'relay'),
      refusal(403, JSON.stringify({ reason: 'BadDeviceToken' }), 'apns'),
    ]);
    expect(await refuse(h)).toBe(403);
    expect(h.warns()).toEqual(['[push] relay answered 403 (apns: BadDeviceToken) for dev-1']);
  });
});
