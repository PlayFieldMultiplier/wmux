import { describe, it, expect, vi } from 'vitest';
import {
  decideTrustedProxy,
  parseTrustedProxyConfig,
  rawHeaderValues,
  type NormalizedIp,
  type TrustedProxyDecision,
  type TrustedProxyRequest,
} from '../trustedProxy';

const config = parseTrustedProxyConfig({
  header: 'X-Auth-Request-Email',
  user: 'Me@Example.com',
  from: ['10.0.0.2', 'fd00::2'],
});

const HOST = 'wmux.example.com';
const request = (over: Partial<TrustedProxyRequest> = {}, extraHeaders: string[] = []): TrustedProxyRequest => ({
  remoteAddress: '10.0.0.2',
  rawHeaders: ['Host', HOST, 'X-Auth-Request-Email', 'me@example.com', ...extraHeaders],
  method: 'GET',
  hostHeader: HOST,
  queryCredential: false,
  ...over,
});
const withHeaders = (rawHeaders: string[], over: Partial<TrustedProxyRequest> = {}): TrustedProxyRequest =>
  request({ rawHeaders: ['Host', HOST, ...rawHeaders], ...over });

const accepted: TrustedProxyDecision = { kind: 'accepted', user: 'me@example.com' };
const refused = (reason: string) => ({ kind: 'refused', reason });
const notApplicable = (why: string) => ({ kind: 'not-applicable', why });

describe('decideTrustedProxy', () => {
  const cases: Array<[string, TrustedProxyRequest, unknown]> = [
    ['the proxy with the operator identity', request(), accepted],
    ['an IPv4-mapped peer', request({ remoteAddress: '::ffff:10.0.0.2' }), accepted],
    ['an IPv6 peer in another spelling', request({ remoteAddress: 'FD00:0:0:0:0:0:0:2' }), accepted],
    ['an identity with whitespace and capitals', withHeaders(['X-Auth-Request-Email', '  ME@Example.COM ']), accepted],
    ['a GET without Origin', request(), accepted],
    ['sec-fetch-site same-origin', request({}, ['Sec-Fetch-Site', 'same-origin']), accepted],
    ['sec-fetch-site none', request({}, ['Sec-Fetch-Site', 'none']), accepted],
    ['a POST whose Origin matches Host with a port',
      withHeaders(['X-Auth-Request-Email', 'me@example.com', 'Origin', 'https://wmux.example.com:8443'], { method: 'POST', hostHeader: 'wmux.example.com:8443' }),
      accepted],
    ['a HEAD without Origin', request({ method: 'HEAD' }), accepted],

    ['a Bearer credential', request({}, ['Authorization', 'Bearer abc']), notApplicable('credential-presented')],
    ['a Basic credential', request({}, ['Authorization', 'Basic eDp5']), notApplicable('credential-presented')],
    ['an empty Authorization', request({}, ['Authorization', '']), notApplicable('credential-presented')],
    ['a lowercase authorization header', request({}, ['authorization', 'whatever']), notApplicable('credential-presented')],
    ['Authorization twice', request({}, ['Authorization', 'Bearer a', 'Authorization', 'Bearer b']), notApplicable('credential-presented')],
    ['a token or ticket in the query', request({ queryCredential: true }), notApplicable('credential-presented')],
    ['a credential from an unknown peer', request({ remoteAddress: '10.0.0.9' }, ['Authorization', 'Basic x']), notApplicable('credential-presented')],
    ['an unknown peer', request({ remoteAddress: '10.0.0.9' }), notApplicable('untrusted-peer')],
    ['a peer with no address', request({ remoteAddress: undefined }), notApplicable('untrusted-peer')],
    ['a peer with a zone id', request({ remoteAddress: 'fd00::2%eth0' }), notApplicable('untrusted-peer')],

    ['no identity header', withHeaders([]), refused('identity-missing')],
    ['the identity header twice in different case',
      withHeaders(['X-Auth-Request-Email', 'me@example.com', 'x-auth-request-email', 'me@example.com']),
      refused('identity-duplicated')],
    ['a joined identity value', withHeaders(['X-Auth-Request-Email', 'me@example.com, other@example.com']), refused('identity-mismatch')],
    ['another user', withHeaders(['X-Auth-Request-Email', 'other@example.com']), refused('identity-mismatch')],
    ['sec-fetch-site cross-site', request({}, ['Sec-Fetch-Site', 'cross-site']), refused('cross-site')],
    ['sec-fetch-site same-site', request({}, ['Sec-Fetch-Site', 'same-site']), refused('cross-site')],
    ['sec-fetch-site duplicated', request({}, ['Sec-Fetch-Site', 'same-origin', 'sec-fetch-site', 'same-origin']), refused('cross-site')],
    ['a POST without Origin', request({ method: 'POST' }), refused('origin-missing')],
    ['a request with no method and no Origin', request({ method: undefined }), refused('origin-missing')],
    ['a POST with Origin null', request({ method: 'POST' }, ['Origin', 'null']), refused('origin-not-allowed')],
    ['a POST with an unparseable Origin', request({ method: 'POST' }, ['Origin', 'not a url']), refused('origin-not-allowed')],
    ['a POST with Origin on another port', request({ method: 'POST' }, ['Origin', 'https://wmux.example.com:8443']), refused('origin-not-allowed')],
    ['a POST with Origin on another host', request({ method: 'POST' }, ['Origin', 'https://evil.example']), refused('origin-not-allowed')],
    ['a POST with Origin twice',
      request({ method: 'POST' }, ['Origin', `https://${HOST}`, 'Origin', `https://${HOST}`]),
      refused('origin-not-allowed')],
  ];

  it.each(cases)('%s', (_name, req, expected) => {
    expect(decideTrustedProxy(config, req, { isOwnAddress: () => false })).toEqual(expected);
  });

  it('is off without a config', () => {
    expect(decideTrustedProxy(undefined, request(), { isOwnAddress: () => false })).toEqual(notApplicable('off'));
  });

  it('refuses a listed peer that is this machine', () => {
    const isOwnAddress = vi.fn((ip: NormalizedIp) => ip === '10.0.0.2');
    expect(decideTrustedProxy(config, request(), { isOwnAddress })).toEqual(refused('peer-is-local'));
    expect(isOwnAddress).toHaveBeenCalledWith('10.0.0.2');
  });

  it('never asks about this machine for a peer that is not a listed proxy', () => {
    const isOwnAddress = vi.fn(() => false);
    expect(decideTrustedProxy(config, request({ remoteAddress: '10.0.0.9' }), { isOwnAddress })).toEqual(notApplicable('untrusted-peer'));
    expect(isOwnAddress).not.toHaveBeenCalled();
  });

  it('accepts a loopback proxy only under the test switch', () => {
    const local = parseTrustedProxyConfig({ header: 'x-email', user: 'me@example.com', from: ['127.0.0.1'] }, { localPeerForTests: true });
    const req = { ...withHeaders(['x-email', 'me@example.com']), remoteAddress: '127.0.0.1' };
    expect(decideTrustedProxy(local, req, { isOwnAddress: () => true })).toEqual(accepted);
  });
});

describe('parseTrustedProxyConfig', () => {
  const valid = { header: 'X-Auth-Request-Email', user: 'me@example.com', from: ['10.0.0.2'] };
  const parse = (over: Record<string, unknown>) => () => parseTrustedProxyConfig({ ...valid, ...over });

  it('is off when absent', () => {
    expect(parseTrustedProxyConfig(undefined)).toBeUndefined();
    expect(parseTrustedProxyConfig(null)).toBeUndefined();
  });

  it('normalizes the header, the user and every address', () => {
    const parsed = parseTrustedProxyConfig({
      header: ' X-Auth-Request-Email ',
      user: '  Me@Example.COM ',
      from: ['::FFFF:10.0.0.2', ' FD00:0:0::2/128 ', '10.0.0.3/32'],
    });
    expect(parsed?.header).toBe('x-auth-request-email');
    expect(parsed?.user).toBe('me@example.com');
    expect([...(parsed?.from ?? [])]).toEqual(['10.0.0.2', 'fd00::2', '10.0.0.3']);
    expect(parsed?.localPeerForTests).toBe(false);
  });

  it('needs all three settings together', () => {
    expect(() => parseTrustedProxyConfig({ header: 'x-email', user: 'me@example.com' })).toThrow(/missing: --trust-proxy-from/);
    expect(() => parseTrustedProxyConfig({})).toThrow(/--trust-proxy-header, --trust-proxy-user, --trust-proxy-from/);
    expect(() => parseTrustedProxyConfig('x-email')).toThrow(/together/);
  });

  it.each(['', 'X Auth', 'x-email:', 'Authorization', 'proxy-authorization', 'Cookie', 'host', 'Origin', 'Sec-Fetch-Site', 'sec-anything',
    'Connection', 'keep-alive', 'te', 'trailer', 'Transfer-Encoding', 'upgrade'])('refuses the header %j', (header) => {
    expect(parse({ header })).toThrow(/--trust-proxy-header/);
  });

  it.each(['', 'me', 'me@', '@example.com', 'a@example.com, b@example.com', 'me @example.com', 42])('refuses the user %j', (user) => {
    expect(parse({ user })).toThrow(/--trust-proxy-user/);
  });

  it.each([
    [[]],
    [['  ']],
    ['10.0.0.2'],
    [['10.0.0.0/24']],
    [['fd00::/64']],
    [['10.0.0.2/128']],
    [['127.0.0.1']],
    [['::1']],
    [['::ffff:127.0.0.1']],
    [['0.0.0.0']],
    [['::']],
    [['fe80::1%en0']],
    [['proxy.internal']],
  ])('refuses from %j', (from) => {
    expect(parse({ from })).toThrow(/--trust-proxy-from/);
  });
});

describe('rawHeaderValues', () => {
  it('returns every copy, any case, in order', () => {
    expect(rawHeaderValues(['A', '1', 'b', 'x', 'a', '2', 'A', ''], 'a')).toEqual(['1', '2', '']);
  });
});
