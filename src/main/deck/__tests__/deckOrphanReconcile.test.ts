import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Reconcile logic is what these cases check, not crash durability. The deck
// stores write with `durable: true` (fsync per write, plus rotation), and the
// big case does ~20 such writes in setup and as many again in reconcile; on
// windows-latest each fsync+rename cost 100-800 ms in the CI timeline, so the
// case ran past 5 s. Same writes, same files and format, minus the fsync.
vi.mock('../../../daemon/util/atomicWrite', async (importOriginal) => {
  const { withoutFsync } = await import('../../../test-utils/nonDurableAtomicWrite');
  return withoutFsync(await importOriginal());
});
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  reconcileOrphanDeckState,
  collectDeckWorkspaceIds,
  collectDeckWorkspaceFiles,
  tryStartupDeckReconcile,
  __resetStartupDeckReconcileForTest,
  PARKED_WORK_TTL_HOURS,
} from '../deckOrphanReconcile';
import {
  beginOrContinueDeckWork,
  loadActiveDeckWork,
  loadArchivedDeckWorks,
  setDeckWorkBootId,
} from '../deckWorkStore';
import {
  setWorkspaceMode,
  getDeckAutonomyPath,
} from '../deckAutonomyStore';
import {
  raiseDecision,
  loadWorkspaceDecision,
} from '../deckDecisionStore';
import {
  getWorkspaceMirror,
  __resetWorkspaceMirrorForTest,
} from '../../workspace/WorkspaceMirror';


let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-orphan-test-'));
  setDeckWorkBootId('initial-test-boot');
  __resetStartupDeckReconcileForTest();
  __resetWorkspaceMirrorForTest();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckOrphanReconcile', () => {
  it('never treats Moa\'s "Remember this?" card key as a workspace', async () => {
    await raiseDecision('_moa-memory', { question: 'Remember this?', options: ['Save', 'Discard'] }, dir);
    expect(collectDeckWorkspaceIds(dir).has('_moa-memory')).toBe(false);
    await reconcileOrphanDeckState(['ws-live'], { dir });
    expect(loadWorkspaceDecision('_moa-memory', dir)).not.toBeNull();
  });

  it('reconciles three orphan ids and one live id across the deck files -> only live id remains, archive holds orphan work', async () => {
    // 1. deck-work.json: ws-orphan1, ws-orphan2, ws-live (old enough that
    // parked work has passed the 72h TTL)
    const oldTimestamp = Date.now() - 100 * 3600 * 1000;
    beginOrContinueDeckWork('ws-orphan1', 'work orphan 1', dir, oldTimestamp);
    beginOrContinueDeckWork('ws-orphan2', 'work orphan 2', dir, oldTimestamp);
    beginOrContinueDeckWork('ws-live', 'work live', dir, oldTimestamp);
    // Make the records parked by switching boot ID
    setDeckWorkBootId('fresh-boot-id');

    // 2. deck-autonomy.json: ws-orphan2, ws-orphan3, ws-live
    await setWorkspaceMode('ws-orphan2', 'danger', dir);
    await setWorkspaceMode('ws-orphan3', 'assist', dir);
    await setWorkspaceMode('ws-live', 'danger', dir);

    // 3. deck-decisions.json: ws-orphan1, ws-live
    await raiseDecision('ws-orphan1', { question: 'q1', options: ['yes', 'no'], context: 'c1' }, dir);
    await raiseDecision('ws-live', { question: 'q live', options: ['a', 'b'], context: 'c live' }, dir);

    // The retired brain stores are not read: an id only they hold is no orphan.
    fs.writeFileSync(path.join(dir, 'deck-loop-state.json'), JSON.stringify({ 'ws-loop-only': { objective: 'x' } }));

    const fileMap = collectDeckWorkspaceFiles(dir);
    expect(fileMap.get('ws-orphan1')).toEqual(['deck-decisions.json', 'deck-work.json']);
    expect(fileMap.get('ws-orphan2')).toEqual(['deck-autonomy.json', 'deck-work.json']);
    expect(fileMap.get('ws-orphan3')).toEqual(['deck-autonomy.json']);
    expect(fileMap.get('ws-live')).toEqual(['deck-autonomy.json', 'deck-decisions.json', 'deck-work.json']);
    expect(fileMap.has('ws-loop-only')).toBe(false);

    const report = await reconcileOrphanDeckState(['ws-live'], { dir });

    expect(report.orphans).toEqual(['ws-orphan1', 'ws-orphan2', 'ws-orphan3']);
    expect(report.archived.sort()).toEqual(['ws-orphan1', 'ws-orphan2']);
    expect(report.tornDown?.sort()).toEqual(['ws-orphan1', 'ws-orphan2', 'ws-orphan3']);
    expect(loadArchivedDeckWorks(dir).map((w) => w.workspaceId).sort()).toEqual(['ws-orphan1', 'ws-orphan2']);

    expect(loadActiveDeckWork('ws-orphan1', dir)).toBeNull();
    expect(loadActiveDeckWork('ws-orphan2', dir)).toBeNull();
    expect(loadActiveDeckWork('ws-live', dir)).not.toBeNull();
    const rawAutonomy = JSON.parse(fs.readFileSync(getDeckAutonomyPath(dir), 'utf8'));
    expect('ws-orphan2' in rawAutonomy).toBe(false);
    expect('ws-orphan3' in rawAutonomy).toBe(false);
    expect('ws-live' in rawAutonomy).toBe(true);
    expect(loadWorkspaceDecision('ws-orphan1', dir)).toBeNull();
    expect(loadWorkspaceDecision('ws-live', dir)).not.toBeNull();
    // The retired file is left on disk as it was.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'deck-loop-state.json'), 'utf8'))).toHaveProperty('ws-loop-only');
  });

  it('fails closed on null or empty array -> nothing changes', async () => {
    beginOrContinueDeckWork('ws-1', 'work 1', dir);
    await setWorkspaceMode('ws-1', 'danger', dir);

    const logs: string[] = [];
    const reportNull = await reconcileOrphanDeckState(null, { dir, log: (l) => logs.push(l) });
    expect(reportNull.orphans).toEqual([]);
    expect(reportNull.archived).toEqual([]);
    expect(reportNull.skipped).toBe('skipped: workspace list not loaded');
    expect(loadActiveDeckWork('ws-1', dir)).not.toBeNull();

    const reportEmpty = await reconcileOrphanDeckState([], { dir, log: (l) => logs.push(l) });
    expect(reportEmpty.orphans).toEqual([]);
    expect(reportEmpty.archived).toEqual([]);
    expect(reportEmpty.skipped).toBe('skipped: workspace list not loaded');
    expect(loadActiveDeckWork('ws-1', dir)).not.toBeNull();
  });

  it('dryRun reports the same orphans and changes nothing', async () => {
    beginOrContinueDeckWork('ws-orphan', 'work orphan', dir, Date.now() - 100 * 3600 * 1000);
    setDeckWorkBootId('fresh-boot-id');
    await setWorkspaceMode('ws-orphan', 'danger', dir);

    const report = await reconcileOrphanDeckState(['ws-live'], { dir, dryRun: true });
    expect(report.orphans).toEqual(['ws-orphan']);
    expect(report.archived).toEqual([]);

    // Nothing was deleted or archived
    expect(loadActiveDeckWork('ws-orphan', dir)).not.toBeNull();
    expect(loadArchivedDeckWorks(dir)).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(getDeckAutonomyPath(dir), 'utf8'))).toHaveProperty('ws-orphan');
  });

  it('preserves a parked record of a live workspace', async () => {
    // Record for ws-live written in an earlier boot (> 100 hours ago)
    const oldTimestamp = Date.now() - 100 * 3600 * 1000;
    beginOrContinueDeckWork('ws-live', 'live work parked from previous boot', dir, oldTimestamp);
    setDeckWorkBootId('fresh-boot-id');

    // Run reconcile where ws-live is in liveWorkspaceIds
    const report = await reconcileOrphanDeckState(['ws-live'], { dir });
    expect(report.orphans).toEqual([]);
    expect(report.archived).toEqual([]);

    // ws-live parked record must survive!
    const surviving = loadActiveDeckWork('ws-live', dir);
    expect(surviving).not.toBeNull();
    expect(surviving?.objective).toBe('live work parked from previous boot');
  });

  it('applies parked-work TTL: orphan parked work younger than TTL survives, older than TTL is purged', async () => {
    setDeckWorkBootId('boot-past');
    const now = Date.now();
    // ws-recent: parked 10 hours ago (< 72h TTL)
    const recentTs = now - 10 * 3600 * 1000;
    beginOrContinueDeckWork('ws-recent', 'recent work', dir, recentTs);

    // ws-old: parked 80 hours ago (> 72h TTL)
    const oldTs = now - 80 * 3600 * 1000;
    beginOrContinueDeckWork('ws-old', 'old work', dir, oldTs);

    setDeckWorkBootId('boot-current');

    // Run reconcile with no live workspaces matching either
    const report = await reconcileOrphanDeckState(['ws-other'], {
      dir,
      now,
      parkedWorkTtlHours: PARKED_WORK_TTL_HOURS,
    });

    expect(report.orphans).toEqual(['ws-old', 'ws-recent']);
    // Only ws-old was archived and torn down!
    expect(report.archived).toEqual(['ws-old']);

    // ws-recent survives
    expect(loadActiveDeckWork('ws-recent', dir)).not.toBeNull();
    // ws-old is gone from active, present in archive
    expect(loadActiveDeckWork('ws-old', dir)).toBeNull();
    const archived = loadArchivedDeckWorks(dir);
    expect(archived.map((w) => w.workspaceId)).toEqual(['ws-old']);
  });

  it('tryStartupDeckReconcile waits for fresh mirror snapshot and runs once', async () => {
    beginOrContinueDeckWork('ws-orphan', 'orphan work', dir, Date.now() - 100 * 3600 * 1000);
    setDeckWorkBootId('fresh-boot-id');

    const mirror = getWorkspaceMirror();

    // Mirror empty -> returns false, does nothing
    const done1 = await tryStartupDeckReconcile({ dir });
    expect(done1).toBe(false);
    expect(loadActiveDeckWork('ws-orphan', dir)).not.toBeNull();

    // Push snapshot into mirror with ws-live
    mirror.setSnapshot({
      ts: Date.now(),
      entries: [{ id: 'ws-live', name: 'Live Workspace' }],
      fleets: [],
      sessionRestored: true,
    });

    // Now mirror is ready -> runs reconcile, returns true
    const done2 = await tryStartupDeckReconcile({ dir });
    expect(done2).toBe(true);
    expect(loadActiveDeckWork('ws-orphan', dir)).toBeNull();

    // Subsequent calls return true immediately (runs at most once per process)
    const done3 = await tryStartupDeckReconcile({ dir });
    expect(done3).toBe(true);
  });

  it('does not tear down an orphan whose work cannot be archived', async () => {
    beginOrContinueDeckWork('ws-orphan', 'orphan work', dir, Date.now() - 100 * 3600 * 1000);
    setDeckWorkBootId('fresh-boot-id');
    await setWorkspaceMode('ws-orphan', 'danger', dir);
    // Unreadable archive + a FILE where the quarantine folder goes: archiving throws.
    fs.writeFileSync(path.join(dir, 'deck-work.archive.json'), 'CORRUPT{');
    fs.writeFileSync(path.join(dir, 'corrupted'), 'not a folder');

    const report = await reconcileOrphanDeckState(['ws-live'], { dir, log: () => undefined });

    expect(report.skippedIds).toEqual(['ws-orphan']);
    expect(report.tornDown).toEqual([]);
    expect(loadActiveDeckWork('ws-orphan', dir)).not.toBeNull();
    expect(collectDeckWorkspaceFiles(dir).get('ws-orphan')?.length).toBeGreaterThan(1);
  });

  // P1 data loss: a failed / null / empty session.load() still flips the pane
  // gate, and the mirror then holds ONE freshly generated default workspace.
  // Every real workspace on disk must keep its Deck state.
  it.each([
    ['session load failed or returned nothing (flag false)', false],
    ['an old renderer that does not send the flag', undefined],
  ])('tryStartupDeckReconcile deletes nothing when %s', async (_label, sessionRestored) => {
    const old = Date.now() - 100 * 3600 * 1000;
    beginOrContinueDeckWork('ws-real', 'real work', dir, old);
    setDeckWorkBootId('fresh-boot-id');
    await setWorkspaceMode('ws-real', 'danger', dir);
    await raiseDecision('ws-real', { question: 'q', options: ['a', 'b'], context: 'c' }, dir);
    const filesBefore = collectDeckWorkspaceFiles(dir);

    getWorkspaceMirror().setSnapshot({
      ts: Date.now(),
      entries: [{ id: 'ws-fresh-default', name: 'Workspace 1' }],
      fleets: [],
      ...(sessionRestored === undefined ? {} : { sessionRestored }),
    });

    const lines: string[] = [];
    const done = await tryStartupDeckReconcile({ dir, log: (l) => lines.push(l) });

    // Settled for this process (no retry loop), but nothing was touched.
    expect(done).toBe(true);
    expect(lines.join(' ')).toMatch(/did not restore a saved session/);
    expect(loadActiveDeckWork('ws-real', dir)).not.toBeNull();
    expect(loadArchivedDeckWorks(dir)).toEqual([]);
    expect(collectDeckWorkspaceIds(dir).has('ws-real')).toBe(true);
    expect(collectDeckWorkspaceFiles(dir)).toEqual(filesBefore);

    // A later push (same process) does not resurrect the pass.
    getWorkspaceMirror().setSnapshot({
      ts: Date.now(),
      entries: [{ id: 'ws-fresh-default', name: 'Workspace 1' }],
      fleets: [],
      sessionRestored: true,
    });
    await tryStartupDeckReconcile({ dir });
    expect(loadActiveDeckWork('ws-real', dir)).not.toBeNull();
  });
});
