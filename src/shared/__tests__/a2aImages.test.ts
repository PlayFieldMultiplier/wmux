// The byte checks and the metadata strip for cross-PC A2A images: golden
// containers built here, compared byte for byte after the strip.
import { describe, expect, it } from 'vitest';
import { inspectA2aImage, prepareA2aImage, sniffA2aImage } from '../a2aImages';

const u8 = (...parts: Array<number[] | Uint8Array | string>): Uint8Array => {
  const bytes: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const c of p) bytes.push(c.charCodeAt(0));
    else bytes.push(...p);
  }
  return Uint8Array.from(bytes);
};
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const be16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];

// --- PNG ---
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngChunk = (type: string, data: number[]): Uint8Array => u8(be32(data.length), type, data, [1, 2, 3, 4]);
const ihdr = (w: number, h: number): Uint8Array => pngChunk('IHDR', [...be32(w), ...be32(h), 8, 2, 0, 0, 0]);
const idat = pngChunk('IDAT', [0x78, 0x9c, 0x01, 0x02]);
const iend = pngChunk('IEND', []);
const text = pngChunk('tEXt', [...'GPS\0here'].map((c) => c.charCodeAt(0)));
const exif = pngChunk('eXIf', [0x4d, 0x4d, 0, 42]);

// --- JPEG ---
const seg = (marker: number, data: number[]): Uint8Array => u8([0xff, marker], be16(data.length + 2), data);
const app0 = seg(0xe0, [...'JFIF\0'].map((c) => c.charCodeAt(0)).concat([1, 1, 0, 0, 1, 0, 1, 0, 0]));
/** Exif APP1, little-endian TIFF, IFD0 holding Orientation and one more tag. */
const exifApp1 = (orientation: number): Uint8Array => seg(0xe1, [
  ...'Exif\0\0'.split('').map((c) => c.charCodeAt(0)),
  0x49, 0x49, 42, 0, 8, 0, 0, 0,
  2, 0,
  0x0f, 0x01, 2, 0, 4, 0, 0, 0, 0x41, 0x42, 0x43, 0, // Make "ABC"
  0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0,
  0, 0, 0, 0,
]);
const xmpApp1 = seg(0xe1, [...'http://ns.adobe.com/xap/1.0/\0<x/>'].map((c) => c.charCodeAt(0)));
const com = seg(0xfe, [...'secret'].map((c) => c.charCodeAt(0)));
const sof0 = (w: number, h: number): Uint8Array => seg(0xc0, [8, ...be16(h), ...be16(w), 1, 1, 0x11, 0]);
const dqt = seg(0xdb, [0, ...new Array(64).fill(1)]);
const sos = seg(0xda, [1, 1, 0, 0, 63, 0]);
// Entropy data with a stuffed byte and a restart marker inside.
const scan = u8([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);
const eoi = u8([0xff, 0xd9]);
const orientationOnly = (o: number): Uint8Array => seg(0xe1, [
  ...'Exif\0\0'.split('').map((c) => c.charCodeAt(0)),
  0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0,
]);

// --- WebP ---
const riffChunk = (fourcc: string, data: number[]): Uint8Array => u8(fourcc, le32(data.length), data, data.length % 2 ? [0] : []);
const webp = (...chunks: Uint8Array[]): Uint8Array => {
  const body = u8(...chunks);
  return u8('RIFF', le32(4 + body.length), 'WEBP', body);
};
const vp8x = (flags: number, w: number, h: number): Uint8Array =>
  riffChunk('VP8X', [flags, 0, 0, 0, (w - 1) & 0xff, ((w - 1) >> 8) & 0xff, 0, (h - 1) & 0xff, ((h - 1) >> 8) & 0xff, 0]);
/** VP8L: signature, then 14-bit (w-1) and 14-bit (h-1). */
const vp8l = (w: number, h: number): Uint8Array => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riffChunk('VP8L', [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0]);
};

describe('sniffA2aImage', () => {
  it('names PNG, JPEG and WebP by their bytes and nothing else', () => {
    expect(sniffA2aImage(u8(PNG_SIG, ihdr(1, 1)))).toBe('image/png');
    expect(sniffA2aImage(u8([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffA2aImage(webp(vp8l(1, 1)))).toBe('image/webp');
    expect(sniffA2aImage(u8('GIF89a', [1, 0, 1, 0]))).toBeNull();
    expect(sniffA2aImage(u8('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffA2aImage(u8('<html><body>png</body></html>'))).toBeNull();
    // A RIFF that is not WebP (WAV).
    expect(sniffA2aImage(u8('RIFF', le32(4), 'WAVE'))).toBeNull();
  });
});

describe('prepareA2aImage — PNG', () => {
  it('drops text and Exif chunks and anything after IEND', () => {
    const src = u8(PNG_SIG, ihdr(640, 480), text, idat, exif, iend, 'PK\x03\x04trailing-zip');
    const out = prepareA2aImage(src);
    expect(out).toMatchObject({ ok: true, info: { mediaType: 'image/png', width: 640, height: 480 } });
    expect(out.ok && Array.from(out.bytes)).toEqual(Array.from(u8(PNG_SIG, ihdr(640, 480), idat, iend)));
  });

  it('refuses a PNG without IEND or with IHDR not first, never sending it as is', () => {
    expect(prepareA2aImage(u8(PNG_SIG, ihdr(2, 2), idat))).toEqual({ ok: false, reason: 'malformed' });
    expect(prepareA2aImage(u8(PNG_SIG, idat, ihdr(2, 2), iend))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a header that declares a decompression-bomb size', () => {
    expect(inspectA2aImage(u8(PNG_SIG, ihdr(100_000, 100_000), idat, iend))).toEqual({ ok: false, reason: 'dimensions' });
    expect(inspectA2aImage(u8(PNG_SIG, ihdr(16_000, 16_000), idat, iend))).toEqual({ ok: false, reason: 'dimensions' });
    expect(inspectA2aImage(u8(PNG_SIG, ihdr(16_384, 2_000), idat, iend))).toMatchObject({ ok: true });
  });
});

describe('prepareA2aImage — JPEG', () => {
  it('drops Exif, XMP and comments but keeps a non-default orientation as a one-tag Exif', () => {
    const src = u8([0xff, 0xd8], app0, exifApp1(6), xmpApp1, com, dqt, sof0(800, 600), sos, scan, eoi, 'junk');
    const out = prepareA2aImage(src);
    expect(out).toMatchObject({ ok: true, info: { mediaType: 'image/jpeg', width: 800, height: 600 } });
    expect(out.ok && Array.from(out.bytes)).toEqual(Array.from(u8([0xff, 0xd8], app0, orientationOnly(6), dqt, sof0(800, 600), sos, scan, eoi)));
  });

  it('writes no Exif at all for the default orientation', () => {
    const out = prepareA2aImage(u8([0xff, 0xd8], exifApp1(1), dqt, sof0(10, 20), sos, scan, eoi));
    expect(out.ok && Array.from(out.bytes)).toEqual(Array.from(u8([0xff, 0xd8], dqt, sof0(10, 20), sos, scan, eoi)));
  });

  it('refuses a truncated JPEG (no EOI) and one with no frame', () => {
    expect(prepareA2aImage(u8([0xff, 0xd8], app0, sof0(10, 10), sos, scan))).toEqual({ ok: false, reason: 'malformed' });
    expect(prepareA2aImage(u8([0xff, 0xd8], app0, eoi))).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('prepareA2aImage — WebP', () => {
  it('drops EXIF and XMP chunks, clears their VP8X flags and rewrites the RIFF size', () => {
    const exifChunk = riffChunk('EXIF', [1, 2, 3]); // odd size: padded
    const xmpChunk = riffChunk('XMP ', [4, 5, 6, 7]);
    const src = u8(webp(vp8x(0x08 | 0x04 | 0x10, 300, 200), vp8l(300, 200), exifChunk, xmpChunk), 'after-riff');
    const out = prepareA2aImage(src);
    expect(out).toMatchObject({ ok: true, info: { mediaType: 'image/webp', width: 300, height: 200 } });
    expect(out.ok && Array.from(out.bytes)).toEqual(Array.from(webp(vp8x(0x10, 300, 200), vp8l(300, 200))));
  });

  it('reads a simple lossless WebP and refuses a chunk running past the RIFF', () => {
    expect(inspectA2aImage(webp(vp8l(17, 9)))).toEqual({ ok: true, info: { mediaType: 'image/webp', width: 17, height: 9 } });
    const bad = webp(vp8l(2, 2));
    bad[16] = 0xff; // the VP8L chunk size
    expect(inspectA2aImage(bad)).toEqual({ ok: false, reason: 'malformed' });
  });
});
