import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from 'electron';
import { logNotificationFailure } from '../notificationFailure';

// Electron 42 reports an unshowable toast (macOS: an unsigned build) as a
// `failed` event. A real EventEmitter stands in for the Notification, so the
// emit below goes through the same listener dispatch Electron uses.
describe('logNotificationFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches a failed listener', () => {
    const notification = new EventEmitter();
    logNotificationFailure(notification as unknown as Notification, 'test');
    expect(notification.listenerCount('failed')).toBe(1);
  });

  it('logs a failed emit with its source and error instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notification = new EventEmitter();
    logNotificationFailure(notification as unknown as Notification, 'ToastManager');

    expect(() => notification.emit('failed', {}, 'Notifications are not allowed')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[ToastManager] OS notification failed to show:',
      'Notifications are not allowed',
    );
  });
});
