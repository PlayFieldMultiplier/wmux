// #2372 — the batched `task.mission.list` answers many owners in one call,
// with the single form's identity rule applied to every id, and never for a
// pane caller.

import { describe, it, expect, vi } from 'vitest';
import { listMissionsBatch } from '../missionListBatch';
import { MISSION_LIST_BATCH_MAX } from '../../../shared/missionListBatch';
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
});
