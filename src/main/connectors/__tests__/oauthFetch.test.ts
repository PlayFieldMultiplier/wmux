import { expect, it } from 'vitest';
import type { lookup } from 'node:dns/promises';
import { createOAuthFetch, oauthLookup, publicOAuthAddress } from '../oauthFetch';
it('blocks private, metadata, transition and mapped addresses regardless of browser opt-ins', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.31.2.3', '192.168.1.2', '169.254.169.254', '100.64.0.1', '0.1.2.3', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '2001::1']) expect(publicOAuthAddress(address), address).toBe(false);
  expect(publicOAuthAddress('8.8.8.8')).toBe(true);
  expect(publicOAuthAddress('2606:4700:4700::1111')).toBe(true);
});
it('passes only validated DNS answers to the socket, refusing mixed results and later rebinding', async () => {
  let answers = [{ address: '8.8.8.8', family: 4 }];
  let calls = 0;
  const resolve = (async () => { calls++; return answers; }) as unknown as typeof lookup;
  const run = (local = false) => new Promise((yes, no) => oauthLookup(local, resolve)('provider.example', { all: true }, (error, result) => error ? no(error) : yes(result)));
  expect(await run()).toEqual(answers); expect(calls).toBe(1);
  answers = [...answers, { address: '127.0.0.1', family: 4 }];
  await expect(run()).rejects.toThrow('Unsafe');
  answers = [{ address: '10.0.0.1', family: 4 }];
  await expect(run()).rejects.toThrow('Unsafe');
  await expect(run(true)).rejects.toThrow('Unsafe');
  answers = [{ address: '127.0.0.1', family: 4 }];
  expect(await run(true)).toEqual(answers);
});
it('refuses private literal HTTPS and cross-origin local HTTP before opening a socket', async () => {
  const fetch = createOAuthFetch('https://public.example/mcp');
  for (const url of ['https://127.0.0.1/token', 'https://10.1.2.3/token', 'https://[::ffff:127.0.0.1]/token', 'http://127.0.0.1/token']) await expect(fetch(url)).rejects.toThrow('Unsafe');
});
