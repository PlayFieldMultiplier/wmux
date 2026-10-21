// The batched form of `task.mission.list` (shared/missionListBatch.ts has the
// wire contract and why it exists). Kept out of daemon/index.ts so the authz
// and per-owner rules are testable without the daemon.
//
// Identity: the single form trusts a pre-stamped `verifiedWorkspaceId`
// verbatim (stampChannelCaller rule 1, the documented #113 same-user ceiling),
// and its producers are main's own reads and main's pipe router. The batch
// applies the same rule to every id, and adds one: a request that carries a
// `senderPtyId` names a pane caller, which may read its own workspace only, so
// it is refused whole rather than answered for owners it does not hold. Main's
// router already refuses a batch from anyone but the operator; this is the
// same rule for a client that reaches the daemon pipe directly.

import type { WorkTask } from '../../shared/workTask';
import { MISSION_LIST_BATCH_MAX } from '../../shared/missionListBatch';

type ErrorReply = { ok: false; error: { code: string; message: string } };

export type MissionListBatchEntry =
  | { verifiedWorkspaceId: string; ok: true; tasks: WorkTask[] }
  | ({ verifiedWorkspaceId: string } & ErrorReply);

export type MissionListBatchReply = { ok: true; results: MissionListBatchEntry[] } | ErrorReply;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Answer a `task.mission.list` request that carries `verifiedWorkspaceIds`. */
export function listMissionsBatch(
  params: Record<string, unknown>,
  listMissions: (verifiedWorkspaceId: string) => WorkTask[],
): MissionListBatchReply {
  if (nonEmpty(params['senderPtyId'])) {
    return {
      ok: false,
      error: {
        code: 'NOT_AUTHORIZED',
        message: 'task.mission.list: a pane caller (senderPtyId) cannot read several owners at once',
      },
    };
  }
  if (params['verifiedWorkspaceId'] !== undefined) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message: 'task.mission.list: pass verifiedWorkspaceId or verifiedWorkspaceIds, not both',
      },
    };
  }
  const ids = params['verifiedWorkspaceIds'];
  if (!Array.isArray(ids)) {
    return {
      ok: false,
      error: { code: 'INVALID_ARGUMENT', message: 'task.mission.list: verifiedWorkspaceIds must be an array' },
    };
  }
  if (ids.length > MISSION_LIST_BATCH_MAX) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message: `task.mission.list: at most ${MISSION_LIST_BATCH_MAX} verifiedWorkspaceIds per call (got ${ids.length})`,
      },
    };
  }
  const results: MissionListBatchEntry[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!nonEmpty(id)) {
      // This entry only: the same refusal the single form gives a missing id.
      results.push({
        verifiedWorkspaceId: typeof id === 'string' ? id : '',
        ok: false,
        error: { code: 'NOT_AUTHORIZED', message: 'task.mission.list: a server-resolved verifiedWorkspaceId is required' },
      });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({ verifiedWorkspaceId: id, ok: true, tasks: listMissions(id) });
  }
  return { ok: true, results };
}
