// ─── Image bytes of a cross-PC A2A message (`images.1`) ────────────────────
//
// What a PC checks before an image leaves it, and again when one arrives:
// the type by its leading bytes (PNG, JPEG or WebP; a name or a declared type
// is never consulted), the structure of the container, and the pixel size
// read from the header. Nothing here decodes pixels, so there is no
// decompression to bomb; a header that declares more than
// `A2A_REMOTE_IMAGE_LIMITS.MAX_EDGE` / `MAX_PIXELS` is refused instead.
//
// The sender also strips metadata (`prepareA2aImage`), because a photo
// forwarded from a phone can carry its GPS position:
//   PNG  — `eXIf`, `tEXt`, `iTXt` (XMP lives here), `zTXt` and `caBX`
//          (content credentials) chunks;
//   JPEG — APP1 (Exif, XMP), APP11 (content credentials), APP13 (IPTC),
//          APP2 MPF (it points at images after the end, which are dropped)
//          and COM segments; an Exif Orientation other than 1 is kept as a
//          one-tag Exif segment, so the picture still shows the right way up;
//   WebP — `EXIF` and `XMP ` chunks, with the VP8X flags and the RIFF size
//          rewritten to match.
// A PNG or WebP Exif orientation is dropped with the rest: few decoders read
// one there. Anything after the container's end (PNG `IEND`, JPEG EOI, the
// RIFF size) is dropped too, and a RECEIVED image with bytes after its end is
// refused (a sender never leaves them). A container that does not parse is
// refused, never sent as it was. The hash the envelope carries is of the
// stripped bytes.
//
// The declared size must be the one a decoder uses: a JPEG with a second
// frame header, or a WebP whose VP8X canvas and image data disagree, is
// refused rather than checked by its smaller claim.

import { A2A_REMOTE_IMAGE_LIMITS, type A2aRemoteImageMediaType } from './a2aRemote';

export interface A2aImageInfo {
  mediaType: A2aRemoteImageMediaType;
  width: number;
  height: number;
}

export type A2aImageRefusal =
  /** Not PNG, JPEG or WebP by its leading bytes. */
  | 'unsupported'
  /** The container does not parse. */
  | 'malformed'
  /** The header declares more pixels than a message may carry. */
  | 'dimensions';

export type A2aImageCheck = { ok: true; info: A2aImageInfo } | { ok: false; reason: A2aImageRefusal };

export type A2aImagePrepared =
  | { ok: true; bytes: Uint8Array; info: A2aImageInfo }
  | { ok: false; reason: A2aImageRefusal };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The type by the leading bytes (at least 12 are needed for WebP), or null. */
export function sniffA2aImage(head: Uint8Array): A2aRemoteImageMediaType | null {
  if (head.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => head[i] === b)) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

/** Type, structure and declared size of an image, as received. Nothing is changed. */
export function inspectA2aImage(bytes: Uint8Array): A2aImageCheck {
  const parsed = parse(bytes, false);
  return parsed.ok ? { ok: true, info: parsed.info } : parsed;
}

/** The image as it may leave this PC: checked like `inspectA2aImage`, metadata stripped. */
export function prepareA2aImage(bytes: Uint8Array): A2aImagePrepared {
  return parse(bytes, true);
}

function parse(bytes: Uint8Array, strip: boolean): A2aImagePrepared {
  const type = sniffA2aImage(bytes);
  if (!type) return { ok: false, reason: 'unsupported' };
  let out: { bytes: Uint8Array; width: number; height: number } | null;
  try {
    out = type === 'image/png' ? parsePng(bytes, strip) : type === 'image/jpeg' ? parseJpeg(bytes, strip) : parseWebp(bytes, strip);
  } catch {
    out = null;
  }
  if (!out) return { ok: false, reason: 'malformed' };
  const { width, height } = out;
  if (width < 1 || height < 1) return { ok: false, reason: 'malformed' };
  if (width > A2A_REMOTE_IMAGE_LIMITS.MAX_EDGE || height > A2A_REMOTE_IMAGE_LIMITS.MAX_EDGE || width * height > A2A_REMOTE_IMAGE_LIMITS.MAX_PIXELS) {
    return { ok: false, reason: 'dimensions' };
  }
  return { ok: true, bytes: out.bytes, info: { mediaType: type, width, height } };
}

// --- PNG ----------------------------------------------------------------------

const PNG_METADATA = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'caBX']);

function parsePng(b: Uint8Array, strip: boolean): { bytes: Uint8Array; width: number; height: number } | null {
  const keep: Array<[number, number]> = [[0, 8]];
  let at = 8;
  let width = 0;
  let height = 0;
  let first = true;
  for (;;) {
    if (at + 12 > b.length) return null;
    const len = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + len;
    if (len > 0x7fffffff || end > b.length) return null;
    if (first) {
      if (type !== 'IHDR' || len !== 13) return null;
      width = u32be(b, at + 8);
      height = u32be(b, at + 12);
      first = false;
    }
    if (!(strip && PNG_METADATA.has(type))) keep.push([at, end]);
    at = end;
    if (type === 'IEND') break;
  }
  if (!strip && at !== b.length) return null;
  return { bytes: strip ? concat(b, keep) : b, width, height };
}

// --- JPEG ---------------------------------------------------------------------

/** Start-of-frame markers (C4 DHT, C8 JPG and CC DAC are not frames). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Segments the sender drops: APP1 (Exif / XMP), APP11 (JUMBF / C2PA), APP13 (IPTC), COM. APP2 MPF is dropped by its tag. */
const JPEG_METADATA = new Set([0xe1, 0xeb, 0xed, 0xfe]);

function parseJpeg(b: Uint8Array, strip: boolean): { bytes: Uint8Array; width: number; height: number } | null {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let at = 2;
  let width = 0;
  let height = 0;
  let orientation = 1;
  let orientationWritten = false;
  for (;;) {
    if (at + 2 > b.length || b[at] !== 0xff) return null;
    let marker = b[at + 1];
    // Fill bytes before a marker.
    while (marker === 0xff) {
      at += 1;
      if (at + 2 > b.length) return null;
      marker = b[at + 1];
    }
    if (marker === 0xd9) {
      parts.push(b.subarray(at, at + 2));
      at += 2;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > b.length) return null;
    const len = u16be(b, at + 2);
    const end = at + 2 + len;
    if (len < 2 || end > b.length) return null;
    if (SOF.has(marker)) {
      // One frame: a second header would let a small claim hide the real size.
      if (len < 7 || width !== 0) return null;
      height = u16be(b, at + 5);
      width = u16be(b, at + 7);
      if (width === 0 || height === 0) return null;
    }
    if (marker === 0xe1 && strip) {
      const o = exifOrientation(b.subarray(at + 4, end));
      if (o !== null) orientation = o;
    }
    const mpf = marker === 0xe2 && len >= 6 && ascii(b, at + 4, 4) === 'MPF\0';
    if (strip && (JPEG_METADATA.has(marker) || mpf)) {
      // Before the first frame or scan: where an Exif segment belongs.
      if (orientation !== 1 && !orientationWritten) {
        parts.push(orientationSegment(orientation));
        orientationWritten = true;
      }
    } else {
      parts.push(b.subarray(at, end));
    }
    at = end;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not a stuffed
      // byte (FF00) or a restart (FFD0-FFD7).
      const start = at;
      for (;;) {
        if (at + 1 >= b.length) return null;
        if (b[at] === 0xff && b[at + 1] !== 0x00 && !(b[at + 1] >= 0xd0 && b[at + 1] <= 0xd7) && b[at + 1] !== 0xff) break;
        at += 1;
      }
      parts.push(b.subarray(start, at));
    }
  }
  if (width === 0 || height === 0) return null;
  if (!strip && at !== b.length) return null;
  return { bytes: strip ? join(parts) : b, width, height };
}

/** The Orientation tag (0x0112) of an APP1 Exif payload; null when there is none. */
function exifOrientation(p: Uint8Array): number | null {
  if (p.length < 14 || ascii(p, 0, 6) !== 'Exif\0\0') return null;
  const t = p.subarray(6);
  const order = ascii(t, 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const r16 = (o: number): number => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const r32 = (o: number): number => (le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16)) + t[o + 3] * 0x1000000 : t[o] * 0x1000000 + ((t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]));
  if (t.length < 8 || r16(2) !== 42) return null;
  const ifd = r32(4);
  if (ifd + 2 > t.length) return null;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return null;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** APP1 holding an Exif block with only IFD0 Orientation (big-endian TIFF). */
function orientationSegment(orientation: number): Uint8Array {
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // MM, 42, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation SHORT 1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
}

// --- WebP ---------------------------------------------------------------------

const WEBP_METADATA = new Set(['EXIF', 'XMP ']);
/** VP8X flag bits of the EXIF and XMP chunks, and of an animation. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIMATION = 0x02;

/** The size a `VP8 ` / `VP8L` chunk's own header declares, or null when it is malformed. */
function webpImageSize(fourcc: string, data: Uint8Array): { width: number; height: number } | null {
  if (fourcc === 'VP8 ') {
    if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return null;
    return { width: (data[6] | (data[7] << 8)) & 0x3fff, height: (data[8] | (data[9] << 8)) & 0x3fff };
  }
  if (data.length < 5 || data[0] !== 0x2f) return null;
  const bits = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
  return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
}

function parseWebp(b: Uint8Array, strip: boolean): { bytes: Uint8Array; width: number; height: number } | null {
  const riff = u32le(b, 4);
  const end = 8 + riff;
  if (riff < 4 || riff % 2 !== 0 || end > b.length) return null;
  const chunks: Uint8Array[] = [];
  let at = 12;
  let width = 0;
  let height = 0;
  let vp8x: Uint8Array | null = null;
  let firstChunk = true;
  /** A still VP8X image: its image chunk must declare the canvas size. */
  let checkImage = false;
  let imageSeen = false;
  while (at < end) {
    if (at + 8 > end) return null;
    const fourcc = ascii(b, at, 4);
    const size = u32le(b, at + 4);
    const next = at + 8 + size + (size % 2);
    if (next > end) return null;
    const data = b.subarray(at + 8, at + 8 + size);
    if (firstChunk) {
      if (fourcc === 'VP8X') {
        if (size < 10) return null;
        width = 1 + (data[4] | (data[5] << 8) | (data[6] << 16));
        height = 1 + (data[7] | (data[8] << 8) | (data[9] << 16));
        checkImage = (data[0] & VP8X_ANIMATION) === 0;
      } else if (fourcc === 'VP8 ' || fourcc === 'VP8L') {
        const dims = webpImageSize(fourcc, data);
        if (!dims) return null;
        ({ width, height } = dims);
        imageSeen = true;
      } else {
        return null;
      }
      firstChunk = false;
    } else if (checkImage && !imageSeen && (fourcc === 'VP8 ' || fourcc === 'VP8L')) {
      const dims = webpImageSize(fourcc, data);
      if (!dims || dims.width !== width || dims.height !== height) return null;
      imageSeen = true;
    }
    if (!(strip && WEBP_METADATA.has(fourcc))) {
      const chunk = b.slice(at, next);
      if (fourcc === 'VP8X') vp8x = chunk;
      chunks.push(chunk);
    }
    at = next;
  }
  if (firstChunk || (checkImage && !imageSeen)) return null;
  if (!strip) return end === b.length ? { bytes: b, width, height } : null;
  if (vp8x) vp8x[8] &= ~(VP8X_EXIF | VP8X_XMP) & 0xff;
  const body = join(chunks);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 4), 0);
  const size = 4 + body.length;
  head[4] = size & 0xff;
  head[5] = (size >>> 8) & 0xff;
  head[6] = (size >>> 16) & 0xff;
  head[7] = (size >>> 24) & 0xff;
  head.set(b.subarray(8, 12), 8);
  return { bytes: join([head, body]), width, height };
}

// --- bytes --------------------------------------------------------------------

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i]);
  return s;
}

function u16be(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

function u32be(b: Uint8Array, at: number): number {
  return b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
}

function u32le(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;
}

function concat(b: Uint8Array, ranges: ReadonlyArray<[number, number]>): Uint8Array {
  return join(ranges.map(([s, e]) => b.subarray(s, e)));
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
