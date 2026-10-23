// Browser panes never get the camera or the microphone. Every session other
// than wmux's own window (the browser profiles' `persist:wmux-*` / `wmux-*`
// partitions, the private one) answers a `media` request and check with no;
// the rest is approved as Electron approves it by default. wmux's own window
// keeps the microphone for voice dictation.

import { app, session, type Session } from 'electron';

/** Refuse `media` (audio and video) on `ses`; allow everything else. */
export function denyMediaPermissions(ses: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission !== 'media'));
  ses.setPermissionCheckHandler((_wc, permission) => permission !== 'media');
}

/** Every session created from now on, except the default one, refuses media.
 *  A session with its own stricter handler (the HTML preview's) replaces this
 *  one when it sets its own. Call before the first partition is opened. */
export function denyMediaOutsideMainWindow(): void {
  app.on('session-created', (ses) => {
    if (ses === session.defaultSession) return;
    denyMediaPermissions(ses);
  });
}
