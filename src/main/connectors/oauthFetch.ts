import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isConnectorUrl } from '../../shared/botConnector';

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) denied.addSubnet(address, prefix, 'ipv6');
export function publicOAuthAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}
function localHost(host: string): boolean { return ['localhost', '127.0.0.1', '[::1]'].includes(host); }
/** Checks the actual socket lookup answers, which are used directly without a second resolution. */
export function oauthLookup(allowLocal: boolean, resolve = lookup): LookupFunction {
  return (host, options, callback) => {
    void resolve(host, { all: true, verbatim: true }).then((answers) => {
      const permitted = (address: string) => publicOAuthAddress(address) || (allowLocal && ['127.0.0.1', '::1'].includes(address));
      if (!answers.length || answers.some((a) => !permitted(a.address))) { callback(new Error('Unsafe OAuth address'), []); return; }
      const candidates = options.family ? answers.filter((a) => a.family === options.family) : answers;
      if (!candidates.length) { callback(new Error('No OAuth address'), []); return; }
      if (options.all) callback(null, candidates);
      else callback(null, candidates[0].address, candidates[0].family);
    }, () => callback(new Error('OAuth resolution failed'), []));
  };
}
/** Bounded, redirect-free OAuth transport. Private targets require an explicitly saved loopback origin. */
export function createOAuthFetch(endpoint: string): typeof fetch {
  const saved = new URL(endpoint);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const allowLocal = localHost(saved.hostname) && url.origin === saved.origin;
    if (!isConnectorUrl(url.href) || (url.protocol !== 'https:' && !allowLocal)) throw new Error('Unsafe OAuth URL');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !publicOAuthAddress(host) && !(allowLocal && ['127.0.0.1', '::1'].includes(host))) throw new Error('Unsafe OAuth address');
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    if (body && body.length > 1024 * 1024) throw new Error('OAuth request too large');
    return new Promise<Response>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: request.method, headers: Object.fromEntries(request.headers),
        lookup: oauthLookup(allowLocal), agent: false, signal: request.signal,
      }, (res) => {
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { res.destroy(new Error('OAuth response too large')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode ?? 500;
          if (status >= 300 && status < 400) { reject(new Error('OAuth redirects refused')); return; }
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          try { resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers })); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  };
}
