// ─── Remote spawn policy: renderer helpers ──────────────────────────────────
//
// Reading and saving this PC's policy for other PCs starting new agents here,
// and the small pure edits the Settings section and the Remote page make to
// it. The daemon is the source of truth: it checks and realpaths each folder
// and bumps `version`, so a save always takes the policy it returns.

import {
  coerceSpawnPolicy,
  SPAWN_LABEL_MAX,
  type A2aSpawnPolicySetResult,
  type A2aSpawnPolicyV1,
  type A2aSpawnRootV1,
} from '../../../shared/a2aSpawn';

export type SpawnPolicySaveResult = A2aSpawnPolicySetResult;

const ROOT_ID_MAX = 32;

/** The policy as the daemon holds it; null when it cannot be read or is not one. */
export async function readSpawnPolicy(): Promise<A2aSpawnPolicyV1 | null> {
  const get = window.electronAPI?.a2aRemote?.spawnPolicyGet;
  if (!get) return null;
  try {
    return coerceSpawnPolicy((await get())?.policy);
  } catch {
    return null;
  }
}

/**
 * Saves the whole policy. A refusal carries the daemon's own reason;
 * `fallback` is the message for a save that never got an answer.
 */
export async function saveSpawnPolicy(policy: A2aSpawnPolicyV1, fallback: string): Promise<SpawnPolicySaveResult> {
  const set = window.electronAPI?.a2aRemote?.spawnPolicySet;
  if (!set) return { ok: false, error: fallback };
  try {
    const r = await set(policy);
    if (r?.ok === true) {
      const saved = coerceSpawnPolicy(r.policy);
      return saved ? { ok: true, policy: saved } : { ok: false, error: fallback };
    }
    const error = typeof r?.error === 'string' && r.error ? r.error : fallback;
    // Changed elsewhere since it was read (another window, a removed PC): the caller reads it again.
    return r && 'conflict' in r && r.conflict === true ? { ok: false, error, conflict: true } : { ok: false, error };
  } catch {
    return { ok: false, error: fallback };
  }
}

/** Whether that PC may start agents here (its own opt-in, not the master switch). */
export function hostAllowed(policy: A2aSpawnPolicyV1, hostId: string): boolean {
  return policy.hosts[hostId]?.allowed === true;
}

/** The policy with that PC's opt-in set; everything else unchanged. */
export function withHostAllowed(policy: A2aSpawnPolicyV1, hostId: string, allowed: boolean): A2aSpawnPolicyV1 {
  return { ...policy, hosts: { ...policy.hosts, [hostId]: { allowed } } };
}

/** The last segment of a POSIX or Windows path. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * A root id (`[a-z0-9][a-z0-9-]{0,31}`) from a folder's name, with a random
 * suffix so that a folder added later never reuses the id of one removed
 * (or of another with no usable letters, such as a CJK name: `folder-…`).
 */
export function makeRootId(name: string, taken: readonly string[], random: () => string = randomSuffix): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ROOT_ID_MAX - SUFFIX_LEN - 1)
    .replace(/-+$/, '') || 'folder';
  for (;;) {
    const id = `${base}-${random()}`;
    if (!taken.includes(id)) return id;
  }
}

const SUFFIX_LEN = 6;

function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LEN);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

/** A new allowed folder for `path`, labelled by its name. */
export function rootFromPath(path: string, roots: readonly A2aSpawnRootV1[]): A2aSpawnRootV1 {
  const name = folderName(path);
  const label = name.trim().slice(0, SPAWN_LABEL_MAX) || 'folder';
  return { id: makeRootId(name, roots.map((r) => r.id)), label, path };
}
