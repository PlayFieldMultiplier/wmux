import { describe, it, expect } from 'vitest';
import { InboundCounter, OWN_ADDRESSES_TTL_MS, isLoopbackHost, normalizeRemote } from '../inboundSeen';

describe('InboundCounter', () => {
  const own = () => new Set(['192.168.1.10', '100.79.244.107', 'fe80::1']);

  it('counts a connection from another machine, with its time', () => {
    let t = 1_000;
    const c = new InboundCounter(own, () => t);
    expect(c.snapshot()).toEqual({ inboundSeenAt: null, inboundCount: 0 });
    c.note('192.168.1.20');
    t = 2_000;
    c.note('::ffff:192.168.1.21');
    expect(c.snapshot()).toEqual({ inboundSeenAt: 2_000, inboundCount: 2 });
  });

  it('never counts loopback or this machine\'s own addresses (any spelling)', () => {
    const c = new InboundCounter(own, () => 1);
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.10', '::ffff:192.168.1.10', 'FE80::1', undefined, null, '']) c.note(a);
    expect(c.snapshot()).toEqual({ inboundSeenAt: null, inboundCount: 0 });
  });

  it('reads this machine\'s addresses at most once per TTL, and again for an unknown address after it', () => {
    let t = 0;
    let reads = 0;
    let mine = new Set(['192.168.1.10']);
    const c = new InboundCounter(() => { reads += 1; return mine; }, () => t);
    for (let i = 0; i < 50; i += 1) c.note(`192.168.1.${100 + i}`);
    expect(reads).toBe(1);
    expect(c.snapshot().inboundCount).toBe(50);
    // An address that came up later (Tailscale connecting) is this machine once the read is stale.
    mine = new Set(['192.168.1.10', '100.79.244.107']);
    c.note('100.79.244.107');
    expect(c.snapshot().inboundCount).toBe(51);
    t = OWN_ADDRESSES_TTL_MS;
    c.note('100.79.244.107');
    expect(reads).toBe(2);
    expect(c.snapshot().inboundCount).toBe(51);
    // A known address never reads again.
    t = 10 * OWN_ADDRESSES_TTL_MS;
    c.note('192.168.1.10');
    expect(reads).toBe(2);
  });
});

describe('address helpers', () => {
  it('normalizeRemote unwraps IPv4-mapped IPv6 only', () => {
    expect(normalizeRemote('::FFFF:10.0.0.5')).toBe('10.0.0.5');
    expect(normalizeRemote('::ffff:abcd')).toBe('::ffff:abcd');
  });

  it('isLoopbackHost', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.10']) expect(isLoopbackHost(h), h).toBe(false);
  });
});
