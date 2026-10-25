// Whether a paired phone is attached to this daemon, for "Keep the computer
// awake" (main/power/sleepPrevention.ts holds the blocker; this only says
// when a phone is here).
//
// Attached: a paired device that is not a computer (kind phone or unknown)
// and not revoked holds a live stream right now, or made an authenticated
// request within PHONE_ATTACH_WINDOW_MS. The same two halves as the roster's
// "Active now" (deviceActivity.ts), with a longer window: a phone between
// streams (backgrounded, then reopened) is still the person working with
// this computer. A stream that stays open on a half-open socket (the phone
// left the network) counts until the heartbeat write fails.
//
// Nothing polls. Every event that can change the answer (a stream opening
// or closing, a request, a revoke, the server stopping) calls update(), and
// one timer is armed for the moment the earliest request window ends.

import type { DeviceKind } from '../../shared/web';

/** How long after its last request a device still counts as attached. */
export const PHONE_ATTACH_WINDOW_MS = 600_000;

export interface PresenceDevice {
  deviceId: string;
  kind?: DeviceKind;
  lastSeenAt: number;
  revokedAt?: number;
}

/** A device that can attach: not revoked, and not another computer. */
function counts(device: PresenceDevice): boolean {
  return device.revokedAt === undefined && device.kind !== 'computer';
}

/**
 * The answer now, and when it next changes by time alone: the end of the
 * earliest request window still open for a device with no live stream
 * (null when none is open). Pure.
 */
export function phonePresenceAt(
  devices: readonly PresenceDevice[],
  liveDeviceIds: ReadonlySet<string>,
  now: number,
  windowMs: number = PHONE_ATTACH_WINDOW_MS,
): { attached: boolean; expiresAt: number | null } {
  let attached = false;
  let expiresAt: number | null = null;
  for (const device of devices) {
    if (!counts(device)) continue;
    if (liveDeviceIds.has(device.deviceId)) {
      attached = true;
      continue;
    }
    const end = device.lastSeenAt + windowMs;
    if (now < end) {
      attached = true;
      if (expiresAt === null || end < expiresAt) expiresAt = end;
    }
  }
  return { attached, expiresAt };
}

export interface PhonePresenceDeps {
  devices: () => readonly PresenceDevice[];
  liveDeviceIds: () => ReadonlySet<string>;
  /** Called on each change of the answer, never with the same value twice. */
  onChange: (attached: boolean) => void;
  now?: () => number;
}

export class PhonePresence {
  private attached = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set by stop(), cleared by start(): a stopped server's late events change nothing. */
  private stopped = false;

  constructor(private readonly deps: PhonePresenceDeps) {}

  get isAttached(): boolean {
    return this.attached;
  }

  /**
   * Read the devices and streams again; re-arm the window timer. Nothing while
   * stopped. A roster that cannot be read changes nothing either: the last
   * answer and its timer stand, rather than a read error detaching a phone.
   */
  update(): void {
    if (this.stopped) return;
    let devices: readonly PresenceDevice[];
    try {
      devices = this.deps.devices();
    } catch {
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    const { attached, expiresAt } = phonePresenceAt(devices, this.deps.liveDeviceIds(), now);
    this.clearTimer();
    if (expiresAt !== null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.update();
      }, Math.max(0, expiresAt - now));
      this.timer.unref?.();
    }
    this.set(attached);
  }

  /** The server (re)started: recompute, a device seen shortly before counting again. */
  start(): void {
    this.stopped = false;
    this.update();
  }

  /**
   * The server stopped: no phone can reach it, whatever its last request.
   * Sticky until start(): its streams' close handlers run later and must not
   * attach the phone again from its last request.
   */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.set(false);
  }

  private set(attached: boolean): void {
    if (attached === this.attached) return;
    this.attached = attached;
    this.deps.onChange(attached);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
