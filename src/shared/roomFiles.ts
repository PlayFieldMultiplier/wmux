// ─── Files a bot hands to the owner on its room cards ──────────────────────
//
// A bot may attach files it made to a card it posts (room_post `files`:
// paths inside the bot's repository or one of its task folders). Main checks
// each path (a regular file, no link out, within the size limits) and copies
// it into the room's own store, `<wmuxDir>/factory/room-files/<workspaceId>/
// <id>`, so the file outlives the task folder it came from (task folders are
// cleaned up after a week). The card carries only the copy's description;
// no path ever reaches a wire or the renderer. The owner opens a file from
// its chip into the Bots page's side panel, or saves a copy elsewhere.

export const ROOM_FILE_LIMITS = {
  /** Files one card may carry. */
  PER_CARD: 8,
  /** The largest file taken. */
  MAX_BYTES: 10 * 1024 * 1024,
  /** What one room's store may hold. */
  ROOM_MAX_FILES: 2000,
  ROOM_MAX_BYTES: 1024 * 1024 * 1024,
  /** A shown file name, after trimming to its last path segment. */
  NAME_MAX: 200,
} as const;

export const ROOM_FILE_ID_RE = /^[0-9a-f]{32}$/;

/** One file on a bot card: the stored copy's description. */
export interface RoomFile {
  id: string;
  /** The file's base name as the bot made it (no directories). */
  name: string;
  /** Inferred from the name's extension; `application/octet-stream` when
   *  unknown. Decides how the side panel shows it. */
  mediaType: string;
  bytes: number;
}

/** ROOM_FILE_READ params and reply: one stored file of a kept card of that
 *  room. Text is returned as UTF-8 text, everything else as a data URL. */
export interface RoomFileReadParams {
  workspaceId: string;
  fileId: string;
}
export type RoomFileReadResult =
  | { ok: true; file: RoomFile; text?: string; dataUrl?: string }
  | { ok: false; error: string };

/** ROOM_FILE_SAVE params and reply: copy one stored file to a place the
 *  owner picks in a save dialog. */
export interface RoomFileSaveParams {
  workspaceId: string;
  fileId: string;
}
export type RoomFileSaveResult = { ok: true; savedTo: string } | { ok: false; canceled?: true; error?: string };
