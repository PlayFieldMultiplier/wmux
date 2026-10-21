// #2372 — the batched `task.mission.list` answers many owners in one call,
// with the single form's identity rule applied to every id, and never for a
// pane caller.

import { describe, it, expect, vi } from 'vitest';
import { listMissionsBatch, MISSION_LIST_OWNER_MAX_CHARS } from '../missionListBatch';
import {
  MISSION_LIST_BATCH_MAX,
  MISSION_LIST_BATCH_MAX_CHARS,
  MISSION_LIST_REPLY_MAX_CHARS,
} from '../../../shared/missionListBatch';
import { DAEMON_CONTROL_LINE_MAX_CHARS } from '../../../shared/daemonControlLine';
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
    // Its own code: NOT_AUTHORIZED is how a daemon without the batch refuses it.
    if (!reply.ok) expect(reply.error.code).toBe('BATCH_NOT_ALLOWED');
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
    /** What one answered owner adds to the reply (its entry and a comma). */
    const sizeOf = (tasks: WorkTask[]): number =>
      JSON.stringify({ verifiedWorkspaceId: tasks[0].owner.verifiedWorkspaceId, ok: true, tasks }).length + 1;

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
      // 128 owners x 20 tasks with long titles and paths: ~1.4 MB if sent whole.
      const heavy = (owner: string): WorkTask[] =>
        Array.from({ length: 20 }, (_, i) => ({
          ...task(`${owner}-t${i}`, owner),
          title: 'y'.repeat(200),
          branch: `wmux/task-${owner}-${i}`,
          worktreePath: ['C:', 'Users', 'someone', '.wmux', 'worktrees', 'r'.repeat(60), `task-${i}`].join('\\'),
          paneGroupId: `ws-task-${owner}-${i}`,
        })) as WorkTask[];
      expect(heavy('o')[3].worktreePath).toBe(`C:\\Users\\someone\\.wmux\\worktrees\\${'r'.repeat(60)}\\task-3`);
      const whole = JSON.stringify(Array.from({ length: MISSION_LIST_BATCH_MAX }, (_, i) => heavy(`o${i}`))).length;
      expect(whole).toBeGreaterThan(DAEMON_CONTROL_LINE_MAX_CHARS);
      const ids = Array.from({ length: MISSION_LIST_BATCH_MAX }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      let asked = ids;
      const answered: string[] = [];
      let calls = 0;
      while (asked.length > 0) {
        calls += 1;
        expect(calls).toBeLessThan(20);
        const reply = listMissionsBatch({ verifiedWorkspaceIds: asked }, heavy);
        // What the daemon writes on the control pipe for this reply.
        const line = JSON.stringify({ id: 'req-1', ok: true, result: reply });
        expect(line.length).toBeLessThan(MISSION_LIST_BATCH_MAX_CHARS + 64 * 1024);
        expect(line.length).toBeLessThanOrEqual(MISSION_LIST_REPLY_MAX_CHARS);
        if (!reply.ok) throw new Error('refused');
        answered.push(...reply.results.filter((r) => r.ok).map((r) => r.verifiedWorkspaceId));
        asked = reply.results.filter((r) => !r.ok).map((r) => r.verifiedWorkspaceId);
      }
      expect(calls).toBeGreaterThan(1);
      expect(answered).toEqual(ids);
    });

    describe('hard ceiling: one owner near the control-pipe line', () => {
      const ids = Array.from({ length: MISSION_LIST_BATCH_MAX }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      /** What the daemon writes on the control pipe for `reply`. */
      const lineOf = (reply: unknown): number => JSON.stringify({ id: 'req-12345', ok: true, result: reply }).length;
      /** 1000 tasks for `owner` whose batch entry is `target` characters or up to 1000 below. */
      const ownerOfSize = (owner: string, target: number): WorkTask[] => {
        const make = (len: number): WorkTask[] =>
          Array.from({ length: 1000 }, (_, i) => ({ ...task(`${owner}-t${i}`, owner), title: 'h'.repeat(len) }));
        const entry = (t: WorkTask[]): number => JSON.stringify({ verifiedWorkspaceId: owner, ok: true, tasks: t }).length + 1;
        return make(Math.floor((target - entry(make(0))) / 1000));
      };

      it('the ceiling sits under the line and leaves room for a full batch of the other owners', () => {
        expect(MISSION_LIST_REPLY_MAX_CHARS).toBeLessThan(DAEMON_CONTROL_LINE_MAX_CHARS);
        expect(MISSION_LIST_OWNER_MAX_CHARS).toBeLessThan(MISSION_LIST_REPLY_MAX_CHARS);
        expect(MISSION_LIST_OWNER_MAX_CHARS).toBeGreaterThan(MISSION_LIST_REPLY_MAX_CHARS - 128 * 1024);
      });

      it.each([
        ['first', 0],
        ['in the middle', 64],
      ] as const)('an owner over it %s is REPLY_TOO_LARGE and every other owner still refreshes', (_where, at) => {
        const heavyId = ids[at];
        const heavy = ownerOfSize(heavyId, DAEMON_CONTROL_LINE_MAX_CHARS - 20_000);
        const list = (o: string): WorkTask[] => (o === heavyId ? heavy : [task(`${o}-t`, o)]);
        let asked = ids;
        const answered: string[] = [];
        let tooLarge: { code: string; chars?: number } | null = null;
        for (let round = 0; asked.length > 0; round += 1) {
          // A reply that settles nobody would re-ask forever.
          expect(round).toBeLessThan(10);
          const reply = listMissionsBatch({ verifiedWorkspaceIds: asked }, list);
          expect(lineOf(reply)).toBeLessThanOrEqual(MISSION_LIST_REPLY_MAX_CHARS);
          if (!reply.ok) throw new Error('refused');
          for (const r of reply.results) {
            if (r.ok) answered.push(r.verifiedWorkspaceId);
            else if (r.error.code === 'REPLY_TOO_LARGE') tooLarge = r.error;
          }
          asked = reply.results.filter((r) => !r.ok && r.error.code === 'DEFERRED').map((r) => r.verifiedWorkspaceId);
        }
        expect(answered).toEqual(ids.filter((id) => id !== heavyId));
        // It carries the size of the owner's single-form reply.
        expect(tooLarge?.chars).toBe(JSON.stringify({ ok: true, verifiedWorkspaceId: heavyId, tasks: heavy }).length);
      });

      it('an owner just under it, first in a full batch, shares the line with every other entry and stays under the cap', () => {
        const heavyId = ids[0];
        const heavy = ownerOfSize(heavyId, MISSION_LIST_OWNER_MAX_CHARS);
        // The other owners' ids are as long as a batch echoes, so their
        // DEFERRED entries are as large as they get.
        const others = Array.from({ length: MISSION_LIST_BATCH_MAX - 1 }, (_, i) => `${String(i).padStart(4, '0')}${'w'.repeat(252)}`);
        const reply = listMissionsBatch(
          { verifiedWorkspaceIds: [heavyId, ...others] },
          (o) => (o === heavyId ? heavy : [task(`${o.slice(0, 4)}-t`, o)]),
        );
        expect(reply.ok).toBe(true);
        if (!reply.ok) return;
        expect(reply.results[0].ok).toBe(true);
        expect(reply.results.slice(1).every((r) => !r.ok && r.error.code === 'DEFERRED')).toBe(true);
        expect(lineOf(reply)).toBeLessThanOrEqual(MISSION_LIST_REPLY_MAX_CHARS);
      });

      it('ids that grow when escaped are measured as written: a full batch of them stays under the cap', () => {
        const heavyId = ids[0];
        const heavy = ownerOfSize(heavyId, MISSION_LIST_OWNER_MAX_CHARS);
        // 256 characters that JSON writes as 2-6 each: the unescaped length
        // passes a plain length check, the written one is up to 6x longer.
        const nasty = Array.from({ length: MISSION_LIST_BATCH_MAX - 1 }, (_, i) =>
          `${String(i).padStart(4, '0')}${'"\\\u0001'.repeat(84)}`);
        expect(nasty[0].length).toBe(256);
        const reply = listMissionsBatch({ verifiedWorkspaceIds: [heavyId, ...nasty] }, (o) => (o === heavyId ? heavy : []));
        expect(reply.ok).toBe(true);
        if (!reply.ok) return;
        expect(reply.results[0].ok).toBe(true);
        // Refused for themselves and not echoed, so their entries stay small.
        expect(reply.results.slice(1).every((r) => !r.ok && r.verifiedWorkspaceId === '')).toBe(true);
        expect(lineOf(reply)).toBeLessThanOrEqual(MISSION_LIST_REPLY_MAX_CHARS);
      });

      it('an id at the limit as written is answered; one escaped character past it is not', () => {
        const atLimit = `${'a'.repeat(254)}"`; // written as 256: the quote takes 2
        const past = `${'a'.repeat(255)}"`; // written as 257
        const reply = listMissionsBatch({ verifiedWorkspaceIds: [atLimit, past] }, listMissions);
        expect(reply.ok && reply.results.map((r) => [r.verifiedWorkspaceId, r.ok])).toEqual([
          [atLimit, true],
          ['', false],
        ]);
      });

      it('a REPLY_TOO_LARGE owner reports its single-form reply length', () => {
        const heavyId = ids[0];
        const heavy = ownerOfSize(heavyId, DAEMON_CONTROL_LINE_MAX_CHARS - 20_000);
        const reply = listMissionsBatch({ verifiedWorkspaceIds: [heavyId] }, () => heavy);
        expect(reply.ok && !reply.results[0].ok && reply.results[0].error.chars).toBe(
          JSON.stringify({ ok: true, verifiedWorkspaceId: heavyId, tasks: heavy }).length,
        );
      });

      it('an id longer than a batch echoes is refused for itself, not echoed', () => {
        const reply = listMissionsBatch({ verifiedWorkspaceIds: ['ws-a', 'q'.repeat(10_000)] }, listMissions);
        expect(reply.ok && reply.results.map((r) => [r.verifiedWorkspaceId, r.ok])).toEqual([
          ['ws-a', true],
          ['', false],
        ]);
      });
    });
  });
});
