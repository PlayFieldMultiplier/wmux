// #2372 — the batched `task.mission.list` answers many owners in one call,
// with the single form's identity rule applied to every id, and never for a
// pane caller.

import { describe, it, expect, vi } from 'vitest';
import { listMissionsBatch } from '../missionListBatch';
import { MISSION_LIST_BATCH_MAX, MISSION_LIST_BATCH_MAX_CHARS } from '../../../shared/missionListBatch';
import type { WorkTask } from '../../../shared/workTask';

function task(id: string, owner: string): WorkTask {
  return {
    id,
    title: id,
    status: 'open',
    missionChannelId: `ch-${id}`,
    createdAt: 1,
    createdBy: { workspaceId: owner, memberId: owner },
    owner: { verifiedWorkspaceId: owner },
  } as unknown as WorkTask;
}

const store: WorkTask[] = [task('t1', 'ws-a'), task('t2', 'ws-a'), task('t3', 'ws-b')];
const listMissions = (owner: string): WorkTask[] => store.filter((t) => t.owner.verifiedWorkspaceId === owner);

describe('listMissionsBatch', () => {
  it('returns each owner\'s tasks, the same lists the single form returns', () => {
    const reply = listMissionsBatch({ verifiedWorkspaceIds: ['ws-a', 'ws-b', 'ws-empty'] }, listMissions);
    expect(reply).toEqual({
      ok: true,
      results: [
        { verifiedWorkspaceId: 'ws-a', ok: true, tasks: listMissions('ws-a') },
        { verifiedWorkspaceId: 'ws-b', ok: true, tasks: listMissions('ws-b') },
        { verifiedWorkspaceId: 'ws-empty', ok: true, tasks: [] },
      ],
    });
  });

  it('refuses a pane caller (senderPtyId) whole: it may not read owners it does not hold', () => {
    const spy = vi.fn(listMissions);
    const reply = listMissionsBatch({ senderPtyId: 'pty-1', verifiedWorkspaceIds: ['ws-a', 'ws-b'] }, spy);
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe('NOT_AUTHORIZED');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a request that mixes the single and the batched form', () => {
    const reply = listMissionsBatch({ verifiedWorkspaceId: 'ws-a', verifiedWorkspaceIds: ['ws-b'] }, listMissions);
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe('INVALID_ARGUMENT');
  });

  it('caps the owners per call, and refuses a non-array', () => {
    const atCap = Array.from({ length: MISSION_LIST_BATCH_MAX }, (_, i) => `ws-${i}`);
    expect(listMissionsBatch({ verifiedWorkspaceIds: atCap }, listMissions).ok).toBe(true);
    const over = listMissionsBatch({ verifiedWorkspaceIds: [...atCap, 'ws-one-more'] }, listMissions);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('INVALID_ARGUMENT');
    const notArray = listMissionsBatch({ verifiedWorkspaceIds: 'ws-a' }, listMissions);
    expect(notArray.ok).toBe(false);
  });

  it('a bad id fails closed for that id only, and a repeated id is answered once', () => {
    const reply = listMissionsBatch({ verifiedWorkspaceIds: ['ws-a', '', '  ', 7, 'ws-a', 'ws-b'] }, listMissions);
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    const ok = reply.results.filter((r) => r.ok);
    const bad = reply.results.filter((r) => !r.ok);
    expect(ok.map((r) => r.verifiedWorkspaceId)).toEqual(['ws-a', 'ws-b']);
    expect(bad).toHaveLength(3);
    for (const r of bad) if (!r.ok) expect(r.error.code).toBe('NOT_AUTHORIZED');
  });

  describe('reply size budget', () => {
    /** `n` tasks for `owner`, each about `pad` characters of title. */
    const bulky = (owner: string, n: number, pad: number): WorkTask[] =>
      Array.from({ length: n }, (_, i) => ({ ...task(`${owner}-t${i}`, owner), title: 'x'.repeat(pad) }));
    const sizeOf = (tasks: WorkTask[]): number => JSON.stringify(tasks).length;

    it('answers owners in order while they fit and defers the rest', () => {
      const lists: Record<string, WorkTask[]> = { a: bulky('a', 3, 100), b: bulky('b', 3, 100), c: bulky('c', 3, 100) };
      const budget = sizeOf(lists.a) + sizeOf(lists.b);
      const reply = listMissionsBatch({ verifiedWorkspaceIds: ['a', 'b', 'c'] }, (o) => lists[o], budget);
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.results.map((r) => [r.verifiedWorkspaceId, r.ok ? 'ok' : r.error.code])).toEqual([
        ['a', 'ok'],
        ['b', 'ok'],
        ['c', 'DEFERRED'],
      ]);
    });

    it('an owner over the budget on its own is answered alone when it comes first, deferred otherwise', () => {
      const lists: Record<string, WorkTask[]> = { small: bulky('small', 1, 10), huge: bulky('huge', 50, 200) };
      const budget = sizeOf(lists.huge) / 10;
      const first = listMissionsBatch({ verifiedWorkspaceIds: ['huge', 'small'] }, (o) => lists[o], budget);
      expect(first.ok && first.results.map((r) => r.ok)).toEqual([true, false]);
      if (first.ok && first.results[0].ok) expect(first.results[0].tasks).toHaveLength(50);
      const second = listMissionsBatch({ verifiedWorkspaceIds: ['small', 'huge'] }, (o) => lists[o], budget);
      expect(second.ok && second.results.map((r) => r.ok)).toEqual([true, false]);
    });

    it('with the default budget, a full batch of heavy owners stays well under the 1 MB control-pipe line', () => {
      // 128 owners x 20 tasks with long titles and paths: ~3 MB if sent whole.
      const heavy = (owner: string): WorkTask[] =>
        Array.from({ length: 20 }, (_, i) => ({
          ...task(`${owner}-t${i}`, owner),
          title: 'y'.repeat(200),
          branch: `wmux/task-${owner}-${i}`,
          worktreePath: `C:\Users\someone\.wmux\worktrees\${'r'.repeat(60)}\task-${i}`,
          paneGroupId: `ws-task-${owner}-${i}`,
        })) as WorkTask[];
      const ids = Array.from({ length: MISSION_LIST_BATCH_MAX }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      let asked = ids;
      const answered: string[] = [];
      let calls = 0;
      while (asked.length > 0) {
        calls += 1;
        const reply = listMissionsBatch({ verifiedWorkspaceIds: asked }, heavy);
        // What the daemon writes on the control pipe for this reply.
        const line = JSON.stringify({ id: 'req-1', ok: true, result: reply });
        expect(line.length).toBeLessThan(MISSION_LIST_BATCH_MAX_CHARS + 64 * 1024);
        expect(line.length).toBeLessThan(1024 * 1024);
        if (!reply.ok) throw new Error('refused');
        answered.push(...reply.results.filter((r) => r.ok).map((r) => r.verifiedWorkspaceId));
        asked = reply.results.filter((r) => !r.ok).map((r) => r.verifiedWorkspaceId);
      }
      expect(calls).toBeGreaterThan(1);
      expect(answered).toEqual(ids);
    });
  });
});
