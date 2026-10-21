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
import {
  MISSION_LIST_BATCH_MAX,
  MISSION_LIST_BATCH_MAX_CHARS,
  MISSION_LIST_DEFERRED,
  MISSION_LIST_ID_MAX_CHARS,
  MISSION_LIST_REPLY_MAX_CHARS,
  MISSION_LIST_REPLY_TOO_LARGE,
} from '../../shared/missionListBatch';

type ErrorReply = { ok: false; error: { code: string; message: string; chars?: number } };

export type MissionListBatchEntry =
  | { verifiedWorkspaceId: string; ok: true; tasks: WorkTask[] }
  | ({ verifiedWorkspaceId: string } & ErrorReply);

export type MissionListBatchReply = { ok: true; results: MissionListBatchEntry[] } | ErrorReply;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

const badId = (verifiedWorkspaceId: string): MissionListBatchEntry => ({
  verifiedWorkspaceId,
  ok: false,
  error: { code: 'NOT_AUTHORIZED', message: 'task.mission.list: a server-resolved verifiedWorkspaceId is required' },
});

const deferred = (verifiedWorkspaceId: string): MissionListBatchEntry => ({
  verifiedWorkspaceId,
  ok: false,
  error: { code: MISSION_LIST_DEFERRED, message: 'task.mission.list: past this reply size budget, ask again' },
});

const tooLarge = (verifiedWorkspaceId: string, chars: number): MissionListBatchEntry => ({
  verifiedWorkspaceId,
  ok: false,
  error: {
    code: MISSION_LIST_REPLY_TOO_LARGE,
    message: 'task.mission.list: this owner alone is too large for a batch reply; use the single form',
    chars,
  },
});

/** Characters one entry adds to the reply line (its JSON and a comma). */
const entryChars = (entry: MissionListBatchEntry): number => JSON.stringify(entry).length + 1;

/** The most a reply entry that answers no owner can take: the longest of the
 *  three, with the longest id a batch echoes and a 9-digit size. */
const MAX_STUB_CHARS = Math.max(
  entryChars(badId('x'.repeat(MISSION_LIST_ID_MAX_CHARS))),
  entryChars(deferred('x'.repeat(MISSION_LIST_ID_MAX_CHARS))),
  entryChars(tooLarge('x'.repeat(MISSION_LIST_ID_MAX_CHARS), 999_999_999)),
);

/**
 * The largest answer one owner can have in a batch: what is left of a reply
 * line after the entries of a full batch's other owners. Over it the owner is
 * REPLY_TOO_LARGE for every batch, wherever it sits, so it never shares a
 * line it would push past the cap, and never holds up the owners after it.
 */
export const MISSION_LIST_OWNER_MAX_CHARS = MISSION_LIST_REPLY_MAX_CHARS - MISSION_LIST_BATCH_MAX * MAX_STUB_CHARS;

/**
 * Answer a `task.mission.list` request that carries `verifiedWorkspaceIds`.
 * Owners are answered in order while their answers fit `budgetChars` (see
 * MISSION_LIST_BATCH_MAX_CHARS) and the whole line stays within
 * MISSION_LIST_REPLY_MAX_CHARS; the rest come back DEFERRED for the caller to
 * ask again. The first owner is always answered unless its answer is over
 * MISSION_LIST_OWNER_MAX_CHARS, in which case it is REPLY_TOO_LARGE.
 */
export function listMissionsBatch(
  params: Record<string, unknown>,
  listMissions: (verifiedWorkspaceId: string) => WorkTask[],
  budgetChars: number = MISSION_LIST_BATCH_MAX_CHARS,
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
  // Every entry is reserved at the size of an entry that answers nobody; an
  // answered owner then adds the difference.
  let lineLeft = MISSION_LIST_REPLY_MAX_CHARS - ids.length * MAX_STUB_CHARS;
  let used = 0;
  let answered = 0;
  for (const id of ids) {
    if (!nonEmpty(id) || id.length > MISSION_LIST_ID_MAX_CHARS) {
      // This entry only: the same refusal the single form gives a missing id.
      // An overlong id is not echoed, so no entry outgrows MAX_STUB_CHARS.
      results.push(badId(typeof id === 'string' && id.length <= MISSION_LIST_ID_MAX_CHARS ? id : ''));
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (answered > 0 && used >= budgetChars) {
      results.push(deferred(id));
      continue;
    }
    const tasks = listMissions(id);
    const entry: MissionListBatchEntry = { verifiedWorkspaceId: id, ok: true, tasks };
    const size = entryChars(entry);
    if (size > MISSION_LIST_OWNER_MAX_CHARS) {
      results.push(tooLarge(id, JSON.stringify({ ok: true, verifiedWorkspaceId: id, tasks }).length));
      continue;
    }
    if ((answered > 0 && used + size > budgetChars) || size - MAX_STUB_CHARS > lineLeft) {
      results.push(deferred(id));
      continue;
    }
    lineLeft -= size - MAX_STUB_CHARS;
    used += size;
    answered += 1;
    results.push(entry);
  }
  return { ok: true, results };
}
