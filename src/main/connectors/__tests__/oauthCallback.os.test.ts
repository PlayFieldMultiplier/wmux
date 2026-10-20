import { get } from 'node:http';
import { expect, it } from 'vitest';
import { createOAuthCallback } from '../oauthCallback';

it('rejects a malformed request target without crashing or consuming the pending login', async () => {
  const controller = new AbortController();
  const callback = await createOAuthCallback('expected-state', controller.signal, () => true);
  try {
    const address = new URL(callback.redirectUrl);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = get({ hostname: address.hostname, port: address.port, path: '//[' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
    });
    expect(status).toBe(400);
    address.search = new URLSearchParams({ state: 'expected-state', code: 'valid-code' }).toString();
    expect((await fetch(address)).status).toBe(200);
    expect(await callback.code).toBe('valid-code');
  } finally { callback.close(); }
});
