// ─── A bot's picture ────────────────────────────────────────────────────────
//
// BotProfile.avatar (shared/bot.ts) is a `data:image/png;base64,` URL of a
// square PNG at most BOT_AVATAR_PX wide. Main is its only writer: the store
// keeps a picture only when `parseBotAvatar` accepts it, on create, on
// FACTORY_BOT_SET_AVATAR and again on every read of bots.json.
//
// `pickBotAvatar` is FACTORY_BOT_PICK_AVATAR's body: the owner picks an image
// in main's open dialog; main decodes it, crops the centre square, scales it
// to BOT_AVATAR_PX and encodes a PNG. The result is a preview the renderer
// hands back on create / set, where it is checked again. Electron's dialog
// and image decoder come in as deps (factory.handler.ts wires them).

import { BOT_AVATAR_PX } from '../../shared/bot';
import type { FactoryBotAvatarPickResult } from '../../shared/botCreate';

export const BOT_AVATAR_PREFIX = 'data:image/png;base64,';
/** Largest stored PNG, decoded. bots.json is rewritten whole on each change,
 *  so this bounds the file at BOTS_MAX pictures. */
export const BOT_AVATAR_MAX_BYTES = 96 * 1024;
/** Largest image file the picker decodes. */
export const BOT_AVATAR_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The PNG's chunks are whole with valid CRCs: IHDR first, at least one
 *  IDAT, IEND last with nothing after it. */
function wellFormedChunks(bytes: Buffer): boolean {
  let at = PNG_SIGNATURE.length;
  let first = true;
  let idat = false;
  while (at + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(at);
    const end = at + 12 + len;
    if (len > bytes.length || end > bytes.length) return false;
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (crc32(bytes, at + 4, at + 8 + len) !== bytes.readUInt32BE(at + 8 + len)) return false;
    if (first !== (type === 'IHDR')) return false;
    first = false;
    if (type === 'IDAT') idat = true;
    if (type === 'IEND') return idat && len === 0 && end === bytes.length;
    at = end;
  }
  return false;
}
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// Signature (8) + IHDR chunk (25) + IEND chunk (12).
const PNG_MIN_BYTES = 45;

/** The URL itself when it is a stored-avatar PNG, else null. */
export function parseBotAvatar(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith(BOT_AVATAR_PREFIX)) return null;
  const body = raw.slice(BOT_AVATAR_PREFIX.length);
  if (body.length === 0 || body.length % 4 !== 0 || body.length > Math.ceil(BOT_AVATAR_MAX_BYTES / 3) * 4) return null;
  if (!BASE64_RE.test(body)) return null;
  const bytes = Buffer.from(body, 'base64');
  // Canonical base64 only: what decodes must encode back to the same text.
  if (bytes.toString('base64') !== body) return null;
  if (bytes.length < PNG_MIN_BYTES || bytes.length > BOT_AVATAR_MAX_BYTES) return null;
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  // The first chunk is IHDR (length 13): width and height, big-endian.
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== height || width < 1 || width > BOT_AVATAR_PX) return null;
  return wellFormedChunks(bytes) ? raw : null;
}

/** The part of Electron's NativeImage the picker uses. */
export interface AvatarImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  crop(rect: { x: number; y: number; width: number; height: number }): AvatarImage;
  resize(opts: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): AvatarImage;
  toPNG(): Buffer;
}

export interface BotAvatarPickerDeps {
  /** The open dialog: the picked paths, or none when cancelled. */
  chooseFile: () => Promise<string[] | null>;
  /** The file's size in bytes (throws when unreadable). */
  fileSize: (filePath: string) => number;
  /** The decoded image (empty when the format is not one it reads). */
  loadImage: (filePath: string) => AvatarImage;
}

/** The dialog's filter: what the picker offers. */
export const BOT_AVATAR_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;

/** A decoded image as a stored avatar: the centre square, at most
 *  BOT_AVATAR_PX wide, PNG. */
export function avatarFromImage(image: AvatarImage): FactoryBotAvatarPickResult {
  if (image.isEmpty()) return { ok: false, code: 'unreadable' };
  const { width, height } = image.getSize();
  if (!(width > 0) || !(height > 0)) return { ok: false, code: 'unreadable' };
  const side = Math.min(width, height);
  const square = width === height
    ? image
    : image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  const edge = Math.min(side, BOT_AVATAR_PX);
  const sized = side === edge ? square : square.resize({ width: edge, height: edge, quality: 'best' });
  const png = sized.toPNG();
  if (png.length > BOT_AVATAR_MAX_BYTES) return { ok: false, code: 'too_large' };
  const avatar = parseBotAvatar(BOT_AVATAR_PREFIX + png.toString('base64'));
  return avatar ? { ok: true, avatar } : { ok: false, code: 'unreadable' };
}

/** One image file as a stored avatar. */
export function avatarFromFile(filePath: string, deps: Pick<BotAvatarPickerDeps, 'fileSize' | 'loadImage'>): FactoryBotAvatarPickResult {
  let size: number;
  try {
    size = deps.fileSize(filePath);
  } catch {
    return { ok: false, code: 'unreadable' };
  }
  if (size > BOT_AVATAR_SOURCE_MAX_BYTES) return { ok: false, code: 'too_large' };
  try {
    return avatarFromImage(deps.loadImage(filePath));
  } catch {
    return { ok: false, code: 'unreadable' };
  }
}

/** The owner picks an image; the answer is its avatar preview. */
export async function pickBotAvatar(deps: BotAvatarPickerDeps): Promise<FactoryBotAvatarPickResult> {
  const picked = await deps.chooseFile();
  const filePath = picked?.[0];
  if (!filePath) return { ok: false, code: 'cancelled' };
  return avatarFromFile(filePath, deps);
}
