import { promises as fsp } from 'fs';
import * as path from 'path';
import { REMOTE_UPLOAD_LIMITS, remoteUploadPathText, type RemoteSendFailure, type RemoteSendResult } from '../../shared/remoteUpload';
import { sniffRoomImage } from '../../shared/roomAttachments';
import { isRemoteAuthRejected, type RemoteUploadResult } from './RemoteHostClient';

// ─── Send files to a remote-terminal pane ────────────────────────────────────
//
// Upload each file to the host one at a time, then type the host's paths into
// the pane in one write, unsent. All or nothing: a refusal anywhere types
// nothing (what was already uploaded expires on the host by its TTL).

/** One file ready to send: its bytes and the name its extension comes from. */
export interface RemoteSendFile {
  name: string;
  bytes: Uint8Array;
}

/** What main knows about the pane and its host, from the last config probe. */
export interface RemoteSendTarget {
  allowInput?: boolean;
  allowUpload?: boolean;
  generalFileUpload?: boolean;
  /** The pane's shell enters WSL on a Windows host. */
  wsl?: boolean;
  /** The remote app asked for bracketed paste (DECSET 2004). */
  bracketed: boolean;
}

export interface RemoteSendDeps {
  upload: (bytes: Uint8Array, ext: string | null) => Promise<RemoteUploadResult>;
  write: (data: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** The one wait before retrying a 429 (the host has four upload slots). */
export const REMOTE_UPLOAD_RETRY_MS = 1_500;

const UPLOADS_DISABLED_TAG = 'uploads-disabled:';
const PROMPT_ACTIVE_TAG = 'terminal-prompt-active';

/** The extension `/api/upload-file` takes: 1-12 ASCII alphanumerics, else `bin`. */
function fileExtension(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : 'bin';
}

function uploadFailure(status: number, error: string): RemoteSendFailure {
  if (status === 403 && error.startsWith(UPLOADS_DISABLED_TAG)) return 'uploads-disabled';
  if (status === 413) return 'too-large';
  if (status === 415) return 'unsupported';
  if (status === 429) return 'busy';
  if (status === 507) return 'full';
  return 'failed';
}

/**
 * Read dropped paths for sending: regular files only, each at most the host's
 * cap, at most MAX_FILES of them. Checked before a byte goes on the wire.
 */
export async function readDroppedFiles(paths: readonly string[]): Promise<RemoteSendFile[] | { reason: RemoteSendFailure }> {
  if (paths.length === 0) return { reason: 'not-a-file' };
  if (paths.length > REMOTE_UPLOAD_LIMITS.MAX_FILES) return { reason: 'too-many' };
  const files: RemoteSendFile[] = [];
  for (const p of paths) {
    const stat = await fsp.stat(p).catch(() => null);
    if (!stat || !stat.isFile()) return { reason: 'not-a-file' };
    if (stat.size > REMOTE_UPLOAD_LIMITS.MAX_BYTES) return { reason: 'too-large' };
    const bytes = await fsp.readFile(p).catch(() => null);
    if (!bytes || bytes.length > REMOTE_UPLOAD_LIMITS.MAX_BYTES) return { reason: bytes ? 'too-large' : 'not-a-file' };
    files.push({ name: path.basename(p), bytes });
  }
  return files;
}

export async function sendFilesToRemote(
  files: readonly RemoteSendFile[],
  target: RemoteSendTarget,
  deps: RemoteSendDeps,
): Promise<RemoteSendResult> {
  const fail = (reason: RemoteSendFailure): RemoteSendResult => ({ ok: false, reason });
  if (target.allowInput === false) return fail('read-only');
  if (files.length === 0) return fail('not-a-file');
  if (files.length > REMOTE_UPLOAD_LIMITS.MAX_FILES) return fail('too-many');
  if (target.allowUpload === false) return fail('uploads-disabled');
  const routes = files.map((f) => (sniffRoomImage(f.bytes) ? null : fileExtension(f.name)));
  // A host that does not advertise general files takes JPEG and PNG only.
  if (target.generalFileUpload !== true && routes.some((ext) => ext !== null)) return fail('photos-only');
  for (const f of files) if (f.bytes.length > REMOTE_UPLOAD_LIMITS.MAX_BYTES) return fail('too-large');

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const texts: string[] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      let res = await deps.upload(files[i].bytes, routes[i]);
      if (!res.ok && res.status === 429) {
        await sleep(REMOTE_UPLOAD_RETRY_MS);
        res = await deps.upload(files[i].bytes, routes[i]);
      }
      if (!res.ok) return fail(uploadFailure(res.status, res.error));
      const typed = remoteUploadPathText(res.path, { wsl: target.wsl });
      if (!typed.ok) return fail(typed.reason);
      texts.push(typed.text);
    }
  } catch (err) {
    return fail(isRemoteAuthRejected(err) ? 'auth' : 'failed');
  }

  const text = texts.join(' ');
  try {
    await deps.write(target.bracketed ? `\x1b[200~${text}\x1b[201~` : text);
  } catch (err) {
    if (isRemoteAuthRejected(err)) return fail('auth');
    return fail(err instanceof Error && err.message.startsWith(PROMPT_ACTIVE_TAG) ? 'prompt-active' : 'failed');
  }
  return { ok: true, count: files.length };
}
