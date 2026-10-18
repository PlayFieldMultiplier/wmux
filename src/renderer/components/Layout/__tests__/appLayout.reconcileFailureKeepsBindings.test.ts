/**
 * #2398 — a failed startup reconcile keeps the saved bindings.
 *
 * Structural lock (house pattern: appLayout.sessionSaveInvariants.test.ts —
 * AppLayout has no jsdom fixture). The decision itself is unit-tested in
 * hooks/__tests__/startupReconcileFallback.test.ts; these pin the wiring:
 *   1. the catch applies that fallback and does not wipe on its own;
 *   2. the gate opens first, then a late reconcile runs after the aborted
 *      pass has let go of the in-flight slot;
 *   3. a reconcile that lists a session live confirms its binding;
 *   4. the restore-off path still clears (fresh start, by the user's choice).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', 'AppLayout.tsx'), 'utf-8');

function startupRegion(): string {
  const start = source.indexOf('// 앱 시작 시 세션 복원');
  expect(start, 'startup restore effect not found').toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('First-run wizard', start));
}

describe('AppLayout startup reconcile failure (#2398)', () => {
  it('the catch applies the fallback (keep + unconfirmed with a daemon) instead of clearing', () => {
    const region = startupRegion();
    const catchAt = region.indexOf('} catch (err) {');
    const finallyAt = region.indexOf('} finally {', catchAt);
    const catchBody = region.slice(catchAt, finallyAt);
    expect(catchBody).toMatch(/applyStartupReconcileFallback\(\{\s*daemonMode: daemonModeAtStartup,/);
    expect(catchBody).toMatch(/setPtysUnconfirmed\(ids, true\)/);
    expect(catchBody).not.toMatch(/^\s*clearAllPtyState\(\);/m);
    // Still generation-guarded.
    expect(catchBody).toMatch(/if \(gen === startupGenRef\.current\) \{\s*rerunReconcile = applyStartupReconcileFallback/);
  });

  it('daemon mode is the one this startup chose, not the live flag a disconnect flips', () => {
    expect(startupRegion()).toMatch(/setDaemonModeActive\(daemonReady\.connected\);\s*daemonModeAtStartup = daemonReady\.connected;/);
  });

  it('opens the gate, then reruns the reconcile after the aborted pass settles', () => {
    const region = startupRegion();
    const finallyBody = region.slice(region.indexOf('} finally {'));
    const gateAt = finallyBody.indexOf("setPaneGate('ready');");
    const rerunAt = finallyBody.indexOf("lateReconcileRef.current?.rerun('startup reconcile failed')");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(rerunAt).toBeGreaterThan(gateAt);
    expect(finallyBody.slice(gateAt, rerunAt)).toMatch(/Promise\.resolve\(reconcileInFlightRef\.current\)/);
    expect(source).toMatch(/lateReconcileRef\.current = late;/);
  });

  it('a reconcile confirms every binding the daemon lists live', () => {
    const start = source.indexOf('const reconcilePtys = useCallback');
    const reconcile = source.slice(start, source.indexOf('// 앱 시작 시 세션 복원', start));
    const activeAt = reconcile.indexOf('const activeIds = new Set(');
    expect(activeAt).toBeGreaterThanOrEqual(0);
    expect(reconcile.slice(activeAt, activeAt + 400)).toMatch(/setPtysUnconfirmed\(activeIds, false\)/);
  });

  it('the restore-off path still clears, and invalidates creates in flight', () => {
    const region = startupRegion();
    const offAt = region.indexOf('if (!restoreEnabled) {');
    expect(offAt).toBeGreaterThanOrEqual(0);
    expect(region.slice(offAt, offAt + 400)).toMatch(/ptyLifecycle\.invalidateAll\(\);\s*clearAllPtyState\(\);/);
  });

  it('panes can ask for a pass; their requests are coalesced into one rerun', () => {
    const at = source.indexOf('setReconcileRequester((reason) => {');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = source.slice(at, at + 400);
    expect(body).toMatch(/if \(pendingRequest !== null\) return;/);
    expect(body).toMatch(/late\.rerun\(reason\);\s*\}, RECONCILE_REQUEST_COALESCE_MS\)/);
    expect(source).toMatch(/unregister\(\);/);
  });

  it('a rebind or clear drops the stale id’s unconfirmed mark', () => {
    expect(source).toMatch(/updateSurfacePtyId\(a\.paneId, a\.surfaceId, a\.newPtyId\);\s*(?:\/\/[^\n]*\n\s*)*useStore\.getState\(\)\.setPtysUnconfirmed\(\[a\.stalePtyId\], false\);/);
  });

  it('a completed pass unmarks every binding it looked at, so a gone one can clear (Codex P2)', () => {
    const start = source.indexOf('const reconcilePtys = useCallback');
    const reconcile = source.slice(start, source.indexOf('// 앱 시작 시 세션 복원', start));
    // Every bound surface the walk sees is recorded…
    expect(reconcile).toMatch(/examinedPtyIds\.push\(surface\.ptyId\);\s*if \(activeIds\.has\(surface\.ptyId\)\)/);
    // …and unmarked once the pass completes (not when it was aborted).
    const completeAt = reconcile.indexOf('Reconcile cycle #${reconcileCycleRef.current} complete');
    const unmarkAt = reconcile.search(/if \(!signal\?\.aborted\) \{\s*useStore\.getState\(\)\.setPtysUnconfirmed\(\s*examinedPtyIds/);
    expect(unmarkAt).toBeGreaterThan(reconcile.indexOf('resolveReconcileRebind('));
    expect(unmarkAt).toBeLessThan(completeAt);
  });

  it('a failed re-query leaves the absent bindings unconfirmed (Codex P1)', () => {
    const start = source.indexOf('const reconcilePtys = useCallback');
    const reconcile = source.slice(start, source.indexOf('// 앱 시작 시 세션 복원', start));
    const resolveAt = reconcile.indexOf('const toClear = await resolvePtyIdsToClear(firstAbsent');
    const keepAt = reconcile.indexOf('if (secondSnapshot === null) for (const id of firstAbsent) unsettledPtyIds.add(id);');
    expect(keepAt).toBeGreaterThan(resolveAt);
    expect(reconcile).toMatch(/setPtysUnconfirmed\(\s*examinedPtyIds\.filter\(\(id\) => !unsettledPtyIds\.has\(id\)\),\s*false,/);
  });

  it('the end of a pass confirms only marks made before it started (GLM P2)', () => {
    // A reattach that ran out while the pass awaited its RPCs marks its id
    // again; un-marking it here let that pane clear and self-create a second
    // shell beside a session whose id the pass never saw change.
    const start = source.indexOf('const reconcilePtys = useCallback');
    const reconcile = source.slice(start, source.indexOf('// 앱 시작 시 세션 복원', start));
    const seqAt = reconcile.indexOf('const markSeqAtStart = useStore.getState().ptyUnconfirmedSeq;');
    const listAt = reconcile.indexOf('window.electronAPI.pty.list({ includeDead: true })');
    expect(seqAt).toBeGreaterThan(-1);
    expect(seqAt).toBeLessThan(listAt);
    expect(reconcile).toMatch(/examinedPtyIds\.filter\(\(id\) => !unsettledPtyIds\.has\(id\)\),\s*false,\s*\{ markedAtOrBefore: markSeqAtStart \},/);
  });
});
