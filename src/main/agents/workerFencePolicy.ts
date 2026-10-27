// ─── The worker fence's off switch, per workspace ──────────────────────────
//
// An unattended bot worker runs inside the worker fence (botWorkerFence.ts).
// The owner may turn the fence off for one workspace (a bot's workspace: the
// one its fan-outs start from). Kept main-side in the wmux data dir, like the
// fan-out policy (fanoutWorkerPolicy.ts), never in the renderer's
// session.json, which is restored into the renderer and written back freely.
//
// Never widening silently: only a literal `true` under a workspace id turns
// the fence off; a missing or unreadable file, or any other value, leaves it
// on. A worker started while it is off shows that in its pane, and a later
// launch of a session that started fenced stays fenced
// (botWorkerMergeGuard.ts).

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';

/** Most workspaces the file keeps an entry for. */
export const WORKER_FENCE_POLICY_MAX = 256;

export function getWorkerFencePolicyPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'worker-fence-policy.json');
}

function readOff(dir?: string): Record<string, true> {
  try {
    const raw = JSON.parse(fs.readFileSync(getWorkerFencePolicyPath(dir), 'utf8')) as { off?: unknown };
    const off = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.off && typeof raw.off === 'object' && !Array.isArray(raw.off) ? raw.off as Record<string, unknown> : {};
    const out: Record<string, true> = {};
    for (const [id, v] of Object.entries(off)) if (v === true && id.length > 0 && id.length <= 128) out[id] = true;
    return out;
  } catch {
    return {};
  }
}

/** Whether the owner turned the fence off for this workspace. */
export function isWorkerFenceOff(workspaceId: string | null | undefined, dir?: string): boolean {
  if (!workspaceId) return false;
  return Object.prototype.hasOwnProperty.call(readOff(dir), workspaceId);
}

/** Turn the fence off (`off: true`) or back on for a workspace. Only a
 *  literal boolean and a plausible id write; returns the state now in force. */
export async function setWorkerFenceOff(workspaceId: unknown, off: unknown, dir?: string): Promise<boolean> {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0 || workspaceId.length > 128 || typeof off !== 'boolean') {
    return typeof workspaceId === 'string' ? isWorkerFenceOff(workspaceId, dir) : false;
  }
  const next = readOff(dir);
  if (off) next[workspaceId] = true;
  else delete next[workspaceId];
  const ids = Object.keys(next);
  if (ids.length > WORKER_FENCE_POLICY_MAX) throw new Error(`the fence can be off for at most ${WORKER_FENCE_POLICY_MAX} workspaces`);
  await atomicWriteJSON(getWorkerFencePolicyPath(dir), { off: next });
  return off;
}
