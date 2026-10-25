// Whether a paired phone is attached: a live stream, or a request within the
// window, from a device that is neither revoked nor another computer. The
// window ends on a timer, never a poll.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHONE_ATTACH_WINDOW_MS, PhonePresence, phonePresenceAt, type PresenceDevice } from '../phonePresence';

const T0 = 1_700_000_000_000;
const phone = (over: Partial<PresenceDevice> = {}): PresenceDevice => ({ deviceId: 'p1', kind: 'phone', lastSeenAt: T0, ...over });

describe('phonePresenceAt', () => {
  it('a live stream attaches whatever the last request; a request attaches for the window', () => {
    const old = phone({ lastSeenAt: T0 - 10 * PHONE_ATTACH_WINDOW_MS });
    expect(phonePresenceAt([old], new Set(['p1']), T0)).toEqual({ attached: true, expiresAt: null });
    expect(phonePresenceAt([old], new Set(), T0)).toEqual({ attached: false, expiresAt: null });
    expect(phonePresenceAt([phone()], new Set(), T0 + 1)).toEqual({ attached: true, expiresAt: T0 + PHONE_ATTACH_WINDOW_MS });
    expect(phonePresenceAt([phone()], new Set(), T0 + PHONE_ATTACH_WINDOW_MS).attached).toBe(false);
  });

  it('counts phones and unknown kinds; never another computer or a revoked device', () => {
    expect(phonePresenceAt([phone({ kind: 'unknown' })], new Set(), T0).attached).toBe(true);
    expect(phonePresenceAt([phone({ kind: undefined })], new Set(), T0).attached).toBe(true);
    expect(phonePresenceAt([phone({ kind: 'computer' })], new Set(['p1']), T0).attached).toBe(false);
    expect(phonePresenceAt([phone({ revokedAt: T0 })], new Set(['p1']), T0).attached).toBe(false);
  });

  it('the next change by time is the earliest open window among devices with no stream', () => {
    const devices = [phone({ deviceId: 'a', lastSeenAt: T0 - 5_000 }), phone({ deviceId: 'b', lastSeenAt: T0 - 9_000 }), phone({ deviceId: 'c', lastSeenAt: T0 - 20_000 })];
    expect(phonePresenceAt(devices, new Set(['c']), T0).expiresAt).toBe(T0 - 9_000 + PHONE_ATTACH_WINDOW_MS);
  });
});

describe('PhonePresence', () => {
  let clock: number;
  let devices: PresenceDevice[];
  let live: Set<string>;
  let changes: boolean[];
  let presence: PhonePresence;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = T0;
    devices = [];
    live = new Set();
    changes = [];
    presence = new PhonePresence({ devices: () => devices, liveDeviceIds: () => live, onChange: (a) => changes.push(a), now: () => clock });
  });
  afterEach(() => {
    presence.stop();
    vi.useRealTimers();
  });
  const advance = (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); };

  it('a stream opening attaches; its close leaves the request window, which ends on its own', () => {
    devices = [phone()];
    live.add('p1');
    presence.update();
    expect(changes).toEqual([true]);
    advance(60_000);
    live.delete('p1');
    presence.update();
    expect(presence.isAttached).toBe(true);
    advance(PHONE_ATTACH_WINDOW_MS - 60_000 - 1);
    expect(presence.isAttached).toBe(true);
    advance(1);
    expect(changes).toEqual([true, false]);
  });

  it('each request extends the window; the timer follows it', () => {
    devices = [phone()];
    presence.update();
    advance(PHONE_ATTACH_WINDOW_MS - 1_000);
    devices = [phone({ lastSeenAt: clock })];
    presence.update();
    advance(PHONE_ATTACH_WINDOW_MS - 1);
    expect(presence.isAttached).toBe(true);
    advance(1);
    expect(changes).toEqual([true, false]);
  });

  it('several devices: attached until the last one goes', () => {
    devices = [phone({ deviceId: 'a' }), phone({ deviceId: 'b', lastSeenAt: T0 + 120_000 })];
    presence.update();
    advance(PHONE_ATTACH_WINDOW_MS);
    expect(presence.isAttached).toBe(true);
    advance(120_000);
    expect(changes).toEqual([true, false]);
  });

  it('a revoke recomputes at once', () => {
    devices = [phone()];
    live.add('p1');
    presence.update();
    devices = [phone({ revokedAt: clock })];
    live.delete('p1');
    presence.update();
    expect(changes).toEqual([true, false]);
  });

  it('stop detaches at once and arms nothing', () => {
    devices = [phone()];
    presence.update();
    presence.stop();
    expect(changes).toEqual([true, false]);
    advance(PHONE_ATTACH_WINDOW_MS * 2);
    expect(changes).toEqual([true, false]);
  });

  it('an unreadable roster reads as no device', () => {
    presence = new PhonePresence({ devices: () => { throw new Error('roster'); }, liveDeviceIds: () => live, onChange: (a) => changes.push(a), now: () => clock });
    expect(() => presence.update()).not.toThrow();
    expect(presence.isAttached).toBe(false);
  });
});
