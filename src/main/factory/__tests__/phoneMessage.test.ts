// main's side of a phone message to Moa (`moa.wake`): a factory message goes
// to the HQ bot's taker; anything else answers moa_off (there is no Moa brain).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePhoneMoaWake, setFactoryPhoneMessageHandler } from '../phoneMessage';

const base = { clientMessageId: 'm-1', text: 'plan today', actor: 'device:d1' };

afterEach(() => setFactoryPhoneMessageHandler(null));

describe('handlePhoneMoaWake', () => {
  it('throws on a malformed payload (the daemon validated it)', () => {
    for (const bad of [
      { ...base, clientMessageId: '' },
      { ...base, text: '   ' },
      { ...base, actor: '' },
      { ...base, deviceId: 7 },
      { ...base, mode: 'moa' },
    ]) {
      expect(() => handlePhoneMoaWake(bad)).toThrow(/invalid moa\.wake payload/);
    }
  });

  it('answers moa_off for a message that is not for the factory, even with a taker installed', () => {
    const taker = vi.fn(() => ({ ok: true as const, accepted: true as const, queued: true as const }));
    setFactoryPhoneMessageHandler(taker);
    expect(handlePhoneMoaWake(base)).toEqual({ ok: false, code: 'moa_off' });
    expect(taker).not.toHaveBeenCalled();
  });

  it('answers factory_off with no taker, or when the taker says the factory is off', () => {
    expect(handlePhoneMoaWake({ ...base, mode: 'factory' })).toEqual({ ok: false, code: 'factory_off' });
    setFactoryPhoneMessageHandler(() => null);
    expect(handlePhoneMoaWake({ ...base, mode: 'factory' })).toEqual({ ok: false, code: 'factory_off' });
  });

  it('hands the taker exactly the validated fields and returns its answer', () => {
    const taker = vi.fn(() => ({ ok: true as const, accepted: true as const, queued: true as const }));
    setFactoryPhoneMessageHandler(taker);
    expect(handlePhoneMoaWake({ ...base, mode: 'factory', deviceId: 'd1', extra: 'dropped' })).toEqual({ ok: true, accepted: true, queued: true });
    expect(taker).toHaveBeenCalledWith({ ...base, mode: 'factory', deviceId: 'd1' });
  });

  it('a taker that throws answers hq_unknown', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setFactoryPhoneMessageHandler(() => { throw new Error('store gone'); });
    expect(handlePhoneMoaWake({ ...base, mode: 'factory' })).toEqual({ ok: false, code: 'hq_unknown' });
  });
});
