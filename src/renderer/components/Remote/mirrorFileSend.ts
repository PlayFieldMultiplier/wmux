import type { RemoteSendFailure, RemoteWriteResult } from '../../../shared/remoteUpload';
import type { TranslationKey } from '../../i18n/locales/en';
import { t as translate } from '../../i18n';
import { useStore } from '../../stores';

// ─── Files dropped on another PC's pane ──────────────────────────────────────
//
// The app-wide drop handler (AppLayout) knows which surface is active, and only
// the mirror showing it knows its attach and whether the remote app asked for
// bracketed paste. Each mirror shown as a tab registers here under its own
// surface id; a drop on that surface is handed to it, with the function that
// names the OS drop to main.

/** Names an OS drop to main by a one-use token (from preload's onFileDrop). */
export type RegisterDrop = () => Promise<string | null>;
type DropTarget = (registerDrop: RegisterDrop) => void;

const dropTargets = new Map<string, DropTarget>();

/** Take drops for this surface until the returned function runs. */
export function registerMirrorDropTarget(surfaceId: string, target: DropTarget): () => void {
  dropTargets.set(surfaceId, target);
  return () => {
    if (dropTargets.get(surfaceId) === target) dropTargets.delete(surfaceId);
  };
}

/** Hand a drop to the mirror shown in this surface; false when none is mounted. */
export function deliverMirrorDrop(surfaceId: string, registerDrop: RegisterDrop): boolean {
  const target = dropTargets.get(surfaceId);
  if (!target) return false;
  target(registerDrop);
  return true;
}

type WriteFailure = Exclude<RemoteWriteResult, { ok: true }>['reason'];

/** Every reason a send can end with: the upload's, or the typed write's. */
export type RemoteSendNotice = RemoteSendFailure | `write-${WriteFailure}`;

const NOTICE_KEYS: Record<RemoteSendNotice, TranslationKey> = {
  'read-only': 'remote.mirror.send.read-only',
  'not-connected': 'remote.mirror.send.not-connected',
  'pane-changed': 'remote.mirror.send.pane-changed',
  'already-sending': 'remote.mirror.send.already-sending',
  'too-many': 'remote.mirror.send.too-many',
  'not-a-file': 'remote.mirror.send.not-a-file',
  'too-large': 'remote.mirror.send.too-large',
  'no-image': 'remote.mirror.send.no-image',
  'uploads-disabled': 'remote.mirror.send.uploads-disabled',
  'photos-only': 'remote.mirror.send.photos-only',
  unsupported: 'remote.mirror.send.unsupported',
  busy: 'remote.mirror.send.busy',
  full: 'remote.mirror.send.full',
  'host-unknown': 'remote.mirror.send.host-unknown',
  'bad-path': 'remote.mirror.send.bad-path',
  unquotable: 'remote.mirror.send.unquotable',
  auth: 'remote.mirror.send.auth',
  failed: 'remote.mirror.send.failed',
  'write-prompt-active': 'remote.mirror.send.prompt-active',
  'write-auth': 'remote.mirror.send.auth',
  'write-not-connected': 'remote.mirror.send.pane-changed',
  'write-failed': 'remote.mirror.send.write-failed',
  'write-unknown': 'remote.mirror.send.write-unknown',
};

/** A send that ended without typing (or may have typed) is a warning toast naming why. */
export function showRemoteSendNotice(notice: RemoteSendNotice, host: string): void {
  useStore.getState().pushToast({ level: 'warn', message: translate(NOTICE_KEYS[notice], { host }) });
}
