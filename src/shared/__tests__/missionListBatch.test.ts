// #2372 — listMissionsByOwner reads every owner's missions in one call per
// MISSION_LIST_BATCH_MAX owners, and falls back to one call per owner on a
// daemon that predates the batch.

import { describe, it, expect, vi } from 'vitest';
import { listMissionsByOwner, MISSION_LIST_BATCH_MAX, type MissionListCall } from '../missionListBatch';
import { listMissionsBatch } from '../../daemon/worktask/missionListBatch';
import type { WorkTask } from '../workTask';

const tasksOf = (owner: string): WorkTask[] =>
  [{ id: `t-${owner}`, status: 'open', owner: { verifiedWorkspaceId: owner } }] as unknown as WorkTask[];

/** The single form exactly as daemon/index.ts answers it. */
function singleForm(p: Record<string, unknown>): unknown {
  const id = typeof p.verifiedWorkspaceId === 'string' ? p.verifiedWorkspaceId : '';
  if (!id) {
    return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'task.mission.list: a server-resolved verifiedWorkspaceId is required' } };
  }
  return { ok: true, verifiedWorkspaceId: id, tasks: tasksOf(id) };
}

/** A daemon with the batch (this change). */
const newDaemon = (): ReturnType<typeof vi.fn<MissionListCall>> =>
  vi.fn<MissionListCall>(async (p) =>
    p.verifiedWorkspaceIds !== undefined ? listMissionsBatch(p, tasksOf) : singleForm(p),
  );

/** A daemon from before the batch: it reads only verifiedWorkspaceId. */
const oldDaemon = (): ReturnType<typeof vi.fn<MissionListCall>> => vi.fn<MissionListCall>(async (p) => singleForm(p));

const owners = (n: number): string[] => Array.from({ length: n }, (_, i) => `ws-${i}`);

describe('listMissionsByOwner', () => {
  it('reads 107 owners in one call, each owner\'s reply in the single form\'s shape', async () => {
    const call = newDaemon();
    const ids = owners(107);
    const out = await listMissionsByOwner(call, ids);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith({ verifiedWorkspaceIds: ids });
    expect([...out.keys()]).toEqual(ids);
    for (const id of ids) expect(out.get(id)).toMatchObject({ ok: true, tasks: tasksOf(id) });
  });

  it('chunks above the cap, and dedupes and drops empty ids before sending', async () => {
    const call = newDaemon();
    const ids = owners(MISSION_LIST_BATCH_MAX + 5);
    const out = await listMissionsByOwner(call, [...ids, ids[0], '']);
    expect(call).toHaveBeenCalledTimes(2);
    expect((call.mock.calls[0][0].verifiedWorkspaceIds as string[]).length).toBe(MISSION_LIST_BATCH_MAX);
    expect((call.mock.calls[1][0].verifiedWorkspaceIds as string[]).length).toBe(5);
    expect(out.size).toBe(ids.length);
  });

  it('falls back to one call per owner on a daemon without the batch, with the same answers', async () => {
    const ids = owners(4);
    const oldCall = oldDaemon();
    const viaOld = await listMissionsByOwner(oldCall, ids);
    // One batched attempt (refused: no verifiedWorkspaceId), then per owner.
    expect(oldCall).toHaveBeenCalledTimes(1 + ids.length);
    expect(oldCall.mock.calls[0][0]).toEqual({ verifiedWorkspaceIds: ids });
    expect(oldCall.mock.calls.slice(1).map((c) => c[0])).toEqual(ids.map((id) => ({ verifiedWorkspaceId: id })));

    const viaNew = await listMissionsByOwner(newDaemon(), ids);
    for (const id of ids) {
      expect((viaOld.get(id) as { tasks: unknown }).tasks).toEqual((viaNew.get(id) as { tasks: unknown }).tasks);
    }
  });

  it('on an old daemon, later chunks go straight to per-owner calls', async () => {
    const call = oldDaemon();
    const ids = owners(MISSION_LIST_BATCH_MAX + 2);
    const out = await listMissionsByOwner(call, ids);
    expect(call).toHaveBeenCalledTimes(1 + ids.length);
    expect(out.size).toBe(ids.length);
  });

  it('a transport failure skips that chunk without N more failing calls; never throws', async () => {
    const call = vi.fn<MissionListCall>(async () => {
      throw new Error('DaemonClient not connected');
    });
    const out = await listMissionsByOwner(call, owners(10));
    expect(call).toHaveBeenCalledTimes(1);
    expect(out.size).toBe(0);
  });

  it('any other whole-call refusal skips the chunk instead of falling back to N calls', async () => {
    // A current daemon whose mission log is unavailable refuses before the
    // batch is read; each owner's call would be refused the same way.
    const call = vi.fn<MissionListCall>(async () => ({
      ok: false,
      error: { code: 'NOT_AVAILABLE', message: 'task.mission.list: mission log unavailable' },
    }));
    const out = await listMissionsByOwner(call, owners(10));
    expect(call).toHaveBeenCalledTimes(1);
    expect(out.size).toBe(0);
  });

  it('keeps only the owners it asked for', async () => {
    const call = vi.fn<MissionListCall>(async () => ({
      ok: true,
      results: [
        { verifiedWorkspaceId: 'ws-0', ok: true, tasks: [] },
        { verifiedWorkspaceId: 'ws-stranger', ok: true, tasks: tasksOf('ws-stranger') },
      ],
    }));
    const out = await listMissionsByOwner(call, ['ws-0']);
    expect([...out.keys()]).toEqual(['ws-0']);
  });

  describe('owners deferred over the reply size budget', () => {
    /** Owner `ws-i` holds `i % 4` tasks of ~300 characters; `ws-huge` holds 40. */
    const listOf = (owner: string): WorkTask[] => {
      const n = owner === 'ws-huge' ? 40 : Number(owner.slice(3)) % 4;
      return Array.from({ length: n }, (_, k) => ({
        id: `t-${owner}-${k}`,
        title: 'z'.repeat(300),
        status: 'open',
        owner: { verifiedWorkspaceId: owner },
      })) as unknown as WorkTask[];
    };
    const budgeted = (budget: number) =>
      vi.fn<MissionListCall>(async (p) =>
        p.verifiedWorkspaceIds !== undefined ? listMissionsBatch(p, listOf, budget) : singleForm(p),
      );

    it('re-asks the deferred owners until every owner is answered exactly once', async () => {
      const answered: string[] = [];
      const call = vi.fn<MissionListCall>(async (p) => {
        const reply = listMissionsBatch(p, listOf, 4_000);
        if (reply.ok) answered.push(...reply.results.filter((e) => e.ok).map((e) => e.verifiedWorkspaceId));
        return reply;
      });
      const ids = owners(60);
      const out = await listMissionsByOwner(call, ids);
      expect(call.mock.calls.length).toBeGreaterThan(1);
      expect(call.mock.calls.every((c) => Array.isArray(c[0].verifiedWorkspaceIds))).toBe(true);
      // Across the follow-ups, each owner answered once and none twice.
      expect(answered).toHaveLength(ids.length);
      expect([...answered].sort()).toEqual([...ids].sort());
      expect([...out.keys()].sort()).toEqual([...ids].sort());
      for (const id of ids) expect((out.get(id) as { tasks: unknown }).tasks).toEqual(listOf(id));
    });

    it('an owner whose list alone is over the budget is still read, in a reply of its own', async () => {
      const call = budgeted(2_000);
      const out = await listMissionsByOwner(call, ['ws-1', 'ws-huge', 'ws-2']);
      expect((out.get('ws-huge') as { tasks: unknown[] }).tasks).toHaveLength(40);
      expect(out.size).toBe(3);
      // ws-huge was deferred behind ws-1 (ws-2 still fit), then answered alone
      // in a follow-up.
      expect(call.mock.calls.map((c) => c[0].verifiedWorkspaceIds)).toEqual([
        ['ws-1', 'ws-huge', 'ws-2'],
        ['ws-huge'],
      ]);
    });

    it('a reply that answers nobody does not loop: those owners wait for the next pass', async () => {
      const call = vi.fn<MissionListCall>(async (p) => ({
        ok: true,
        results: (p.verifiedWorkspaceIds as string[]).map((id) => ({
          verifiedWorkspaceId: id,
          ok: false,
          error: { code: 'DEFERRED', message: 'x' },
        })),
      }));
      const out = await listMissionsByOwner(call, owners(3));
      expect(call).toHaveBeenCalledTimes(1);
      expect(out.size).toBe(0);
    });
  });
});
