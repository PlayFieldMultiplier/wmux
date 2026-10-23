import type { Notification } from 'electron';

/**
 * Log an OS notification that could not be shown.
 *
 * Electron reports a toast it could not create or post as a `failed` event,
 * not as a throw from `show()`. Since Electron 42 that includes macOS, where
 * notifications need a code-signed app: an unsigned dev build gets `failed`
 * for every toast. With no listener the toast is lost without a trace. The
 * callers' other attention signals (taskbar flash, dock bounce, in-app
 * alerts) do not depend on the toast, so a log line is the whole fallback.
 */
export function logNotificationFailure(notification: Pick<Notification, 'on'>, source: string): void {
  notification.on('failed', (_event, error) => {
    console.warn(`[${source}] OS notification failed to show:`, error);
  });
}
