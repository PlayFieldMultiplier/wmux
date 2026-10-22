// The two ways snapshot work waits its turn: the global concurrency-1 queue
// (enqueueSnapshotJob) and the small-ring gate (runSmallSnapshotJob) a new
// pane's attach flush takes instead of the queue (#2585).
import { describe, it, expect } from 'vitest';
import { enqueueSnapshotJob, runSmallSnapshotJob, SMALL_SNAPSHOT_CONCURRENCY } from '../HeadlessSnapshot';
import { waitFor } from '../../test-utils/waitFor';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('runSmallSnapshotJob', () => {
  it(`runs at most ${SMALL_SNAPSHOT_CONCURRENCY} at once, never behind the queue, and finishes every job`, async () => {
    // Another pane's large snapshot holds the queue for the whole test.
    const queueHolder = deferred();
    const queued = enqueueSnapshotJob(() => queueHolder.promise);

    const total = SMALL_SNAPSHOT_CONCURRENCY * 2 + 1;
    const releases = Array.from({ length: total }, () => deferred());
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const jobs = releases.map((release, i) => runSmallSnapshotJob(async () => {
      running++;
      peak = Math.max(peak, running);
      started.push(i);
      await release.promise;
      running--;
      return i;
    }));

    await waitFor(() => started.length >= SMALL_SNAPSHOT_CONCURRENCY);
    // Give any job that wrongly skipped the gate time to start too.
    await new Promise<void>((r) => setImmediate(r));
    expect(started).toEqual(Array.from({ length: SMALL_SNAPSHOT_CONCURRENCY }, (_, i) => i));

    // Finish them one by one: each frees exactly one place, oldest waiter first.
    for (let i = 0; i < total; i++) {
      releases[i].resolve();
      await waitFor(() => started.length === Math.min(total, SMALL_SNAPSHOT_CONCURRENCY + i + 1));
      expect(running).toBeLessThanOrEqual(SMALL_SNAPSHOT_CONCURRENCY);
    }
    expect(await Promise.all(jobs)).toEqual(releases.map((_, i) => i));
    expect(peak).toBe(SMALL_SNAPSHOT_CONCURRENCY);
    expect(started).toEqual(releases.map((_, i) => i));

    queueHolder.resolve();
    await queued;
  });

  it('a job that throws frees its place', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: SMALL_SNAPSHOT_CONCURRENCY + 2 }, (_, i) => runSmallSnapshotJob(async () => {
        if (i % 2 === 0) throw new Error(`job ${i}`);
        return i;
      })),
    );
    expect(results.map((r) => r.status)).toEqual(
      Array.from({ length: SMALL_SNAPSHOT_CONCURRENCY + 2 }, (_, i) => (i % 2 === 0 ? 'rejected' : 'fulfilled')),
    );
    // Every place came back: a full round still starts at once.
    let started = 0;
    const holds = Array.from({ length: SMALL_SNAPSHOT_CONCURRENCY }, () => deferred());
    const round = holds.map((h) => runSmallSnapshotJob(async () => { started++; await h.promise; }));
    await waitFor(() => started === SMALL_SNAPSHOT_CONCURRENCY);
    holds.forEach((h) => h.resolve());
    await Promise.all(round);
  });
});

describe('enqueueSnapshotJob coalesceKey', () => {
  it('a read of the same pane still waiting is joined, run once, and answers both callers', async () => {
    const holder = deferred();
    const held = enqueueSnapshotJob(() => holder.promise);
    const runs: string[] = [];
    const first = enqueueSnapshotJob(async () => { runs.push('first'); return 'screen A'; }, 'screen:A');
    const second = enqueueSnapshotJob(async () => { runs.push('second'); return 'never'; }, 'screen:A');
    // Another pane, another depth of the same pane, and an unkeyed job are not joined.
    const otherPane = enqueueSnapshotJob(async () => { runs.push('other pane'); return 'screen B'; }, 'screen:B');
    const otherDepth = enqueueSnapshotJob(async () => { runs.push('other depth'); return 'text A'; }, 'text:A:5000');
    const unkeyed = enqueueSnapshotJob(async () => { runs.push('reflush A'); return 'reflushed'; });

    holder.resolve();
    await held;
    expect(await Promise.all([first, second, otherPane, otherDepth, unkeyed]))
      .toEqual(['screen A', 'screen A', 'screen B', 'text A', 'reflushed']);
    expect(runs).toEqual(['first', 'other pane', 'other depth', 'reflush A']);
  });

  it('a read made after the queued one started runs again (it may have read already)', async () => {
    const started = deferred();
    const finish = deferred();
    const runs: number[] = [];
    const first = enqueueSnapshotJob(async () => { runs.push(1); started.resolve(); await finish.promise; return 1; }, 'screen:C');
    await started.promise;
    const second = enqueueSnapshotJob(async () => { runs.push(2); return 2; }, 'screen:C');
    finish.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(runs).toEqual([1, 2]);
  });

  it('a failed shared read fails every caller that joined it, and the queue goes on', async () => {
    const holder = deferred();
    const held = enqueueSnapshotJob(() => holder.promise);
    const first = enqueueSnapshotJob(async () => { throw new Error('parse failed'); }, 'screen:D');
    const second = enqueueSnapshotJob(async () => 'unused', 'screen:D');
    holder.resolve();
    await held;
    await expect(first).rejects.toThrow('parse failed');
    await expect(second).rejects.toThrow('parse failed');
    expect(await enqueueSnapshotJob(async () => 'next', 'screen:D')).toBe('next');
  });
});
