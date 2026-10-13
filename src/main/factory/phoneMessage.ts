// ─── A phone message to Moa (main side of `moa.wake`) ────────────────────────
//
// The daemon forwards a phone's message to Moa over the desktop bridge
// (src/shared/moaWake.ts). With `mode: 'factory'` it goes to the agent
// factory's HQ bot (factoryWiring.ts installs the taker); the factory off
// answers `factory_off` and the daemon takes the Moa pane path itself. Any
// other `moa.wake` answers `moa_off`: there is no Moa brain to wake.

import type { MoaWakePayload, MoaWakeResult } from '../../shared/moaWake';

/** The agent factory's taker of a phone message to Moa: null when the
 *  factory is off. Installed by the factory wiring. */
export type FactoryPhoneMessageHandler = (payload: MoaWakePayload) => MoaWakeResult | null;

let factoryHandler: FactoryPhoneMessageHandler | null = null;

export function setFactoryPhoneMessageHandler(h: FactoryPhoneMessageHandler | null): void {
  factoryHandler = h;
}

/**
 * The bridge command. A malformed payload throws (the daemon validated it, so
 * this is not a phone-reachable answer).
 */
export function handlePhoneMoaWake(raw: Record<string, unknown>): MoaWakeResult {
  const { clientMessageId, text, actor, deviceId, mode } = raw;
  if (typeof clientMessageId !== 'string' || clientMessageId.length === 0 || clientMessageId.length > 128 ||
      typeof text !== 'string' || !text.trim() || typeof actor !== 'string' || actor.length === 0 || actor.length > 256 ||
      (deviceId !== undefined && typeof deviceId !== 'string') || (mode !== undefined && mode !== 'factory')) {
    throw new Error('invalid moa.wake payload');
  }
  if (mode !== 'factory') return { ok: false, code: 'moa_off' };
  const payload: MoaWakePayload = { clientMessageId, text, actor, mode, ...(typeof deviceId === 'string' ? { deviceId } : {}) };
  let r: MoaWakeResult | null = null;
  try {
    r = factoryHandler?.(payload) ?? null;
  } catch (err) {
    console.warn(`[factory] phone message failed: ${String(err)}`);
    return { ok: false, code: 'hq_unknown' };
  }
  return r ?? { ok: false, code: 'factory_off' };
}
