import { UPLOAD_NAME_RE } from './roomAttachments';
import { quotePosixPath, toWslPath } from './imagePaste';

// ─── Files sent to another PC's pane ─────────────────────────────────────────
//
// A file dropped or an image pasted on a remote-terminal mirror is uploaded to
// the host (`POST /api/upload` or `/api/upload-file`), and the path the host
// answers with is typed into the pane, unsent. That path comes from ANOTHER
// machine and lands in a live shell, so it is typed only when it is exactly
// the shape the host's upload route produces and every character is one that
// needs no shell interpretation.

export const REMOTE_UPLOAD_LIMITS = {
  /** Files one drop may carry (one at a time on the wire, all or nothing). */
  MAX_FILES: 4,
  /** The host's per-request cap (`MAX_UPLOAD_BYTES` in WebTerminalServer). */
  MAX_BYTES: 10 * 1024 * 1024,
  /** The longest host path typed into a pane. */
  MAX_PATH_CHARS: 512,
} as const;

/** Why a send ended without typing anything. One toast each. */
export type RemoteSendFailure =
  | 'read-only'
  | 'not-connected'
  | 'too-many'
  | 'not-a-file'
  | 'too-large'
  | 'no-image'
  | 'uploads-disabled'
  | 'photos-only'
  | 'unsupported'
  | 'busy'
  | 'full'
  | 'bad-path'
  | 'unquotable'
  | 'prompt-active'
  | 'auth'
  | 'failed';

export type RemoteSendResult = { ok: true; count: number } | { ok: false; reason: RemoteSendFailure };

/** What the renderer hands main: dropped paths, or "the clipboard's image". */
export type RemoteSendSource = { kind: 'drop'; paths: string[] } | { kind: 'clipboard-image' };

/** C0, DEL and C1: an ESC here could end a bracketed paste and run the rest. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
/** Characters a POSIX path may hold to be typed (single-quoted when needed). */
const POSIX_SAFE_RE = /^[A-Za-z0-9_\-./ +@%,=~]+$/;
/** Characters a Windows path may hold: nothing cmd or PowerShell expands inside double quotes. */
const WINDOWS_SAFE_RE = /^[A-Za-z0-9_\-.:\\ ]+$/;
const WINDOWS_ABS_RE = /^[A-Za-z]:\\/;

/**
 * The text to type for a path the host's upload route answered with, or why
 * it is refused. `bad-path`: not the shape the route produces (a hostile or
 * broken host). `unquotable`: the right shape, but a character this version
 * will not type into a shell (an apostrophe in a user name, `&`, `$`).
 */
export function remoteUploadPathText(
  hostPath: unknown,
  opts: { wsl?: boolean } = {},
): { ok: true; text: string } | { ok: false; reason: 'bad-path' | 'unquotable' } {
  if (typeof hostPath !== 'string' || hostPath.length === 0 || hostPath.length > REMOTE_UPLOAD_LIMITS.MAX_PATH_CHARS) {
    return { ok: false, reason: 'bad-path' };
  }
  if (CONTROL_RE.test(hostPath)) return { ok: false, reason: 'bad-path' };
  const segments = hostPath.split(/[/\\]/);
  const name = segments[segments.length - 1] ?? '';
  if (segments.length < 4 || segments[segments.length - 3] !== 'uploads' || segments[segments.length - 2] !== 'phone' || !UPLOAD_NAME_RE.test(name)) {
    return { ok: false, reason: 'bad-path' };
  }
  if (hostPath.startsWith('/')) {
    if (!POSIX_SAFE_RE.test(hostPath)) return { ok: false, reason: 'unquotable' };
    return { ok: true, text: quotePosixPath(hostPath) };
  }
  if (WINDOWS_ABS_RE.test(hostPath)) {
    if (!WINDOWS_SAFE_RE.test(hostPath)) return { ok: false, reason: 'unquotable' };
    if (opts.wsl) {
      const mapped = toWslPath(hostPath);
      return mapped ? { ok: true, text: quotePosixPath(mapped) } : { ok: false, reason: 'bad-path' };
    }
    return { ok: true, text: `"${hostPath}"` };
  }
  return { ok: false, reason: 'bad-path' };
}
