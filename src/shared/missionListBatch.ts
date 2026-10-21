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
// Who may batch: only main's own reads and the renderer operator. The daemon
// refuses a batch that carries a `senderPtyId`, and main's pipe router refuses
// one from any caller that is not the operator (a2a.channel.rpc.ts), so a pane
// agent can never use it to read another workspace's missions.
//
// Version skew: a daemon that predates the batch answers it the way it answers
// any request without `verifiedWorkspaceId` (NOT_AUTHORIZED, no `results`).
// listMissionsByOwner reads that refusal as that daemon and falls back to one
// single-form call per owner, so a stale daemon that outlived an app update
// keeps working until it is replaced.

/**
 * Most owners one batched call may name. Above it the daemon refuses the call
 * (callers chunk). It bounds the work one request can ask for; it does not
 * bound the reply's bytes. The daemon <-> main control pipe drops a line over
 * 1 MB (DaemonClient MAX_LINE_BUFFER), and the reply carries every task of
 * every owner named, closed tasks included until their 7-day GC. That limit
 * already applied to one owner's single-form reply; a batch makes it the sum
 * of the chunk's owners. 128 keeps a ~100-workspace window to one call.
 */
export const MISSION_LIST_BATCH_MAX = 128;

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

/**
 * Read the missions of every owner in `owners`: one batched call per
 * MISSION_LIST_BATCH_MAX owners. Returns owner -> that owner's reply in the
 * single form's shape (`{ ok: true, tasks }`, or `{ ok: false, error }`).
 * An owner whose read failed in transport is absent. Never throws.
 */
export async function listMissionsByOwner(
  call: MissionListCall,
  owners: readonly string[],
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const unique = [...new Set(owners.filter((o) => typeof o === 'string' && o.length > 0))];
  let batchUnsupported = false;
  for (let i = 0; i < unique.length; i += MISSION_LIST_BATCH_MAX) {
    const chunk = unique.slice(i, i + MISSION_LIST_BATCH_MAX);
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
        for (const entry of results) {
          if (!entry || typeof entry !== 'object') continue;
          const owner = (entry as { verifiedWorkspaceId?: unknown }).verifiedWorkspaceId;
          if (typeof owner === 'string' && asked.has(owner)) out.set(owner, entry);
        }
        continue;
      }
      // A daemon that predates the batch reads only `verifiedWorkspaceId`, so
      // it refuses the batch as NOT_AUTHORIZED. Any other refusal (the mission
      // log unavailable, say) would come back the same from each owner's call.
      if (!isOldDaemonRefusal(reply)) continue;
      batchUnsupported = true;
    }
    for (const owner of chunk) {
      try {
        out.set(owner, await call({ verifiedWorkspaceId: owner }));
      } catch {
        /* this owner only; the next pass retries */
      }
    }
  }
  return out;
}
