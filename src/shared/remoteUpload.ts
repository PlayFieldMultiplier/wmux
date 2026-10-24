import { UPLOAD_NAME_RE } from './roomAttachments';
import { toWslPath } from './imagePaste';

// ─── Files sent to another PC's pane ─────────────────────────────────────────
//
// A file dropped or an image pasted on a remote-terminal mirror is uploaded to
// the host (`POST /api/upload` or `/api/upload-file`), and the path the host
// answers with is typed into the pane, unsent. That path comes from another
// machine and lands at a shell prompt, so it is typed only when it is exactly
// the shape the host's upload route produces, in the host's own path syntax,
// and every character is one that needs no shell interpretation.

export const REMOTE_UPLOAD_LIMITS = {
  /** Files one drop may carry (one at a time on the wire, all or nothing). */
  MAX_FILES: 4,
  /** The host's per-request cap (`MAX_UPLOAD_BYTES` in WebTerminalServer). */
  MAX_BYTES: 10 * 1024 * 1024,
  /** The longest host path typed into a pane. */
  MAX_PATH_CHARS: 512,
  /** The largest clipboard image encoded for sending (a 6K screen fits). */
  MAX_CLIPBOARD_PIXELS: 25_000_000,
} as const;

/** Why a send ended before anything was typed. One toast each. */
export type RemoteSendFailure =
  | 'read-only'
  | 'not-connected'
  | 'pane-changed'
  | 'already-sending'
  | 'too-many'
  | 'not-a-file'
  | 'too-large'
  | 'no-image'
  | 'uploads-disabled'
  | 'photos-only'
  | 'unsupported'
  | 'busy'
  | 'full'
  | 'host-unknown'
  | 'bad-path'
  | 'unquotable'
  | 'auth'
  | 'failed';

/** Uploaded: `text` is the host paths, quoted, ready to type. */
export type RemoteSendResult = { ok: true; text: string; count: number } | { ok: false; reason: RemoteSendFailure };

/**
 * Typing the paths. `failed`: the host answered and applied nothing.
 * `unknown`: the request may have reached the pane before it failed.
 */
export type RemoteWriteResult =
  | { ok: true }
  | { ok: false; reason: 'prompt-active' | 'auth' | 'not-connected' | 'failed' | 'unknown' };

/**
 * What the renderer hands main: a drop (by the token main issued for that OS
 * drop, never by path) or "the clipboard's image".
 */
export type RemoteSendSource = { kind: 'drop'; token: string } | { kind: 'clipboard-image' };

/** C0, DEL and C1 control characters. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
/** Characters a POSIX path may hold to be typed. No `'`, so single quotes always hold it. */
const POSIX_SAFE_RE = /^[A-Za-z0-9_\-./ +@%,=~]+$/;
/** Characters a Windows path may hold: nothing cmd or PowerShell expands inside double quotes. */
const WINDOWS_SAFE_RE = /^[A-Za-z0-9_\-.:\\ ]+$/;
const WINDOWS_ABS_RE = /^[A-Za-z]:\\/;

type PathText = { ok: true; text: string } | { ok: false; reason: 'bad-path' | 'unquotable' | 'host-unknown' };

/** `rest` ends in uploads/phone/<generated name>, with no empty, `.` or `..` segment. */
function isUploadTail(rest: string[]): boolean {
  if (rest.length < 3 || rest.some((s) => s === '' || s === '.' || s === '..')) return false;
  const n = rest.length;
  return rest[n - 3] === 'uploads' && rest[n - 2] === 'phone' && UPLOAD_NAME_RE.test(rest[n - 1]);
}

function posixPathText(p: string): PathText {
  if (!p.startsWith('/') || !isUploadTail(p.slice(1).split('/'))) return { ok: false, reason: 'bad-path' };
  if (!POSIX_SAFE_RE.test(p)) return { ok: false, reason: 'unquotable' };
  return { ok: true, text: `'${p}'` };
}

/**
 * The text to type for a path the host's upload route answered with, or why
 * it is refused. The host's OS (from its `/api/config`) picks the syntax and
 * the quoting, never the path's own first character; unknown, nothing is
 * typed. `bad-path`: not the shape the route produces. `unquotable`: the right
 * shape, with a character this version does not type (an apostrophe in a user
 * name, `&`, `%`).
 */
export function remoteUploadPathText(
  hostPath: unknown,
  opts: { hostPlatform?: string; wsl?: boolean },
): PathText {
  if (typeof hostPath !== 'string' || hostPath.length === 0 || hostPath.length > REMOTE_UPLOAD_LIMITS.MAX_PATH_CHARS) {
    return { ok: false, reason: 'bad-path' };
  }
  if (CONTROL_RE.test(hostPath)) return { ok: false, reason: 'bad-path' };
  if (!opts.hostPlatform) return { ok: false, reason: 'host-unknown' };
  if (opts.hostPlatform !== 'win32') return posixPathText(hostPath);
  if (!WINDOWS_ABS_RE.test(hostPath) || !isUploadTail(hostPath.slice(3).split('\\'))) return { ok: false, reason: 'bad-path' };
  if (!WINDOWS_SAFE_RE.test(hostPath)) return { ok: false, reason: 'unquotable' };
  if (!opts.wsl) return { ok: true, text: `"${hostPath}"` };
  // The pane is a WSL shell: the /mnt form, checked again as the POSIX path it now is.
  const mapped = toWslPath(hostPath);
  return mapped ? posixPathText(mapped) : { ok: false, reason: 'bad-path' };
}
