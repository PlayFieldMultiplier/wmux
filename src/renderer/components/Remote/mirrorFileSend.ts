import type { RemoteSendFailure, RemoteSendResult } from '../../../shared/remoteUpload';
import type { TranslationKey } from '../../i18n/locales/en';
import { t as translate } from '../../i18n';
import { useStore } from '../../stores';

// ─── Files dropped on another PC's pane ──────────────────────────────────────
//
// The app-wide drop handler (AppLayout) knows which surface is active, and only
// the mirror showing it knows its attach and whether the remote app asked for
// bracketed paste. Each mounted mirror registers here under its host and
// session; a drop on that surface is handed to it.

type DropTarget = (paths: string[]) => void;

const dropTargets = new Map<string, DropTarget>();

const targetKey = (hostId: string, sessionId: string): string => `${hostId}\u0000${sessionId}`;

/** Take drops for this host's session until the returned function runs. */
export function registerMirrorDropTarget(hostId: string, sessionId: string, target: DropTarget): () => void {
  const key = targetKey(hostId, sessionId);
  dropTargets.set(key, target);
  return () => {
    if (dropTargets.get(key) === target) dropTargets.delete(key);
  };
}

/** Hand a drop to the mirror showing this session; false when none is mounted. */
export function deliverMirrorDrop(hostId: string | undefined, sessionId: string | undefined, paths: string[]): boolean {
  const target = hostId && sessionId ? dropTargets.get(targetKey(hostId, sessionId)) : undefined;
  if (!target) return false;
  target(paths);
  return true;
}

const FAILURE_KEYS: Record<RemoteSendFailure, TranslationKey> = {
  'read-only': 'remote.mirror.send.read-only',
  'not-connected': 'remote.mirror.send.not-connected',
  'too-many': 'remote.mirror.send.too-many',
  'not-a-file': 'remote.mirror.send.not-a-file',
  'too-large': 'remote.mirror.send.too-large',
  'no-image': 'remote.mirror.send.no-image',
  'uploads-disabled': 'remote.mirror.send.uploads-disabled',
  'photos-only': 'remote.mirror.send.photos-only',
  unsupported: 'remote.mirror.send.unsupported',
  busy: 'remote.mirror.send.busy',
  full: 'remote.mirror.send.full',
  'bad-path': 'remote.mirror.send.bad-path',
  unquotable: 'remote.mirror.send.unquotable',
  'prompt-active': 'remote.mirror.send.prompt-active',
  auth: 'remote.mirror.send.auth',
  failed: 'remote.mirror.send.failed',
};

/** A refused send is a warning toast naming why; a sent one shows in the pane itself. */
export function showRemoteSendResult(result: RemoteSendResult, host: string): void {
  if (result.ok) return;
  useStore.getState().pushToast({ level: 'warn', message: translate(FAILURE_KEYS[result.reason], { host }) });
}
