import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateResolvedNavigationUrl } from '../navigationPolicy';
import type { NavigationPolicyOptions } from '../../../shared/types';

// #1359: the resolved check no longer keeps its own copy of the ranges — it
// delegates to the shared policy, so it also reports the shared policy's
// reasons, opt-in hint included.
const PRIVATE_HINT =
  ' — to allow private ranges, turn on Settings → Browser → Allow private network addresses ' +
  '(or set WMUX_ALLOW_PRIVATE_NETWORK=1 in the environment that launches wmux)';

const OFF: NavigationPolicyOptions = { allowPrivateNetwork: false };
const ON: NavigationPolicyOptions = { allowPrivateNetwork: true };

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}));

describe('validateResolvedNavigationUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows public resolved addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await expect(validateResolvedNavigationUrl('https://example.com', OFF)).resolves.toEqual({ valid: true });
  });

  it('blocks hostnames that resolve to private IPv4 space', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.1.25', family: 4 }]);

    await expect(validateResolvedNavigationUrl('https://internal.example', OFF)).resolves.toEqual({
      valid: false,
      reason: `Blocked resolved address 192.168.1.25: Blocked private IP address (192.168.0.0/16)${PRIVATE_HINT}`,
    });
  });

  it('blocks hostnames that resolve to cloud metadata space', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(validateResolvedNavigationUrl('https://metadata.example', OFF)).resolves.toEqual({
      valid: false,
      reason: 'Blocked resolved address 169.254.169.254: Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
  });

  it('blocks mixed resolution results when any resolved address is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.9', family: 4 },
    ]);

    await expect(validateResolvedNavigationUrl('https://mixed.example', OFF)).resolves.toEqual({
      valid: false,
      reason: `Blocked resolved address 10.0.0.9: Blocked private IP address (10.0.0.0/8)${PRIVATE_HINT}`,
    });
  });

  // #1359 — the two copies had drifted: the main-local one allowed every
  // 127.x.x.x address, while the shared literal check allows only 127.0.0.1.
  // One policy now answers both, so a hostname that resolves to a loopback
  // alias gets the same verdict as typing that alias.
  it('applies the shared loopback rule to resolved addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(validateResolvedNavigationUrl('https://dev.example', OFF)).resolves.toEqual({ valid: true });

    lookupMock.mockResolvedValue([{ address: '127.0.0.2', family: 4 }]);
    await expect(validateResolvedNavigationUrl('https://alias.example', OFF)).resolves.toEqual({
      valid: false,
      reason: 'Blocked resolved address 127.0.0.2: Blocked loopback address',
    });
  });

  it('allows localhost without DNS resolution', async () => {
    await expect(validateResolvedNavigationUrl('http://localhost:3000', OFF)).resolves.toEqual({ valid: true });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks private IPv6 targets after hostname resolution', async () => {
    lookupMock.mockResolvedValue([{ address: 'fd12:3456:789a::1', family: 6 }]);

    await expect(validateResolvedNavigationUrl('https://ipv6.example', OFF)).resolves.toEqual({
      valid: false,
      reason: `Blocked resolved address fd12:3456:789a::1: Blocked private IPv6 address (fc00::/7)${PRIVATE_HINT}`,
    });
  });

  it('blocks IPv6-mapped IPv4 targets after hostname resolution', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:169.254.169.254', family: 6 }]);

    await expect(validateResolvedNavigationUrl('https://mapped-ipv4.example', OFF)).resolves.toEqual({
      valid: false,
      // The shared policy names the embedded form it unwrapped; the old
      // main-local copy reported only the inner verdict.
      reason:
        'Blocked resolved address ::ffff:169.254.169.254: Blocked IPv4-mapped/compatible IPv6: ' +
        'embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
  });

  it('blocks private IPv6 literal URLs before DNS resolution', async () => {
    await expect(validateResolvedNavigationUrl('http://[fd00::1]/', OFF)).resolves.toEqual({
      valid: false,
      reason: `Blocked private IPv6 address (fc00::/7)${PRIVATE_HINT}`,
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks IPv4-mapped IPv6 literal URLs before DNS resolution', async () => {
    await expect(validateResolvedNavigationUrl('http://[::ffff:169.254.169.254]/', OFF)).resolves.toEqual({
      valid: false,
      reason: 'Blocked IPv4-mapped/compatible IPv6: embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  // The opt-in lifts the private ranges on the resolved path exactly as on the
  // literal one: a hostname is judged by where it points.
  it.each([
    ['10.4.5.6', 4],
    ['172.16.9.9', 4],
    ['192.168.50.1', 4],
    ['fd12:3456:789a::1', 6],
    ['fc00::7', 6],
  ] as const)('a hostname resolving to %s is blocked off and allowed on', async (address, family) => {
    lookupMock.mockResolvedValue([{ address, family }]);
    await expect(validateResolvedNavigationUrl('https://intranet.example', OFF)).resolves.toMatchObject({
      valid: false,
    });
    await expect(validateResolvedNavigationUrl('https://intranet.example', ON)).resolves.toEqual({ valid: true });
  });

  it.each([
    ['169.254.169.254', 4],
    ['0.0.0.0', 4],
    ['127.0.0.2', 4],
    ['fe80::1', 6],
    ['::', 6],
    ['::ffff:169.254.169.254', 6],
    ['fd00:ec2::254', 6],
    ['100.100.100.200', 4],
  ] as const)('a hostname resolving to %s stays blocked with the opt-in on', async (address, family) => {
    lookupMock.mockResolvedValue([{ address, family }]);
    await expect(validateResolvedNavigationUrl('https://sneaky.example', ON)).resolves.toMatchObject({
      valid: false,
    });
  });

  it('judges a bracketed IPv6 literal as an address, never as a hostname to resolve', async () => {
    // A resolver that rejects the bracketed form, as some platforms' do: the
    // literal must never reach it, or it is refused as unresolved.
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(validateResolvedNavigationUrl('http://[2606:4700:4700::1111]/', OFF)).resolves.toEqual({ valid: true });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('refuses cloud instance metadata literals with the opt-in on, before any DNS', async () => {
    await expect(validateResolvedNavigationUrl('http://[fd00:ec2::254]/', ON)).resolves.toEqual({
      valid: false,
      reason: 'Blocked cloud instance metadata address (fd00:ec2::/64)',
    });
    await expect(validateResolvedNavigationUrl('http://100.100.100.200/', ON)).resolves.toEqual({
      valid: false,
      reason: 'Blocked cloud instance metadata address (100.100.100.200)',
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows private literals with the opt-in on, before any DNS', async () => {
    for (const url of ['http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://[fd00::1]/']) {
      await expect(validateResolvedNavigationUrl(url, OFF)).resolves.toMatchObject({ valid: false });
      await expect(validateResolvedNavigationUrl(url, ON)).resolves.toEqual({ valid: true });
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
