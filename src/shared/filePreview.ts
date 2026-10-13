// File preview (#2150): which local files open in a read-only preview tab
// instead of the text editor, and the wire contract between the renderer's
// preview tab and the main process that serves the bytes.
//
// The bytes travel over the `wmux-preview:` scheme (src/main/preview). The
// renderer never names a path in a URL: it asks main to open a path, gets an
// unguessable token back, and loads `wmux-preview://<token>/<name>?v=<version>`.

export type PreviewKind = 'image' | 'pdf';

interface PreviewType {
  kind: PreviewKind;
  mime: string;
}

const PREVIEW_TYPES: Record<string, PreviewType> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  avif: { kind: 'image', mime: 'image/avif' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  // Rendered only through <img>, where an SVG's scripts never run.
  svg: { kind: 'image', mime: 'image/svg+xml' },
  pdf: { kind: 'pdf', mime: 'application/pdf' },
};

/** Largest file each kind will serve. Past this the tab says so instead. */
export const PREVIEW_MAX_BYTES: Record<PreviewKind, number> = {
  image: 64 * 1024 * 1024,
  pdf: 256 * 1024 * 1024,
};

export const PREVIEW_PROTOCOL_SCHEME = 'wmux-preview';

/** 128-bit hex. A standard scheme lowercases its host, so hex survives it. */
export const PREVIEW_TOKEN_REGEX = /^[0-9a-f]{32}$/;

function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The preview type for a path, or null when it opens as text. */
export function previewTypeOf(filePath: string): PreviewType | null {
  const ext = extensionOf(filePath);
  // Own keys only: `x.constructor` must not find Object.prototype.constructor.
  return Object.hasOwn(PREVIEW_TYPES, ext) ? PREVIEW_TYPES[ext] : null;
}

export function isPreviewablePath(filePath: string): boolean {
  return previewTypeOf(filePath) !== null;
}

/** Base name of a path, for the tab title and the URL's last segment. */
export function previewFileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

/** How many trailing bytes `looksComplete` needs to see. */
export const PREVIEW_TAIL_BYTES = 1024;

/**
 * Whether a file of this type ends the way a finished one does, judged from
 * its last bytes. Formats with no cheap end marker count as complete; a
 * broken one of those shows up as a decode failure in the view instead.
 */
export function looksComplete(filePath: string, tail: Uint8Array): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const n = tail.length;
  if (n === 0) return false;
  switch (ext) {
    case 'png':
      // IEND chunk type, then its 4-byte CRC, ends the file.
      return n >= 8 && tail[n - 8] === 0x49 && tail[n - 7] === 0x45 && tail[n - 6] === 0x4e && tail[n - 5] === 0x44;
    case 'jpg':
    case 'jpeg':
      // EOI marker, allowing a little trailing padding some encoders add.
      for (let i = n - 2; i >= Math.max(0, n - 64); i--) if (tail[i] === 0xff && tail[i + 1] === 0xd9) return true;
      return false;
    case 'gif':
      return tail[n - 1] === 0x3b;
    case 'pdf': {
      const text = new TextDecoder('latin1').decode(tail);
      return text.includes('%%EOF');
    }
    default:
      return true;
  }
}

/** What main reports about the file behind a token. */
export interface PreviewFileState {
  /** False while the file is missing (deleted, or mid-recreate). */
  exists: boolean;
  /**
   * False when the file's own end marker is missing (a PNG without IEND, a PDF
   * without %%EOF): a writer stopped part-way, or the file is damaged. The
   * view keeps the last complete version instead of showing a torn one.
   */
  complete: boolean;
  size: number;
  mtimeMs: number;
  /** Bumps on every settled change; part of the URL so no cache serves stale bytes. */
  version: number;
}

export type PreviewOpenResult =
  | ({ ok: true; token: string; kind: PreviewKind; mime: string } & PreviewFileState)
  | { ok: false; reason: 'denied' | 'unsupported' | 'too-large' | 'missing' | 'limit' };

export interface PreviewChangedEvent extends PreviewFileState {
  token: string;
}

export function previewUrl(token: string, filePath: string, version: number): string {
  return `${PREVIEW_PROTOCOL_SCHEME}://${token}/${encodeURIComponent(previewFileName(filePath))}?v=${version}`;
}

/** "240 KB", "1.4 MB": the size shown under a preview. */
export function formatPreviewBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
