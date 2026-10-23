import type { Workspace } from '../../shared/types';
import { isHostId } from '../../shared/a2aRemote';
import { isSpawnId, type A2aRemoteSpawnedBy } from '../../shared/a2aSpawn';
import { agentRow, isAgentSlug } from '../../shared/agentIdentity';
import { t } from '../i18n';

// A workspace another PC started here (`fanout.spawnWorkspace` param
// `remoteSpawnedBy`). It rides on the workspace object itself, so the session
// save (`...ws` in buildSessionData) and load keep it for the workspace's whole
// life; `Workspace` in shared/types has no field for it yet, hence this type.
export type RemoteSpawnedWorkspace = Workspace & { remoteSpawnedBy?: A2aRemoteSpawnedBy };

/** Longest PC name the chip and toast take. */
export const REMOTE_SPAWNED_BY_NAME_MAX = 64;

/** The value, strictly; null when it is not exactly one (it is then ignored). */
export function parseRemoteSpawnedBy(raw: unknown): A2aRemoteSpawnedBy | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = o['name'];
  if (!isHostId(o['hostId']) || !isSpawnId(o['spawnId']) || !isAgentSlug(o['agent'])) return null;
  if (typeof name !== 'string' || !name.trim() || name.length > REMOTE_SPAWNED_BY_NAME_MAX) return null;
  return { hostId: o['hostId'], name, spawnId: o['spawnId'], agent: o['agent'] };
}

export function readRemoteSpawnedBy(ws: Workspace | undefined): A2aRemoteSpawnedBy | undefined {
  return (ws as RemoteSpawnedWorkspace | undefined)?.remoteSpawnedBy;
}

/** The one toast a remote start shows. Never the prompt: it is not in the value. */
export function remoteSpawnToastMessage(by: A2aRemoteSpawnedBy): string {
  return t('remoteSpawn.toast', { name: by.name, agent: agentRow(by.agent)?.display ?? by.agent });
}
