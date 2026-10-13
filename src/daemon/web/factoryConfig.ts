// The Moa and agent-factory keys of `GET /api/config`.
//
// Main folds the factory into the desktop sidebar snapshot
// (main/phone/PhoneFactory.ts); this daemon only turns that snapshot plus its
// own gates into keys. With `factory.enabled` absent or false the legacy Moa
// keys come out exactly as before; the one addition is
// `moaWakeBlocked: 'factory-off'` when no legacy Moa is on either.
//
// With the factory on, Moa is the HQ bot: `moa` follows the HQ bot, a message
// always goes through the factory (POST /api/moa/messages → 202 queued) and is
// offered (`moaWake`) only to a client that reads room cards (`rooms-v1`;
// others get `moaWakeBlocked: 'needs-app-update'` beside `moa`), and
// `moaSessionId` is never served — it names a pane the turn and chat routes
// accept, and the HQ bot has no pane. Its engine session id rides as
// `factory.hqSessionId`, opaque.

import type { PhoneSidebarSnapshot } from '../../shared/phoneFleetSidebar';

export interface MoaConfigInput {
  sidebar: PhoneSidebarSnapshot | null;
  /** The legacy Moa pane's session id while it resolves (WebTerminalServer.moaSessionIdField). */
  legacySessionId: () => string | undefined;
  /** A wake service is wired and this caller passes the chat write gates. */
  writable: boolean;
  /** The attached desktop announced `moa.wake`. */
  supportsWake: boolean;
  /** The attached desktop announced `factory.message`. */
  supportsFactory: boolean;
  /** `--allow-transcript`, and the attached desktop announced both room commands. */
  roomsReadable: boolean;
  /** The request's `X-Wmux-Client-Caps` carries `rooms-v1`: the client reads
   *  Moa's replies as room cards. A client without it waits for a Moa pane
   *  that never appears, so it is not offered the factory's send. */
  roomsClient: boolean;
}

/** True when the snapshot says the desktop's factory is on. */
export function factoryOn(sidebar: PhoneSidebarSnapshot | null): boolean {
  return sidebar?.factory?.enabled === true;
}

export function moaConfigFields(i: MoaConfigInput): Record<string, unknown> {
  const { sidebar } = i;
  const factory = sidebar?.factory;
  const out: Record<string, unknown> = {};
  if (factory) {
    out.factory = {
      enabled: factory.enabled,
      ...(factory.hqBotId !== undefined ? { hqBotId: factory.hqBotId } : {}),
      ...(factory.hqWorkspaceId !== undefined ? { hqWorkspaceId: factory.hqWorkspaceId } : {}),
      ...(factory.hqSessionId !== undefined ? { hqSessionId: factory.hqSessionId } : {}),
    };
  }
  if (i.roomsReadable) out.rooms = true;
  const wakeGates = i.writable && i.supportsWake;
  if (factory?.enabled === true) {
    if (sidebar?.moa === true) out.moa = true;
    if (wakeGates && i.supportsFactory) {
      if (sidebar?.moa === true) {
        if (i.roomsClient) out.moaWake = true;
        else out.moaWakeBlocked = 'needs-app-update';
      } else if (sidebar?.moaWakeBlocked === 'no-hq-bot') out.moaWakeBlocked = 'no-hq-bot';
    }
    return out;
  }
  // Legacy Moa, as before.
  if (sidebar?.moa === true) {
    out.moa = true;
    const sessionId = i.legacySessionId();
    if (sessionId !== undefined) out.moaSessionId = sessionId;
    if (sessionId === undefined && wakeGates) {
      if (sidebar.moaWakeBlocked === 'moa-mode-off') out.moaWakeBlocked = 'moa-mode-off';
      else out.moaWake = true;
    }
  } else if (factory && sidebar?.moaWakeBlocked === 'factory-off' && wakeGates && i.supportsFactory) {
    out.moaWakeBlocked = 'factory-off';
  }
  return out;
}
