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
});
