import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOW_PRIVATE_NETWORK_ENV,
  navigationPolicyOptions,
  validateNavigationAddress,
  validateNavigationUrl,
  type NavigationPolicyOptions,
} from '../types';

const PRIVATE_HINT =
  ' — to allow private ranges, turn on Settings → Browser → Allow private network addresses ' +
  `(or set ${ALLOW_PRIVATE_NETWORK_ENV}=1 in the environment that launches wmux)`;

const OFF: NavigationPolicyOptions = { allowPrivateNetwork: false };
const ON: NavigationPolicyOptions = { allowPrivateNetwork: true };

describe('validateNavigationUrl', () => {
  afterEach(() => {
    delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
  });

  it('allows public HTTP(S), localhost, and exact loopback development URLs', () => {
    expect(validateNavigationUrl('https://example.com', OFF)).toEqual({ valid: true });
    expect(validateNavigationUrl('http://localhost:3000', OFF)).toEqual({ valid: true });
    expect(validateNavigationUrl('http://127.0.0.1:5173', OFF)).toEqual({ valid: true });
    expect(validateNavigationUrl('http://[::1]:5173', OFF)).toEqual({ valid: true });
  });

  it('blocks private and link-local IPv4 literal URLs', () => {
    expect(validateNavigationUrl('http://10.0.0.1/', OFF)).toEqual({
      valid: false,
      reason: `Blocked private IP address (10.0.0.0/8)${PRIVATE_HINT}`,
    });
    expect(validateNavigationUrl('http://169.254.169.254/', OFF)).toEqual({
      valid: false,
      reason: 'Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
  });

  it('blocks bracketed private and link-local IPv6 literal URLs', () => {
    expect(validateNavigationUrl('http://[fc00::1]/', OFF)).toEqual({
      valid: false,
      reason: `Blocked private IPv6 address (fc00::/7)${PRIVATE_HINT}`,
    });
    expect(validateNavigationUrl('http://[fd00::1]/', OFF)).toEqual({
      valid: false,
      reason: `Blocked private IPv6 address (fc00::/7)${PRIVATE_HINT}`,
    });
    expect(validateNavigationUrl('http://[fe80::1]/', OFF)).toEqual({
      valid: false,
      reason: 'Blocked link-local IPv6 address (fe80::/10)',
    });
  });

  it('blocks IPv4-mapped and IPv4-compatible IPv6 forms with private embedded addresses', () => {
    expect(validateNavigationUrl('http://[::ffff:169.254.169.254]/', OFF)).toEqual({
      valid: false,
      reason: 'Blocked IPv4-mapped/compatible IPv6: embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
    expect(validateNavigationUrl('http://[::ffff:a9fe:a9fe]/', OFF)).toEqual({
      valid: false,
      reason: 'Blocked IPv4-mapped/compatible IPv6: embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
    expect(validateNavigationUrl('http://[::169.254.169.254]/', OFF)).toEqual({
      valid: false,
      reason: 'Blocked IPv4-mapped/compatible IPv6: embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
  });

  // #1359: the refusal has to carry its own remedy, and the remedy has to work.
  describe('with the private-network switch on', () => {
    it('allows the RFC1918 and ULA ranges the block message names', () => {
      for (const url of [
        'http://10.0.0.1/',
        'http://172.16.0.1/',
        'http://172.31.255.254/',
        'http://192.168.1.1/',
        'http://[fc00::1]/',
        'http://[fd00::1]/',
      ]) {
        expect(validateNavigationUrl(url, OFF).valid, `${url} off`).toBe(false);
        expect(validateNavigationUrl(url, ON), `${url} on`).toEqual({ valid: true });
      }
    });

    it('still blocks link-local, cloud metadata, the null addresses and loopback aliases', () => {
      expect(validateNavigationUrl('http://169.254.169.254/', ON)).toEqual({
        valid: false,
        reason: 'Blocked link-local/cloud metadata address (169.254.0.0/16)',
      });
      expect(validateNavigationUrl('http://0.0.0.0/', ON)).toEqual({
        valid: false,
        reason: 'Blocked null address (0.0.0.0)',
      });
      expect(validateNavigationUrl('http://[::]/', ON)).toEqual({
        valid: false,
        reason: 'Blocked null IPv6 address (equivalent to 0.0.0.0)',
      });
      expect(validateNavigationUrl('http://127.0.0.2/', ON)).toEqual({
        valid: false,
        reason: 'Blocked loopback address',
      });
      expect(validateNavigationUrl('http://[fe80::1]/', ON)).toEqual({
        valid: false,
        reason: 'Blocked link-local IPv6 address (fe80::/10)',
      });
      expect(validateNavigationUrl('http://[::ffff:169.254.169.254]/', ON)).toEqual({
        valid: false,
        reason: 'Blocked IPv4-mapped/compatible IPv6: embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
      });
      expect(validateNavigationUrl('file:///etc/passwd', ON)).toEqual({
        valid: false,
        reason: 'Blocked URL scheme: file:',
      });
    });

    it('still blocks cloud instance metadata addresses that sit inside reachable ranges', () => {
      for (const options of [OFF, ON]) {
        expect(validateNavigationUrl('http://[fd00:ec2::254]/', options)).toEqual({
          valid: false,
          reason: 'Blocked cloud instance metadata address (fd00:ec2::/64)',
        });
        expect(validateNavigationUrl('http://[fd00:ec2:0:0:ffff::1]/', options).valid).toBe(false);
        expect(validateNavigationUrl('http://100.100.100.200/', options)).toEqual({
          valid: false,
          reason: 'Blocked cloud instance metadata address (100.100.100.200)',
        });
        expect(validateNavigationUrl('http://[::ffff:100.100.100.200]/', options).valid).toBe(false);
      }
      // Only those: the rest of fd00::/8 follows the switch, and the shared
      // 100.64.0.0/10 range (CGNAT, Tailscale) stays reachable.
      expect(validateNavigationUrl('http://[fd00:ec2:0:1::254]/', ON)).toEqual({ valid: true });
      expect(validateNavigationUrl('http://100.79.1.2/', OFF)).toEqual({ valid: true });
      expect(validateNavigationUrl('http://100.100.100.201/', OFF)).toEqual({ valid: true });
    });

    // NAT64 and 6to4 deliver to the IPv4 address they carry, so that address
    // gets the IPv4 verdict, switch included.
    it.each([
      ['http://[64:ff9b::a00:1]/', '10.0.0.1'],
      ['http://[64:ff9b::c0a8:101]/', '192.168.1.1'],
      ['http://[2002:c0a8:0101::1]/', '192.168.1.1'],
      ['http://[2002:0a00:0001::1]/', '10.0.0.1'],
    ])('judges %s by its embedded %s: blocked off, allowed on', (url, ipv4) => {
      const off = validateNavigationUrl(url, OFF);
      expect(off.valid).toBe(false);
      expect(off.reason).toContain(`embedded ${ipv4}`);
      expect(off.reason).toContain(PRIVATE_HINT.slice(3));
      expect(validateNavigationUrl(url, ON)).toEqual({ valid: true });
    });

    it.each([
      ['http://[64:ff9b::a9fe:a9fe]/', /NAT64 IPv6 \(64:ff9b::\/96\): embedded 169\.254\.169\.254/],
      ['http://[2002:a9fe:a9fe::1]/', /6to4 IPv6 \(2002::\/16\): embedded 169\.254\.169\.254/],
      ['http://[64:ff9b::6464:64c8]/', /embedded 100\.100\.100\.200/],
      ['http://[2002:7f00:0002::1]/', /embedded 127\.0\.0\.2/],
    ])('blocks %s whatever the switch', (url, reason) => {
      for (const options of [OFF, ON]) {
        const result = validateNavigationUrl(url, options);
        expect(result.valid).toBe(false);
        expect(result.reason).toMatch(reason);
        expect(result.reason).not.toContain('Settings');
      }
    });

    it('lets a public NAT64 or 6to4 address through with the switch off', () => {
      expect(validateNavigationUrl('http://[64:ff9b::808:808]/', OFF)).toEqual({ valid: true });
      expect(validateNavigationUrl('http://[2002:0808:0808::1]/', OFF)).toEqual({ valid: true });
    });

    it('treats deprecated site-local fec0::/10 as private', () => {
      expect(validateNavigationUrl('http://[fec0::1]/', OFF)).toEqual({
        valid: false,
        reason: `Blocked site-local IPv6 address (fec0::/10)${PRIVATE_HINT}`,
      });
      expect(validateNavigationUrl('http://[feff::1]/', OFF).valid).toBe(false);
      expect(validateNavigationUrl('http://[fec0::1]/', ON)).toEqual({ valid: true });
    });

    it('lets an IPv4-mapped private address through exactly as its IPv4 form', () => {
      expect(validateNavigationUrl('http://[::ffff:10.0.0.1]/', OFF).valid).toBe(false);
      expect(validateNavigationUrl('http://[::ffff:10.0.0.1]/', ON)).toEqual({ valid: true });
    });
  });

  it('judges by the options it is given, never by the environment directly', () => {
    // The verdict takes the switch as an input; only navigationPolicyOptions()
    // folds the environment variable in.
    process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
    expect(validateNavigationUrl('http://10.0.0.1/', OFF).valid).toBe(false);
    expect(validateNavigationAddress('10.0.0.1', OFF).valid).toBe(false);
  });
});

describe('validateNavigationAddress', () => {
  it('applies the same switch to a bare address (the resolved half)', () => {
    for (const address of ['10.1.2.3', '172.20.0.1', '192.168.0.10', 'fd12:3456:789a::1', 'fc00::1']) {
      expect(validateNavigationAddress(address, OFF).valid, `${address} off`).toBe(false);
      expect(validateNavigationAddress(address, ON), `${address} on`).toEqual({ valid: true });
    }
    for (const address of ['169.254.169.254', 'fe80::1', '0.0.0.0', '::', '127.0.0.2', '::ffff:169.254.169.254']) {
      expect(validateNavigationAddress(address, ON).valid, `${address} on`).toBe(false);
    }
  });
});

describe('navigationPolicyOptions', () => {
  afterEach(() => {
    delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
  });

  it('is the Settings toggle OR the environment variable', () => {
    expect(navigationPolicyOptions(false)).toEqual({ allowPrivateNetwork: false });
    expect(navigationPolicyOptions(true)).toEqual({ allowPrivateNetwork: true });

    process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
    expect(navigationPolicyOptions(false)).toEqual({ allowPrivateNetwork: true });
    expect(navigationPolicyOptions(true)).toEqual({ allowPrivateNetwork: true });
  });

  it('reads only an affirmative environment value as on', () => {
    for (const value of ['1', 'true', 'YES', ' yes ']) {
      process.env[ALLOW_PRIVATE_NETWORK_ENV] = value;
      expect(navigationPolicyOptions(false).allowPrivateNetwork, value).toBe(true);
    }
    for (const value of ['0', 'false', 'no', '']) {
      process.env[ALLOW_PRIVATE_NETWORK_ENV] = value;
      expect(navigationPolicyOptions(false).allowPrivateNetwork, value).toBe(false);
    }
  });
});
