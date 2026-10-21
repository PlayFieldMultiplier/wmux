// ─── Batched `task.mission.list` (#2372 direction 1) ─────────────────────────
//
// The renderer's missions poll and main's task-ledger reconcile each read every
// workspace's missions. One `task.mission.list` per workspace made each of
// those scans ~100 RPCs on a large window, and when the two landed in the same
// second they passed the daemon's 200/s global budget, so unrelated background
// reads (`pty:list`) were refused. The batched form answers many owners in one
// call: `task.mission.list` with `verifiedWorkspaceIds: string[]` instead of
// the single `verifiedWorkspaceId`.
//
// Request:  { verifiedWorkspaceIds: string[] }   (at most MISSION_LIST_BATCH_MAX)
// Reply:    { ok: true, results: Array<
//             | { verifiedWorkspaceId, ok: true, tasks }       (the single form's reply)
//             | { verifiedWorkspaceId, ok: false, error }> }   (that owner only)
//
// Reply size: the daemon -> main control pipe drops a line longer than
// DAEMON_CONTROL_LINE_MAX_CHARS and the request then times out with no error,
// and a reply carries every task of every owner it answers (closed tasks
// until their 7-day GC; detached ones stay). So the daemon builds the reply
// to two limits:
//   - a soft budget (MISSION_LIST_BATCH_MAX_CHARS) for the answered owners.
//     Owners past it come back DEFERRED and listMissionsByOwner asks for them
//     again in a follow-up batch. The first owner a reply reaches is always
//     settled (answered, or REPLY_TOO_LARGE below), so every call makes
//     progress.
//   - a hard ceiling for the whole line (MISSION_LIST_REPLY_MAX_CHARS),
//     counted with the entries of the owners it does not answer. An owner
//     whose answer could not share a line with a full batch of them
//     (MISSION_LIST_OWNER_MAX_CHARS in daemon/worktask/missionListBatch.ts)
//     comes back REPLY_TOO_LARGE, with the size of its single-form reply, and
//     never holds up the owners after it. listMissionsByOwner reads that owner
//     with the single form when that reply fits a line, and otherwise leaves
//     its cached missions as they are.
//
// Who may batch: only main's own reads and the renderer operator. Main's pipe
// router refuses a batch from any caller that is not the operator
// (a2a.channel.rpc.ts), so a pane agent, commander or plugin reaching main
// cannot use it to read another workspace's missions. The daemon also refuses
// a batch that carries a `senderPtyId`; that is a consistency guard, not a
// boundary: a client on the daemon pipe can name any owner with the single
// form anyway (the #113 same-user ceiling).
//
// Version skew: a daemon that predates the batch answers it the way it answers
// any request without `verifiedWorkspaceId` (NOT_AUTHORIZED, no `results`).
// listMissionsByOwner reads that refusal as that daemon and falls back to one
// single-form call per owner, so a stale daemon that outlived an app update
// keeps working until it is replaced.

import { DAEMON_CONTROL_LINE_MAX_CHARS } from './daemonControlLine';

/**
 * Most owners one batched call may name. Above it the daemon refuses the call
 * (callers chunk). It bounds the work one request can ask for; the reply's
 * size is bounded by the limits below. 128 keeps a ~100-workspace
 * window to one call.
 */
export const MISSION_LIST_BATCH_MAX = 128;

/**
 * Soft budget, in JSON characters, for the answered owners of one batched
 * reply. 256K is a quarter of a control-pipe line. A WorkTask serializes to
 * roughly 0.4-1K, so one reply still holds several hundred tasks; a window
 * with more than that takes a follow-up batch or two.
 */
export const MISSION_LIST_BATCH_MAX_CHARS = 256 * 1024;

/**
 * Hard ceiling for a whole reply line, in characters. It leaves the control
 * pipe's 1 MB 64K of slack, because DaemonClient checks its buffer after
 * appending a whole read and the read that ends this line can carry the start
 * of the next one, and 1K for the `{ id, ok, result }` envelope.
 */
export const MISSION_LIST_REPLY_MAX_CHARS = DAEMON_CONTROL_LINE_MAX_CHARS - 64 * 1024 - 1024;

/** Longest owner id a batch answers, counted as it is written in the reply
 *  (JSON-escaped, without its quotes); a longer one is refused for itself. */
export const MISSION_LIST_ID_MAX_CHARS = 256;

/** Per-owner code for an owner left out of a reply by the soft budget: ask again. */
export const MISSION_LIST_DEFERRED = 'DEFERRED';

/** Per-owner code for an owner whose answer cannot share a line with the
 *  rest of a batch (`error.chars`: its single-form reply's length). */
export const MISSION_LIST_REPLY_TOO_LARGE = 'REPLY_TOO_LARGE';

/** Whole-call code for a batch from a caller that may not batch (a pane
 *  caller at the daemon, anyone but the operator at main's router). Distinct
 *  from NOT_AUTHORIZED, which is how a daemon without the batch refuses it,
 *  so it is never read as that daemon. */
export const MISSION_LIST_BATCH_NOT_ALLOWED = 'BATCH_NOT_ALLOWED';

/** One `task.mission.list` call: the daemon's reply, transport envelope removed. */
export type MissionListCall = (params: Record<string, unknown>) => Promise<unknown>;

function batchResults(reply: unknown): unknown[] | null {
  if (!reply || typeof reply !== 'object') return null;
  const r = reply as { ok?: unknown; results?: unknown };
  return r.ok === true && Array.isArray(r.results) ? r.results : null;
}

function isOldDaemonRefusal(reply: unknown): boolean {
  if (!reply || typeof reply !== 'object') return false;
  const r = reply as { ok?: unknown; error?: { code?: unknown } | null };
  return r.ok === false && r.error?.code === 'NOT_AUTHORIZED';
}

function errorCode(entry: object): unknown {
  if ((entry as { ok?: unknown }).ok !== false) return undefined;
  return (entry as { error?: { code?: unknown } | null }).error?.code;
}

/** The single-form reply length a REPLY_TOO_LARGE entry reports, or null. */
function singleFormChars(entry: object): number | null {
  const chars = (entry as { error?: { chars?: unknown } | null }).error?.chars;
  return typeof chars === 'number' && Number.isFinite(chars) ? chars : null;
}

/**
 * Read the missions of every owner in `owners`: one batched call per
 * MISSION_LIST_BATCH_MAX owners, plus a follow-up batch for the owners a
 * reply deferred over its size budget. Returns owner -> that owner's reply in
 * the single form's shape (`{ ok: true, tasks }`, or `{ ok: false, error }`).
 * An owner whose read failed in transport, or whose missions are too large
 * for any reply line, is absent. Never throws.
 */
export async function listMissionsByOwner(
  call: MissionListCall,
  owners: readonly string[],
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  let pending = [...new Set(owners.filter((o) => typeof o === 'string' && o.length > 0))];
  let batchUnsupported = false;
  const readSingle = async (owner: string): Promise<void> => {
    try {
      out.set(owner, await call({ verifiedWorkspaceId: owner }));
    } catch {
      /* this owner only; the next pass retries */
    }
  };
  while (pending.length > 0) {
    const chunk = pending.slice(0, MISSION_LIST_BATCH_MAX);
    const rest = pending.slice(MISSION_LIST_BATCH_MAX);
    pending = rest;
    if (!batchUnsupported) {
      let reply: unknown;
      try {
        reply = await call({ verifiedWorkspaceIds: chunk });
      } catch {
        // Transport failure (daemon gone, pipe reset): the next pass retries.
        // Falling back to per-owner calls here would only fail N more times.
        continue;
      }
      const results = batchResults(reply);
      if (results) {
        const asked = new Set(chunk);
        const deferred = new Set<string>();
        const alone: string[] = [];
        for (const entry of results) {
          if (!entry || typeof entry !== 'object') continue;
          const owner = (entry as { verifiedWorkspaceId?: unknown }).verifiedWorkspaceId;
          if (typeof owner !== 'string' || !asked.has(owner)) continue;
          const code = errorCode(entry);
          if (code === MISSION_LIST_DEFERRED) {
            deferred.add(owner);
          } else if (code === MISSION_LIST_REPLY_TOO_LARGE) {
            // The single form answers it on a line of its own when that fits;
            // past the line it would only time out, so its cache stays.
            const chars = singleFormChars(entry);
            if (chars !== null && chars <= MISSION_LIST_REPLY_MAX_CHARS) alone.push(owner);
          } else {
            out.set(owner, entry);
          }
        }
        for (const owner of alone) await readSingle(owner);
        const again = [...deferred].filter((o) => !out.has(o));
        // The daemon settles at least one owner per reply; a reply that
        // settled none would loop forever, so its owners wait for the next pass.
        if (again.length < chunk.length) pending = [...again, ...rest];
        continue;
      }
      // A daemon that predates the batch reads only `verifiedWorkspaceId`, so
      // it refuses the batch as NOT_AUTHORIZED. Any other refusal (the mission
      // log unavailable, say) would come back the same from each owner's call.
      if (!isOldDaemonRefusal(reply)) continue;
      batchUnsupported = true;
    }
    for (const owner of chunk) await readSingle(owner);
  }
  return out;
}
